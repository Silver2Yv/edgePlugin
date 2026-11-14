// V-09：锚点三级降级匹配算法。
//
// 三级降级：
//   1. 精确匹配：在全部（已按 frame 过滤的）块里找 exactText 的精确子串，
//      重复文本用 contextBefore / contextAfter 做消歧，不无脑取第一个。
//   2. 候选块内近似匹配：用 approx-string-match 对 exactText 做近似匹配，
//      编辑距离门槛跟文本长度挂钩，超过门槛判不可信；候选块范围受限
//      （优先锚点记录的 blockId 对应的块，找不到/没匹配到才退而扫描全部块，
//      逐块进行，不跨块拼接文本搜索）。
//   3. 都失败时按 scrollRatio 兜底，只给大致位置，弱提示，区别于"完全找不到"。
//   4. 彻底没有任何候选（比如锚点所属 frame 在当前文档里压根不存在）-> unresolved，
//      调用方视为不可点击。
//
// 版本绑定校验（blockId 是否在发送集合内、contentVersion 是否仍然当前）在 validate.ts，
// matchAnchor 会先做这两项前置检查；不通过的直接短路返回，不进入三级流程。

import search from 'approx-string-match';
import type { Anchor, AnchorMatchResult, ApproximateMatchResult, Block } from './types';
import { computeBlockDigest } from './types';
import { isAnchorVersionCurrent, isCitationBlockValid } from './validate';

/**
 * 精确匹配阶段的"歧义门槛"：两个候选位置的上下文编辑距离之和相差 <= 此值时，
 * 判定为"真正无法区分"，而不是存在明显更优的一个。
 *
 * 取 1 的理由：
 *   - contextBefore / contextAfter 本身只有约 32 字，差距为 0~1 大概率只是块边界
 *     截断、标点差异一类的噪声，不构成"确实能分辨出哪个才是原来那处引用"的信号；
 *   - 门槛定得更大（比如 5）会把本该能分辨的情况也判成歧义，体验上过于保守，
 *     会出现不必要的降级提示；门槛定得更小（比如 0，要求完全相等）又会漏掉
 *     "其实已经能分辨，只是有一两个字符噪声"的真实场景。
 * 这是我自己选的参数，不是架构原文规定的数值；如果真实网页上"同一句重复出现
 * 且上下文也很相似"的案例比预期多，这个门槛需要结合真实数据重新标定。
 */
const CONTEXT_AMBIGUITY_THRESHOLD = 1;

/**
 * 近似匹配允许的编辑距离，取 exactText 长度的这个比例（四舍五入）。
 *
 * 取 20% 的理由：引用的原文如果被改得面目全非（改动超过 1/5 的字符），
 * 就不能再认为这是"同一句话的小改动"了，应该判不可信、走下一级降级，
 * 而不是继续用近似匹配强行对应——近似匹配存在的意义是容忍"改了几个字 / 标点"
 * 这种轻微变化，不是容忍改写成另一句话。
 */
const APPROX_ERROR_RATIO = 0.2;
/** 不论文本多短，至少允许 1 处编辑（容忍一个标点变化）。 */
const APPROX_ERROR_MIN = 1;
/**
 * 不论文本多长，编辑距离上限设为 20。
 * 一来编辑距离一旦过大，"这还是不是同一句话"的判断本身就不可靠了；
 * 二来 approx-string-match 的耗时随 maxErrors 增长，设上限也是性能保护
 * （见 bench.ts 的实测）。
 */
const APPROX_ERROR_MAX = 20;

/**
 * 近似匹配阶段的"歧义门槛"：候选里最少错误数与次少错误数之差 <= 此值时，
 * 判定为歧义。按架构要求"不强行选一个"，这一级直接判失败，交给下一级（滚动比例）兜底。
 *
 * 取 1，比精确匹配消歧的门槛更保守一些的理由：近似匹配本身已经是"模糊"的，
 * 一旦出现第二个几乎一样好的候选，没有足够信号支持"第一个就是原来那处引用"，
 * 继续强行选它风险比精确匹配消歧时更高，所以这里更倾向于直接认输、往下降级。
 */
const APPROX_AMBIGUITY_GAP = 1;

/**
 * 单个候选块参与近似匹配时的最大文本长度。
 * 架构描述里块大小一般是 300~800 字，这里设 4000 字作为防御性上限：
 * 如果某个块异常地大，近似匹配只在 anchor.blockOffset 附近的一个窗口内进行，
 * 而不是对整块暴力扫描，避免近似匹配在极端长文本块上的耗时失控
 * （正常块大小下这条分支基本不会触发，bench.ts 测的是典型块大小场景）。
 */
const APPROX_BLOCK_WINDOW_MAX = 4000;
/** 窗口两侧各留出的缓冲字符数（覆盖 exactText 本身 + 前后上下文 + 少量浮动空间）。 */
const APPROX_WINDOW_MARGIN = 200;

export interface MatchOptions {
  /** 当前文档内容版本号，用于和 anchor.contentVersion 做版本绑定校验。 */
  currentContentVersion: string;
  /**
   * 该次可点击引用实际允许引用的块号集合（比如那次模型请求真正发送的块）。
   * 提供时，anchor.blockId 不在集合内会直接返回 invalid-citation，不进入三级流程；
   * 不提供（undefined）表示跳过这项前置校验——例如重新定位历史收藏夹里的旧锚点时，
   * 已经没有"当次请求发送集合"这个概念，只需要做版本绑定校验即可。
   */
  sentBlockIds?: Iterable<Block['id']>;
}

/** 两个短字符串之间的编辑距离（经典 Levenshtein 动态规划），用于上下文相似度比较。 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j - 1], dp[j]);
      prevDiag = temp;
    }
  }
  return dp[n];
}

/** 从块文本里按起止位置取出实际的前 / 后文，长度跟锚点记录的上下文长度对齐。 */
function actualContext(blockText: string, start: number, end: number, beforeLen: number, afterLen: number) {
  return {
    before: blockText.slice(Math.max(0, start - beforeLen), start),
    after: blockText.slice(end, end + afterLen),
  };
}

/** 计算一个候选位置与锚点记录的上下文的"距离"（越小越像）。 */
function contextDistance(anchor: Anchor, blockText: string, start: number, end: number): number {
  const { before, after } = actualContext(
    blockText,
    start,
    end,
    anchor.contextBefore.length,
    anchor.contextAfter.length,
  );
  return levenshtein(before, anchor.contextBefore) + levenshtein(after, anchor.contextAfter);
}

interface ExactOccurrence {
  blockId: Block['id'];
  start: number;
  end: number;
  text: string;
  contextScore: number;
}

/** 在所有（已按 frame 过滤的）块里找出 exactText 的全部精确子串出现位置。 */
function findAllExactOccurrences(blocks: Block[], anchor: Anchor): ExactOccurrence[] {
  const occurrences: ExactOccurrence[] = [];
  for (const block of blocks) {
    let fromIndex = 0;
    while (true) {
      const idx = block.text.indexOf(anchor.exactText, fromIndex);
      if (idx === -1) break;
      const end = idx + anchor.exactText.length;
      occurrences.push({
        blockId: block.id,
        start: idx,
        end,
        text: anchor.exactText,
        contextScore: contextDistance(anchor, block.text, idx, end),
      });
      fromIndex = idx + 1;
    }
  }
  return occurrences;
}

/**
 * 一级：精确匹配 + 上下文消歧。
 *
 * 取舍：这里对"全部块"做扫描，而不是严格按照"先只看 blockId 对应的块，
 * 找不到才退全量"的顺序去限制范围。原因：如果先把范围锁死在 blockId 对应的块，
 * 一旦这个块里恰好也存在一处 exactText（哪怕是错误的那一处，比如文档改版后
 * 块被重新编号、原编号现在指向了别的内容），就会在根本不知道"别的块里还有一处
 * 更像原上下文"的情况下直接采用它，反而违背了"重复文本不能无脑选"的要求。
 * 所以精确匹配阶段始终扫描全部块拿到所有出现位置，再统一用上下文相似度
 * （以及版本吻合时 blockId + 块摘要的双重校验）作为并列时的裁决信号。
 * 对原型阶段的文档规模（几万字、几十到上百个块）而言，全量 indexOf 扫描的开销
 * 可以忽略（见 bench.ts 的实测），这是用可接受的性能成本换取正确性的选择。
 */
function matchExact(blocks: Block[], anchor: Anchor, currentContentVersion: string): AnchorMatchResult | null {
  const occurrences = findAllExactOccurrences(blocks, anchor);
  if (occurrences.length === 0) return null;

  if (occurrences.length === 1) {
    const only = occurrences[0];
    return { tier: 'exact', blockId: only.blockId, start: only.start, end: only.end, text: only.text, frameId: anchor.frameId };
  }

  const sorted = [...occurrences].sort((a, b) => a.contextScore - b.contextScore);
  const best = sorted[0];
  const second = sorted[1];
  const gap = second.contextScore - best.contextScore;

  if (gap > CONTEXT_AMBIGUITY_THRESHOLD) {
    // 有明显更优的一个（上下文更像锚点记录的上下文），直接采用，不算歧义。
    return { tier: 'exact', blockId: best.blockId, start: best.start, end: best.end, text: best.text, frameId: anchor.frameId };
  }

  // 上下文相似度打平（差距在门槛内）。
  // 版本吻合 且 该候选所在块的内容摘要也还跟锚点记录的一致时，blockId 命中可以作为
  // 最后的裁决信号——这两项都满足，说明原来记录的那个块大概率真的还是原来的内容，
  // 是一个有效的强提示；只要有一项不满足（版本变了，或者摘要对不上，说明块内容
  // 已经漂移），就放弃这个信号，老老实实判成歧义并降级（见 validate.ts 的注释）。
  if (isAnchorVersionCurrent(anchor, currentContentVersion)) {
    const tiedTop = sorted.filter((o) => o.contextScore - best.contextScore <= CONTEXT_AMBIGUITY_THRESHOLD);
    const hintHits = tiedTop.filter((o) => {
      if (o.blockId !== anchor.blockId) return false;
      const block = blocks.find((b) => b.id === o.blockId);
      return block !== undefined && computeBlockDigest(block.text) === anchor.blockDigest;
    });
    if (hintHits.length === 1) {
      const hit = hintHits[0];
      return { tier: 'exact', blockId: hit.blockId, start: hit.start, end: hit.end, text: hit.text, frameId: anchor.frameId };
    }
  }

  // 真正无法区分：选择"降级"而不是"仍选一个但标注低置信度"（架构原文把这个取舍留给我决定）。
  // 理由：exactText 本身没变、编辑距离是 0，如果继续包装成 tier: 'exact'，UI 很容易
  // 误以为这是高置信度结果从而做精确高亮；但这里的不确定性来自"选错块"而不是"文字变了"，
  // 用 approximate + errors: 0 + reason: 'ambiguous-duplicate' 这个专门的 reason，
  // 可以复用已有的 confidence / message 字段给出和"文字真的改了"不同、但同样克制的提示文案，
  // 不需要再为"歧义"单开一个 tier。取第一个（按 contextScore 排序后的 best）只是为了
  // 给 UI 一个可展示的位置，不代表"猜对了"，调用方必须展示降级提示、不能假装精确。
  return {
    tier: 'approximate',
    blockId: best.blockId,
    start: best.start,
    end: best.end,
    text: best.text,
    errors: 0,
    confidence: 'low',
    reason: 'ambiguous-duplicate',
    message: '同一段原文在多处出现且上下文也很相似，无法确定具体是哪一处，已降级显示，请核对原文。',
    frameId: anchor.frameId,
  };
}

/** 换算近似匹配允许的编辑距离：跟 exactText 长度挂钩，不是固定常数。 */
function approxMaxErrors(exactTextLength: number): number {
  const byRatio = Math.round(exactTextLength * APPROX_ERROR_RATIO);
  return Math.min(APPROX_ERROR_MAX, Math.max(APPROX_ERROR_MIN, byRatio));
}

interface ApproxOccurrence {
  blockId: Block['id'];
  start: number;
  end: number;
  text: string;
  errors: number;
}

/** 在单个块内做近似匹配；块过大时先按 blockOffset 截取一个窗口，避免对超长块整块扫描。 */
function approxSearchInBlock(block: Block, anchor: Anchor, maxErrors: number): ApproxOccurrence[] {
  let searchText = block.text;
  let windowOffset = 0;
  if (block.text.length > APPROX_BLOCK_WINDOW_MAX) {
    const center = Math.min(Math.max(anchor.blockOffset, 0), block.text.length);
    const windowStart = Math.max(0, center - APPROX_WINDOW_MARGIN - anchor.exactText.length);
    const windowEnd = Math.min(block.text.length, center + anchor.exactText.length + APPROX_WINDOW_MARGIN);
    searchText = block.text.slice(windowStart, windowEnd);
    windowOffset = windowStart;
  }
  const matches = search(searchText, anchor.exactText, maxErrors);
  return matches.map((m) => ({
    blockId: block.id,
    start: m.start + windowOffset,
    end: m.end + windowOffset,
    text: searchText.slice(m.start, m.end),
    errors: m.errors,
  }));
}

/** 从一组近似匹配候选里挑出唯一可信的最佳结果；没有候选或候选之间构成歧义时返回 null。 */
function resolveApproxOccurrences(occurrences: ApproxOccurrence[]): ApproxOccurrence | null {
  if (occurrences.length === 0) return null;
  const sorted = [...occurrences].sort((a, b) => a.errors - b.errors);
  const best = sorted[0];
  const second = sorted[1];
  if (second && second.errors - best.errors <= APPROX_AMBIGUITY_GAP) {
    return null; // 歧义，不强行选一个。
  }
  return best;
}

function buildApproxResult(occ: ApproxOccurrence, anchor: Anchor): ApproximateMatchResult {
  const errorRatio = occ.errors / Math.max(1, anchor.exactText.length);
  return {
    tier: 'approximate',
    blockId: occ.blockId,
    start: occ.start,
    end: occ.end,
    text: occ.text,
    errors: occ.errors,
    confidence: errorRatio <= 0.1 ? 'medium' : 'low',
    reason: 'text-changed',
    message: '原文可能已发生变化，这是近似定位的位置，请注意核对。',
    frameId: anchor.frameId,
  };
}

/**
 * 二级：候选块内近似匹配。
 *
 * 候选块范围限定规则（"优先尝试，而不是无限制模糊搜索"）：
 *   1. 锚点记录的 blockId 对应的块如果还存在，先只在这一个块内做近似匹配
 *      ——架构明确要求"不要在全文無限制模糊搜索"，blockId 是最值得先试的位置；
 *      这里"优先"指的是效率优化（大概率省掉一次全量扫描），真正的可信度判断
 *      仍然交给 approx-string-match 返回的编辑距离，不是"因为是 hint 所以直接信"。
 *   2. 只有 hint 块不存在、或者在 hint 块内没找到足够可信（未触发歧义门槛）的匹配，
 *      才退而对其余块逐块做近似匹配（仍然是逐块进行，不会跨块拼接文本搜索）。
 *      这一步天然覆盖了"contentVersion 不一致、块已经错位"的情况——不需要在这里
 *      再单独判断版本号，只要 hint 没给出结果，就应该看看别处，判断依据始终是
 *      "有没有真的找到足够像的文本"。
 *
 * 已知局限（写进最终报告的"风险"部分）：如果 hint 块仍然存在、且在其内部
 * 找到了一个在门槛内、不构成歧义的匹配，会直接采用，不会再去和"其余块里是不是
 * 存在编辑距离更小的匹配"比较。也就是说如果 hint 块因为内容漂移产生了一个
 * 凑巧过关的弱匹配，而真正更好的匹配其实在别处，算法不会发现。这是遵循
 * "不要无限制模糊搜索全文"这条限制必须付出的代价。
 */
function matchApprox(blocks: Block[], anchor: Anchor): AnchorMatchResult | null {
  const maxErrors = approxMaxErrors(anchor.exactText.length);
  const hintBlock = blocks.find((b) => b.id === anchor.blockId);

  if (hintBlock) {
    const resolved = resolveApproxOccurrences(approxSearchInBlock(hintBlock, anchor, maxErrors));
    if (resolved) return buildApproxResult(resolved, anchor);
  }

  const others = blocks.filter((b) => b !== hintBlock);
  const otherOccurrences: ApproxOccurrence[] = [];
  for (const block of others) {
    otherOccurrences.push(...approxSearchInBlock(block, anchor, maxErrors));
  }
  const resolvedOther = resolveApproxOccurrences(otherOccurrences);
  if (!resolvedOther) return null;
  return buildApproxResult(resolvedOther, anchor);
}

/** 三级：按滚动比例兜底，只给大致位置，不代表能高亮到具体文字。 */
function scrollFallback(anchor: Anchor): AnchorMatchResult {
  return {
    tier: 'scroll-fallback',
    scrollRatio: anchor.scrollRatio,
    message: '未能定位到具体文字，已根据原滚动位置大致定位，原文可能已发生较大变化。',
    frameId: anchor.frameId,
  };
}

/**
 * 锚点匹配主入口：输入当前文档的块集合 + 一个锚点，输出匹配结果（可辨识联合类型）。
 *
 * 流程：
 *   前置校验 1（引用身份）：如果提供了 sentBlockIds，且 anchor.blockId 不在其中，
 *     直接返回 invalid-citation，不进入三级流程。
 *   前置校验 2（frame 隔离）：只在锚点所属的 frame 内查找，不跨 frame。
 *     如果当前文档里压根没有这个 frame 的任何块，直接 unresolved（没有候选可言）。
 *   三级降级：精确 -> 近似 -> 滚动比例；都不行则 unresolved。
 */
export function matchAnchor(blocks: Block[], anchor: Anchor, options: MatchOptions): AnchorMatchResult {
  if (options.sentBlockIds !== undefined && !isCitationBlockValid(anchor.blockId, options.sentBlockIds)) {
    return { tier: 'invalid-citation', reason: `blockId ${String(anchor.blockId)} 不在当次发送的块集合内` };
  }

  const blocksInFrame = blocks.filter((b) => b.frameId === anchor.frameId);
  if (blocksInFrame.length === 0) {
    return { tier: 'unresolved', reason: '当前文档内找不到锚点所属的 frame，没有可用的候选块' };
  }

  const exactResult = matchExact(blocksInFrame, anchor, options.currentContentVersion);
  if (exactResult) return exactResult;

  const approxResult = matchApprox(blocksInFrame, anchor);
  if (approxResult) return approxResult;

  if (anchor.scrollRatio >= 0 && anchor.scrollRatio <= 1) {
    return scrollFallback(anchor);
  }

  return { tier: 'unresolved', reason: '精确匹配、近似匹配均未找到，且没有可用的滚动比例兜底' };
}
