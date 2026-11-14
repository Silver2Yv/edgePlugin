// V-09 锚点结构与匹配结果类型定义。
//
// 架构约定（来自项目文档，这里不重新讨论设计动机，只落实为类型）：
//   锚点 = 精确文本 + 前后各约 32 字上下文 + 块文本摘要 + 章节标题链 + 页内滚动比例 + 块内偏移，
//   锚点随消息 / 收藏保存，不依赖块编号本身做持久标识；
//   引用身份用 contextSnapshotId + contentVersion + blockId 一起校验。

/** 页面上的一个"块"（段落 / 章节片段等渲染单元）。 */
export interface Block {
  /** 块编号。只在生成该编号的那一次渲染 / 请求内有效，不能当作跨版本的持久标识使用。 */
  id: string | number;
  /** 块全文。 */
  text: string;
  /** 该块所属的章节标题链，从顶层到当前，例如 ["第一章 概述", "1.2 背景"]。 */
  headingChain: string[];
  /** 该块在整页内的滚动比例，0~1，用于三级降级的最后一级定位。 */
  scrollRatio: number;
  /**
   * 该块所属的 frame 标识（多 iframe / frame 场景）。
   * 不传表示默认主文档 frame。匹配时必须先按 frameId 过滤，禁止跨 frame 定位
   * ——即使两个 frame 里出现一模一样的文字，也不能互相当作候选。
   */
  frameId?: string;
}

/**
 * 锚点：引用被保存（随消息 / 收藏）时固化下来的定位信息，用于之后"跳回原文"。
 * 不能依赖块编号持久化定位——同一个编号在下一轮渲染里可能对应到完全不同的内容，
 * 所以锚点同时保存了可用于纯文本重新定位的信息（exactText / 上下文 / 摘要），
 * blockId 只作为"优先尝试"的提示和版本绑定校验的一部分，不是唯一的定位依据。
 */
export interface Anchor {
  /** 精确文本片段（被引用的那一小段原文，通常是一句或半句）。 */
  exactText: string;
  /** exactText 之前约 32 字的上下文，用于消歧与近似匹配定位。 */
  contextBefore: string;
  /** exactText 之后约 32 字的上下文。 */
  contextAfter: string;
  /**
   * 块文本摘要。这里取"块文本前 BLOCK_DIGEST_LENGTH 字"作为摘要（见 computeBlockDigest），
   * 不是语义摘要——目的只是用很低的成本判断"当前这个块的内容还是不是原来那块"，
   * 不追求摘要本身的唯一性或可读性。
   */
  blockDigest: string;
  /** 锚点创建时该块所属的章节标题链。 */
  headingChain: string[];
  /** 锚点创建时该块的页内滚动比例，三级降级兜底使用。 */
  scrollRatio: number;
  /** exactText 在块文本内的起始字符偏移（创建锚点时记录）。仅作参考信号，不作为主匹配依据。 */
  blockOffset: number;
  /** 锚点创建时 exactText 所在的块编号。仅在版本未变、内容摘要也吻合时可作为"优先候选"的提示。 */
  blockId: Block['id'];
  /** 锚点创建时的文档内容版本号。用于版本绑定校验：版本变化后不可盲目信任 blockId。 */
  contentVersion: string;
  /** 锚点创建时那次请求 / 渲染的快照 id（配合 contentVersion + blockId 构成引用身份）。 */
  contextSnapshotId: string;
  /** 锚点所属 frame（多 iframe 场景下用于隔离，不传表示主文档）。 */
  frameId?: string;
}

/** 块摘要取前多少个字符。理由见 computeBlockDigest 注释。 */
export const BLOCK_DIGEST_LENGTH = 40;

/**
 * 计算块摘要：取块文本前 BLOCK_DIGEST_LENGTH 个字符。
 * 取"前 N 字"而不是做语义摘要或哈希的理由：
 *   - 这里只需要一个"内容是否还是原来那块"的快速信号，不需要摘要本身有可读性；
 *   - 前 N 字对"块被整体替换/挪动"这种情况足够敏感（开头变了，摘要大概率就变了），
 *     计算成本几乎为零，不需要引入额外的哈希或分词依赖；
 *   - 代价是对"只改了块中间或末尾内容"不敏感——这是本原型阶段接受的简化，
 *     真实场景如果发现这类误判较多，可以换成内容哈希或多段抽样摘要。
 */
export function computeBlockDigest(text: string): string {
  return text.slice(0, BLOCK_DIGEST_LENGTH);
}

// ------- 匹配结果：可辨识联合类型 -------

interface MatchResultBase {
  /** 命中结果所在的 frame（与 anchor.frameId 一致），供 UI 做作用域校验 / 高亮定位。 */
  frameId?: string;
}

/** 一级：精确匹配成功。可以精确高亮，不需要任何降级提示。 */
export interface ExactMatchResult extends MatchResultBase {
  tier: 'exact';
  blockId: Block['id'];
  /** 命中文本在目标块 text 内的起始 / 结束字符偏移（左闭右开）。 */
  start: number;
  end: number;
  /** 实际命中的文本（等于 anchor.exactText）。 */
  text: string;
}

/**
 * 二级：近似匹配。
 * 也用来承载"精确文本本身没变、但重复出现在多处且上下文也无法真正区分"的降级结果
 * （reason: 'ambiguous-duplicate'，见 match.ts 里 matchExact 的说明）——
 * 这种情况编辑距离是 0，但"选哪一处"本身不确定，不能包装成 tier: 'exact'，
 * 否则 UI 会误以为这是可以放心精确高亮的结果。
 * 不管哪种 reason，调用方都不能把这当成"精确命中"，必须展示降级提示。
 */
export interface ApproximateMatchResult extends MatchResultBase {
  tier: 'approximate';
  blockId: Block['id'];
  start: number;
  end: number;
  /** 实际命中的文本（可能与 exactText 有少量字符差异）。 */
  text: string;
  /** 与 exactText 的编辑距离（字符插入 / 删除 / 替换次数）。歧义降级场景下固定为 0。 */
  errors: number;
  /** 置信度，供 UI 决定提示语气的强弱。 */
  confidence: 'medium' | 'low';
  /** 降级原因，用于生成不同的提示文案。 */
  reason: 'text-changed' | 'ambiguous-duplicate';
  /** 面向用户的降级提示文案，比如"原文可能已变化"。 */
  message: string;
}

/**
 * 三级：仅按滚动比例兜底定位。没有任何具体文字可高亮，只能把页面 / frame 滚动到大致位置。
 *
 * 取舍：单独列一个 tier，而不是合并进 ApproximateMatchResult——
 * 因为它在语义上"弱一级"：没有 start / end / errors 这些文字层面的信息。
 * 如果塞进 ApproximateMatchResult，这些字段要么变成没有意义的可选字段（污染类型，
 * 调用方还得额外判断"这次到底有没有 start"），要么只能用假值占位，两种都不好。
 * 单列类型可以让调用方用 switch(result.tier) 清晰分出两种完全不同的呈现方式：
 * "可高亮的弱匹配"（approximate）和"只能滚动、无法高亮任何文字"（scroll-fallback）。
 */
export interface ScrollFallbackMatchResult extends MatchResultBase {
  tier: 'scroll-fallback';
  /** 兜底使用的滚动比例，取自锚点保存时记录的 scrollRatio。 */
  scrollRatio: number;
  message: string;
}

/** 彻底无法定位，调用方必须将对应引用渲染为不可点击。 */
export interface UnresolvedMatchResult {
  tier: 'unresolved';
  reason: string;
}

/**
 * 引用编号本身不合法：不在该次请求实际发送的块集合内
 * （模型编造的编号，或者引用在身份校验这一步就没通过）。
 * 与 unresolved 区分开，是因为这是"引用身份校验"失败，根本不会进入三级降级流程；
 * 调用方可以据此给出不同的提示（比如直接提示"引用编号无效"，而不是"原文可能已变化"）。
 */
export interface InvalidCitationMatchResult {
  tier: 'invalid-citation';
  reason: string;
}

export type AnchorMatchResult =
  | ExactMatchResult
  | ApproximateMatchResult
  | ScrollFallbackMatchResult
  | UnresolvedMatchResult
  | InvalidCitationMatchResult;
