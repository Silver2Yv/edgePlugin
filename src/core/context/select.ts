// 页面上下文的块选择（5.6、5.9、D4）：只决定「发哪些块」，不管提示词格式（格式与 token 成本由调用方给）。
// nearby：以选区所在块为中心，前后各取若干上下文单元（标题不计数、但夹在中间的照带）；
// fullPage：放得下就全发；放不下以选区为中心向外扩展，没有选区就从头截取。
// 所有取舍都在 maxTokens 内完成，结果（含是否截断）照实进发送计划（规则 8）。
import type { BlockId } from '../domain/ids';

/** 「前后各 3 段」的默认段数（5.6 上下文单元） */
export const NEARBY_UNITS = 3;

export interface PickBlock {
  id: BlockId;
  kind: string;
}

export interface PickInput<B extends PickBlock> {
  blocks: readonly B[];
  tier: 'nearby' | 'fullPage';
  /** 选区所在块；为空表示没有选区或没找到 */
  centerIds: readonly BlockId[];
  /** 页面内容可用的 token 数 */
  maxTokens: number;
  /** 一个块按实际发送格式的 token 成本 */
  cost: (b: B) => number;
  nearbyUnits?: number;
}

/**
 * mode：all 全文；nearby 选区前后；centered 全文放不下、以选区为中心截取；
 * head 从开头截取（全文放不下且没有选区，或 nearby 没有选区时附带开头几段）；none 一块都没发
 */
export type PickMode = 'all' | 'nearby' | 'centered' | 'head' | 'none';

export interface PickResult<B> {
  /** 按文档顺序 */
  blocks: B[];
  /** 按档位本该发的块因预算没发全 */
  truncated: boolean;
  mode: PickMode;
}

const isUnit = (b: PickBlock) => b.kind !== 'heading';

/** 从 [lo, hi] 往两侧各数 n 个上下文单元，返回扩展后的区间 */
function widen(blocks: readonly PickBlock[], lo: number, hi: number, n: number): [number, number] {
  let a = lo;
  for (let units = 0, i = lo - 1; i >= 0 && units < n; i--) {
    a = i;
    if (isUnit(blocks[i] as PickBlock)) units++;
  }
  let b = hi;
  for (let units = 0, i = hi + 1; i < blocks.length && units < n; i++) {
    b = i;
    if (isUnit(blocks[i] as PickBlock)) units++;
  }
  return [a, b];
}

export function pickPageBlocks<B extends PickBlock>(input: PickInput<B>): PickResult<B> {
  const { blocks, tier, maxTokens, cost } = input;
  const n = input.nearbyUnits ?? NEARBY_UNITS;
  const costs = blocks.map(cost);
  const sum = (a: number, b: number) => {
    let t = 0;
    for (let i = a; i <= b; i++) t += costs[i] ?? 0;
    return t;
  };
  const slice = (a: number, b: number) => blocks.slice(a, b + 1);
  if (blocks.length === 0 || maxTokens <= 0)
    return { blocks: [], truncated: blocks.length > 0, mode: 'none' };

  const wanted = new Set(input.centerIds);
  const centers = blocks.flatMap((b, i) => (wanted.has(b.id) ? [i] : []));
  const last = blocks.length - 1;

  if (tier === 'fullPage' && sum(0, last) <= maxTokens)
    return { blocks: [...blocks], truncated: false, mode: 'all' };

  // 没有选区：从头截取（fullPage 按预算；nearby 只带开头 2n+1 个单元）
  if (centers.length === 0) {
    let end = tier === 'nearby' ? widen(blocks, 0, 0, 2 * n)[1] : last;
    const wantedEnd = end;
    let used = 0;
    let fit = -1;
    for (let i = 0; i <= end && used + (costs[i] ?? 0) <= maxTokens; i++) {
      used += costs[i] ?? 0;
      fit = i;
    }
    end = fit;
    return {
      blocks: end >= 0 ? slice(0, end) : [],
      truncated: end < wantedEnd,
      mode: end >= 0 ? 'head' : 'none',
    };
  }

  // 中心本身放不下：从中心第一块起，能放几块放几块
  let lo = centers[0] as number;
  let hi = centers[centers.length - 1] as number;
  if (sum(lo, hi) > maxTokens) {
    let used = 0;
    let end = lo - 1;
    while (end < hi && used + (costs[end + 1] ?? 0) <= maxTokens) used += costs[++end] ?? 0;
    if (end < lo) return { blocks: [], truncated: true, mode: 'none' };
    return { blocks: slice(lo, end), truncated: true, mode: tier === 'nearby' ? 'nearby' : 'centered' };
  }

  if (tier === 'nearby') {
    let [a, b] = widen(blocks, lo, hi, n);
    const full: [number, number] = [a, b];
    // 超预算：先去掉离中心更远的一侧
    while (sum(a, b) > maxTokens) {
      if (hi - b === 0 && a === lo) break;
      if (lo - a >= b - hi && a < lo) a++;
      else b--;
    }
    return { blocks: slice(a, b), truncated: a !== full[0] || b !== full[1], mode: 'nearby' };
  }

  // fullPage 放不下：以选区为中心交替向两侧扩展，一侧放不下就停那一侧（保持连续）
  let used = sum(lo, hi);
  let canBefore = true;
  let canAfter = true;
  while (canBefore || canAfter) {
    if (canAfter) {
      const c = costs[hi + 1];
      if (c !== undefined && used + c <= maxTokens) {
        hi++;
        used += c;
      } else canAfter = false;
    }
    if (canBefore) {
      const c = costs[lo - 1];
      if (c !== undefined && used + c <= maxTokens) {
        lo--;
        used += c;
      } else canBefore = false;
    }
  }
  return { blocks: slice(lo, hi), truncated: true, mode: 'centered' };
}
