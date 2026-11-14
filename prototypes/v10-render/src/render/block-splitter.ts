/**
 * 把一次完整解析的 token 流切成"顶层块"分组（5.10："不做任意嵌套的增量解析"
 * ——每个顶层块整体渲染，不拆到块内部做增量）。
 *
 * 块身份（稳定 key）用该块在文档中的起始字符偏移。纯追加式流式输入下，
 * 已产出的早期文本不会再变化，所以同一块的起始偏移在后续更新里保持不变；
 * 这是"已完成的块用稳定 key 保留"的基础。
 */
import type { MarkdownIt as MarkdownItInstance, Token } from 'markdown-it';

export interface BlockGroup {
  key: number; // 起始字符偏移，作为稳定 key
  tokenStart: number;
  tokenEnd: number; // 闭区间
  charStart: number;
  charEnd: number; // 开区间（不含）
}

/** 对齐 markdown-it 内部 normalize 规则：统一换行、替换 NUL 字符、去 BOM。 */
export function normalizeForMarkdownIt(src: string): string {
  let s = src;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n?|\n/g, '\n');
  s = s.replace(/\0/g, '�');
  return s;
}

export function computeLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

export function splitTopLevelBlocks(md: MarkdownItInstance, normalizedText: string): { tokens: Token[]; groups: BlockGroup[] } {
  const env: Record<string, unknown> = {};
  const tokens = md.parse(normalizedText, env);
  const lineOffsets = computeLineOffsets(normalizedText);
  const toCharStart = (line: number): number => lineOffsets[line] ?? normalizedText.length;
  const toCharEndExclusive = (line: number): number => (line < lineOffsets.length ? lineOffsets[line] : normalizedText.length);

  const groups: BlockGroup[] = [];
  let depth = 0;
  let groupStart = -1;
  let minLine = Infinity;
  let maxLine = -Infinity;

  const flush = (tokenEnd: number): void => {
    if (groupStart === -1) return;
    groups.push({
      key: toCharStart(minLine),
      tokenStart: groupStart,
      tokenEnd,
      charStart: toCharStart(minLine),
      charEnd: toCharEndExclusive(maxLine)
    });
    groupStart = -1;
    minLine = Infinity;
    maxLine = -Infinity;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (depth === 0) {
      if (groupStart === -1) groupStart = i;
      if (token.map) {
        minLine = Math.min(minLine, token.map[0]);
        maxLine = Math.max(maxLine, token.map[1]);
      }
    } else if (token.map) {
      // 嵌套层内的 map 也纳入范围计算，兜底某些容器 token 不带完整 map 的情况
      maxLine = Math.max(maxLine, token.map[1]);
    }

    if (token.nesting === 1) {
      depth++;
    } else if (token.nesting === -1) {
      depth--;
      if (depth === 0) flush(i);
    } else if (depth === 0) {
      flush(i);
    }
  }
  flush(tokens.length - 1);

  return { tokens, groups };
}
