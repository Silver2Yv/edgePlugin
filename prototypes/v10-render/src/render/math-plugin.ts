/**
 * 极简公式语法插件：块级 `$$ ... $$`（独占一行的起止分隔符，仿 markdown-it 内置
 * fence 规则的"未闭合时读到文档末尾"处理）与行内 `$ ... $`。
 *
 * 范围说明（原型取舍，写入 RESULT.md）：架构只规定"公式"用 KaTeX 渲染、按需加载，
 * 未规定具体定界符语法；本原型选用业界常见的 $$ 块级 / $ 行内写法，不是
 * texmath/mathjax 配置的完整复刻。真实实现若需要 \[ \] 、\( \) 等更多写法，
 * 按同一模式扩充即可，不影响本原型验证的安全与流式结论。
 */
import type { MarkdownIt as MarkdownItInstance, StateBlock, StateInline } from 'markdown-it';

function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (pos + 2 > max) return false;
  if (state.src.slice(pos, pos + 2) !== '$$') return false;

  const firstLineRest = state.src.slice(pos + 2, max).trim();
  let nextLine = startLine;
  let found = false;
  let contentEnd = max; // 默认：未闭合时内容到文档末尾

  if (firstLineRest.endsWith('$$') && firstLineRest.length >= 2) {
    // 单行 $$...$$
    found = true;
    nextLine = startLine + 1;
  } else {
    for (nextLine = startLine + 1; nextLine < endLine; nextLine++) {
      const lPos = state.bMarks[nextLine] + state.tShift[nextLine];
      const lMax = state.eMarks[nextLine];
      const line = state.src.slice(lPos, lMax).trim();
      if (line === '$$') {
        found = true;
        contentEnd = state.bMarks[nextLine];
        nextLine += 1;
        break;
      }
    }
    if (!found) {
      // 未闭合：读到文档末尾（EOF），行为对齐内置 fence 规则
      nextLine = endLine;
      contentEnd = state.eMarks[endLine - 1] ?? max;
    }
  }

  if (silent) return true;

  let content: string;
  if (firstLineRest.endsWith('$$') && firstLineRest.length >= 2) {
    content = firstLineRest.slice(0, -2);
  } else {
    content = state.getLines(startLine + 1, found ? nextLine - 1 : nextLine, 0, false);
  }

  const token = state.push('math_block', '', 0);
  token.block = true;
  token.content = content;
  token.map = [startLine, nextLine];
  token.meta = { unclosed: !found };
  state.line = nextLine;
  return true;
}

function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src[start] !== '$') return false;
  // 避免误吞货币符号："$5" 后紧跟数字且前一字符是数字/字母时不触发
  const next = state.src[start + 1];
  if (next === undefined || next === ' ' || next === '$') return false;

  let pos = start + 1;
  let found = false;
  while (pos < state.posMax) {
    if (state.src[pos] === '\\') {
      pos += 2;
      continue;
    }
    if (state.src[pos] === '$') {
      found = true;
      break;
    }
    if (state.src[pos] === '\n') break; // 不跨行
    pos++;
  }
  if (!found) return false;
  const content = state.src.slice(start + 1, pos);
  if (content.length === 0 || /\s$/.test(content)) return false;

  if (!silent) {
    const token = state.push('math_inline', '', 0);
    token.content = content;
    token.markup = '$';
  }
  state.pos = pos + 1;
  return true;
}

export function mathPlugin(md: MarkdownItInstance): void {
  md.block.ruler.before('fence', 'math_block', mathBlockRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.inline.ruler.before('escape', 'math_inline', mathInlineRule);
}
