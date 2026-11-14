// 测试辅助函数：从一个真实存在的 Block + 其中一段 exactText，
// 构造出字段齐全、且各字段都真实对应该块内容的 Anchor。
// 放在 test/ 目录而不是 src/，因为这只是测试数据构造工具，不是产品代码的一部分。

import type { Anchor, Block } from '../src/types';
import { computeBlockDigest } from '../src/types';

/** 和锚点创建时实际使用的上下文长度保持一致（约 32 字）。 */
export const CONTEXT_LEN = 32;

export function buildAnchor(block: Block, exactText: string, overrides: Partial<Anchor> = {}): Anchor {
  const offset = block.text.indexOf(exactText);
  if (offset === -1) {
    throw new Error(`测试构造错误：exactText "${exactText}" 不在给定块文本内`);
  }
  const end = offset + exactText.length;
  const base: Anchor = {
    exactText,
    contextBefore: block.text.slice(Math.max(0, offset - CONTEXT_LEN), offset),
    contextAfter: block.text.slice(end, end + CONTEXT_LEN),
    blockDigest: computeBlockDigest(block.text),
    headingChain: block.headingChain,
    scrollRatio: block.scrollRatio,
    blockOffset: offset,
    blockId: block.id,
    contentVersion: 'v1',
    contextSnapshotId: 'snap-1',
    frameId: block.frameId,
  };
  return { ...base, ...overrides };
}
