// 引用与锚点（5.7）。锚点随消息与收藏保存，不依赖块编号；匹配与降级在 V-09 定稿后实现。
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
  | { level: 'fuzzy'; blockId: BlockId; start: number; end: number; score: number }
  | { level: 'scroll'; scrollRatio: number }
  | { level: 'none' };

/** 桩：V-09 定稿后实现 */
export function matchAnchor(_anchor: Anchor, _blocks: readonly { id: BlockId; text: string }[]): AnchorMatch {
  return { level: 'none' };
}
