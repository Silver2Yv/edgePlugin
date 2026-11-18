// 引用条预览（B2）：conv/quote 只带选中文字的前 2000 字
import type { BackgroundToClient } from '@/core/domain/messages';
import type { StoredSelection } from './store';

export const QUOTE_PREVIEW_CHARS = 2000;

export function quoteOf(sel: StoredSelection): Extract<BackgroundToClient, { type: 'conv/quote' }> {
  const chars = [...sel.text];
  const cut = chars.length > QUOTE_PREVIEW_CHARS;
  return {
    type: 'conv/quote',
    selectionRevision: sel.selectionRevision,
    text: cut ? chars.slice(0, QUOTE_PREVIEW_CHARS).join('') : sel.text,
    // 预览被截短，或原文本来就超过 48 KB 被截断
    truncated: cut || sel.truncated,
    originalLength: sel.originalLength,
  };
}
