/**
 * 把一段完整文本切成多种 chunk 边界，用于流式重放测试（V-10 步骤：
 * "每个样本按不同 chunk 边界输入"）。
 */

/** 逐字符（逐 UTF-16 code unit）。 */
export function splitByChar(text: string): string[] {
  return Array.from(text).length === text.length ? text.split('') : Array.from({ length: text.length }, (_, i) => text[i]);
}

/** 固定种子的伪随机切分，每段 1~maxLen 个 code unit，可能切在多字节字符中间。 */
export function splitRandom(text: string, seed: number, maxLen = 7): string[] {
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const len = 1 + Math.floor(rand() * maxLen);
    chunks.push(text.slice(i, i + len));
    i += len;
  }
  return chunks;
}

/**
 * 故意把 chunk 边界切在：多字节字符中间（UTF-16 代理对 / 组合表情）、
 * 以及引用标记 "【" "】" 字符中间（通过逐 UTF-16 code unit 切分即可同时
 * 覆盖两者——"【" 本身是单个 code unit，但紧跟在它前后的位置就是我们要
 * 测的"标记被截断"场景；真正的多字节代理对见 splitByChar 对 emoji 的处理）。
 */
export function splitAtMarkerBoundaries(text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const markerIdx = text.indexOf('【', i);
    if (markerIdx === -1) {
      chunks.push(text.slice(i));
      break;
    }
    // 切在 "【" 字符内部的前一个 code unit 之后、自身之后各切一次，
    // 制造"标记起始符单独成一个 chunk 末尾"与"标记起始符落在下一个 chunk 开头"两种情况。
    const cut = Math.min(markerIdx + 1, text.length);
    chunks.push(text.slice(i, cut));
    i = cut;
  }
  return chunks.filter((c) => c.length > 0);
}

export interface ChunkStrategy {
  name: string;
  split: (text: string) => string[];
}

export const CHUNK_STRATEGIES: ChunkStrategy[] = [
  { name: 'char-by-char', split: splitByChar },
  { name: 'random-seed-1', split: (t) => splitRandom(t, 1) },
  { name: 'random-seed-2', split: (t) => splitRandom(t, 2, 13) },
  { name: 'marker-boundary', split: splitAtMarkerBoundaries }
];
