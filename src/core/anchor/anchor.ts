// 引用与锚点（5.7）。锚点随消息与收藏保存，不依赖块编号；匹配按 V-09 原型（prototypes/v09-citation/anchor）
// 验证过的三级降级：精确 → 候选块内近似 → 按滚动比例。重复文本不取第一个，判不出就降级。
// core 不引第三方包，所以近似匹配用自带的有界编辑距离（Sellers），只在候选块里做，不全文无界搜索。

import { blockDigest } from '../context/content-version';
import { truncateByJsonBytes } from '../domain/bytes';
import type { BlockId, ContentVersion, ContextSnapshotId } from '../domain/ids';

/** 引用身份：编号只在那一次请求发送的块集合里有效 */
export interface CitationRef {
  contextSnapshotId: ContextSnapshotId;
  contentVersion: ContentVersion;
  blockId: BlockId;
}

export interface Anchor {
  /** 精确文本 */
  exact: string;
  /** 前后各约 32 字 */
  prefix: string;
  suffix: string;
  /** 块文本摘要（哈希） */
  blockDigest: string;
  headingPath: readonly string[];
  /** 页内滚动比例 0–1 */
  scrollRatio: number;
  /** 块内字符偏移 */
  offsetInBlock: number;
}

export const ANCHOR_CONTEXT_CHARS = 32;

/** 三级降级的结果；none 时不可点击 */
export type AnchorMatch =
  | { level: 'exact'; blockId: BlockId; start: number; end: number }
  /** score = 1 − 编辑距离 / 原文长度；0 表示原文没变但重复出现、上下文也分不出是哪一处（位置不确定） */
  | { level: 'fuzzy'; blockId: BlockId; start: number; end: number; score: number }
  | { level: 'scroll'; scrollRatio: number }
  | { level: 'none' };

/** 锚点里各字段的字节上限与 messages.ts 的 anchorSchema 一致 */
const EXACT_MAX_BYTES = 12 * 1024;
const HEADING_MAX_CHARS = 300;

/** 在块文本 [start, end) 上建锚点。exact 超过 12 KB 时截断（定位只需要开头一段） */
export function makeAnchor(
  block: { text: string; headingPath: readonly string[] },
  start: number,
  end: number,
  scrollRatio: number,
): Anchor {
  const s = Math.max(0, Math.min(start, block.text.length));
  const e = Math.max(s, Math.min(end, block.text.length));
  return {
    exact: truncateByJsonBytes(block.text.slice(s, e), EXACT_MAX_BYTES).text,
    prefix: block.text.slice(Math.max(0, s - ANCHOR_CONTEXT_CHARS), s),
    suffix: block.text.slice(e, e + ANCHOR_CONTEXT_CHARS),
    blockDigest: blockDigest(block.text),
    headingPath: block.headingPath.slice(-12).map((h) => h.slice(0, HEADING_MAX_CHARS)),
    scrollRatio: Number.isFinite(scrollRatio) ? Math.min(1, Math.max(0, scrollRatio)) : 0,
    offsetInBlock: s,
  };
}

// ───────────── 匹配 ─────────────

/** 精确匹配的歧义门槛：两处上下文距离之差不超过它就算分不出（V-09 取值） */
const CONTEXT_AMBIGUITY = 1;
/** 近似匹配允许的编辑距离：原文长度的 20%，至少 1、至多 20（V-09 取值） */
const APPROX_RATIO = 0.2;
const APPROX_MIN = 1;
const APPROX_MAX = 20;
/** 近似匹配里最好与次好之差不超过它就算歧义，不强行选 */
const APPROX_AMBIGUITY = 1;
/** 参与近似匹配的原文最多取这么长；超长块只在锚点偏移附近开窗口 */
const APPROX_PATTERN_MAX = 256;
const APPROX_BLOCK_WINDOW = 4000;
const APPROX_WINDOW_MARGIN = 200;
/**
 * 候选块预筛（鸽笼原理）：把原文切成 maxErrors + 1 段，编辑距离不超过 maxErrors 的出现位置里至少有一段原样保留，
 * 所以块里一段都找不到的不可能命中，跳过不做近似匹配
 */
function pigeonholePieces(pattern: string, maxErrors: number): string[] {
  const n = maxErrors + 1;
  const size = Math.max(1, Math.floor(pattern.length / n));
  return Array.from({ length: n }, (_, i) =>
    pattern.slice(i * size, i === n - 1 ? pattern.length : (i + 1) * size),
  ).filter((p) => p !== '');
}

type MatchBlock = { id: BlockId; text: string };

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

function contextDistance(anchor: Anchor, text: string, start: number, end: number): number {
  const before = text.slice(Math.max(0, start - anchor.prefix.length), start);
  const after = text.slice(end, end + anchor.suffix.length);
  return levenshtein(before, anchor.prefix) + levenshtein(after, anchor.suffix);
}

function matchExact(anchor: Anchor, blocks: readonly MatchBlock[]): AnchorMatch | undefined {
  const hits: { blockId: BlockId; start: number; end: number; ctx: number; hint: boolean }[] = [];
  for (const b of blocks) {
    let hint: boolean | undefined;
    for (let i = b.text.indexOf(anchor.exact); i >= 0; i = b.text.indexOf(anchor.exact, i + 1)) {
      const end = i + anchor.exact.length;
      hint ??= blockDigest(b.text) === anchor.blockDigest;
      hits.push({ blockId: b.id, start: i, end, ctx: contextDistance(anchor, b.text, i, end), hint });
    }
  }
  if (hits.length === 0) return undefined;
  hits.sort((x, y) => x.ctx - y.ctx);
  const [best, second] = hits as [(typeof hits)[number], (typeof hits)[number] | undefined];
  if (!second || second.ctx - best.ctx > CONTEXT_AMBIGUITY) {
    return { level: 'exact', blockId: best.blockId, start: best.start, end: best.end };
  }
  // 上下文打平：只有「块内容没变（摘要相同）且偏移也对得上」的那一处能当裁决信号
  const tied = hits.filter((h) => h.ctx - best.ctx <= CONTEXT_AMBIGUITY);
  const hinted = tied.filter((h) => h.hint && h.start === anchor.offsetInBlock);
  if (hinted.length === 1) {
    const h = hinted[0] as (typeof hits)[number];
    return { level: 'exact', blockId: h.blockId, start: h.start, end: h.end };
  }
  return { level: 'fuzzy', blockId: best.blockId, start: best.start, end: best.end, score: 0 };
}

/**
 * Sellers 近似子串匹配：返回所有「局部最好」的结束位置与编辑距离（≤ maxErrors）。
 * 起点由反向再跑一次求出。text、pattern 都已限长，最坏 4000 × 256 次运算
 */
function approxEnds(text: string, pattern: string, maxErrors: number): { end: number; errors: number }[] {
  const m = pattern.length;
  let col = Array.from({ length: m + 1 }, (_, i) => i);
  const out: { end: number; errors: number }[] = [];
  // 连续一段都在门槛内的结束位置属于同一处匹配，只留其中最好的一个
  let inRun = false;
  for (let j = 1; j <= text.length; j++) {
    const next = [0];
    for (let i = 1; i <= m; i++) {
      next[i] = Math.min(
        (col[i] ?? 0) + 1,
        (next[i - 1] ?? 0) + 1,
        (col[i - 1] ?? 0) + (pattern[i - 1] === text[j - 1] ? 0 : 1),
      );
    }
    col = next;
    const err = col[m] ?? m;
    if (err > maxErrors) {
      inRun = false;
      continue;
    }
    const last = out.at(-1);
    if (inRun && last) {
      if (err < last.errors) out[out.length - 1] = { end: j, errors: err };
    } else {
      out.push({ end: j, errors: err });
      inRun = true;
    }
  }
  return out;
}

function approxStart(text: string, pattern: string, end: number, maxErrors: number): number {
  const from = Math.max(0, end - pattern.length - maxErrors);
  const rev = [...text.slice(from, end)].reverse().join('');
  const revPattern = [...pattern].reverse().join('');
  let best = { end: 0, errors: Number.POSITIVE_INFINITY };
  for (const h of approxEnds(rev, revPattern, maxErrors)) if (h.errors < best.errors) best = h;
  return best.errors === Number.POSITIVE_INFINITY ? Math.max(0, end - pattern.length) : end - best.end;
}

function matchApprox(anchor: Anchor, blocks: readonly MatchBlock[]): AnchorMatch | undefined {
  const pattern = anchor.exact.slice(0, APPROX_PATTERN_MAX);
  if (pattern.length < 2) return undefined;
  const maxErrors = Math.min(APPROX_MAX, Math.max(APPROX_MIN, Math.round(pattern.length * APPROX_RATIO)));
  const probes = pigeonholePieces(pattern, maxErrors);
  const found: { blockId: BlockId; start: number; end: number; errors: number }[] = [];
  for (const b of blocks) {
    const hinted = blockDigest(b.text) === anchor.blockDigest;
    if (!hinted && !probes.some((p) => b.text.includes(p))) continue;
    let text = b.text;
    let offset = 0;
    if (text.length > APPROX_BLOCK_WINDOW) {
      offset = Math.max(0, anchor.offsetInBlock - APPROX_WINDOW_MARGIN - pattern.length);
      text = text.slice(offset, anchor.offsetInBlock + pattern.length + APPROX_WINDOW_MARGIN);
    }
    for (const h of approxEnds(text, pattern, maxErrors)) {
      const start = approxStart(text, pattern, h.end, maxErrors);
      found.push({ blockId: b.id, start: start + offset, end: h.end + offset, errors: h.errors });
    }
  }
  if (found.length === 0) return undefined;
  found.sort((x, y) => x.errors - y.errors);
  const [best, second] = found as [(typeof found)[number], (typeof found)[number] | undefined];
  if (second && second.errors - best.errors <= APPROX_AMBIGUITY) return undefined;
  // 原文比参与匹配的部分长时，按原文长度延伸结束位置（不超过块尾）
  const text = blocks.find((b) => b.id === best.blockId)?.text ?? '';
  const end = Math.min(text.length, Math.max(best.end, best.start + anchor.exact.length));
  return {
    level: 'fuzzy',
    blockId: best.blockId,
    start: best.start,
    end,
    score: 1 - best.errors / pattern.length,
  };
}

/** 三级降级：精确（重复文本用上下文消歧）→ 候选块内近似 → 滚动比例；没有任何块时 none */
export function matchAnchor(anchor: Anchor, blocks: readonly MatchBlock[]): AnchorMatch {
  if (blocks.length === 0 || anchor.exact === '') return { level: 'none' };
  return (
    matchExact(anchor, blocks) ??
    matchApprox(anchor, blocks) ?? { level: 'scroll', scrollRatio: anchor.scrollRatio }
  );
}
