// 引用条预览（B2）：conv/quote 只带选中文字的前 2000 字
import type { BackgroundToClient } from '@/core/domain/messages';
import type { StoredSelection } from './store';

export const QUOTE_PREVIEW_CHARS = 2000;

/** 按预览长度截断；truncated 为真表示预览被截短，或原文本来就超过字段上限被截断 */
function previewOf(sel: StoredSelection): { text: string; truncated: boolean; originalLength: number } {
  const chars = [...sel.text];
  const cut = chars.length > QUOTE_PREVIEW_CHARS;
  return {
    text: cut ? chars.slice(0, QUOTE_PREVIEW_CHARS).join('') : sel.text,
    truncated: cut || sel.truncated,
    originalLength: sel.originalLength,
  };
}

export function quoteOf(sel: StoredSelection): Extract<BackgroundToClient, { type: 'conv/quote' }> {
  return { type: 'conv/quote', selectionRevision: sel.selectionRevision, ...previewOf(sel) };
}

/**
 * contract-v1.5 增量（live）：conv/current 带给其他订阅者的引用摘要（同一截断口径），
 * 没有选区（页面类动作）时不带这个字段
 */
export function quotePreviewOf(
  sel: StoredSelection | undefined,
): { text: string; truncated: boolean; originalLength: number } | undefined {
  return sel ? previewOf(sel) : undefined;
}
