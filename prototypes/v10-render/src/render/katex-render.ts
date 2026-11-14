/**
 * KaTeX 安全封装（5.10）：
 * - trust:false（禁用 \href、\includegraphics 等可信才允许的命令）。
 * - strict:'ignore'（警告级语法不抛错中断，但不放宽 trust 的安全边界）。
 * - maxSize / maxExpand 设上限，防巨大公式与宏递归展开炸渲染。
 * - 宏不跨消息：每次调用都传入全新的 macros 对象，绝不复用同一引用——
 *   KaTeX 的 \def/\gdef 会写入传入的 macros 对象，复用引用等于让宏跨消息生效。
 * - 解析失败：渲染转义后的源码文本，不抛给上层中断整条流式渲染。
 */
import katex from 'katex';

export const KATEX_MAX_SIZE = 500;
export const KATEX_MAX_EXPAND = 1000;

export interface MathRenderResult {
  html: string;
  ok: boolean;
  errorMessage?: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMath(source: string, displayMode: boolean): MathRenderResult {
  try {
    const html = katex.renderToString(source, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxSize: KATEX_MAX_SIZE,
      maxExpand: KATEX_MAX_EXPAND,
      // 全新对象：不与其他消息、其他公式共享宏定义存储
      macros: {}
    });
    return { html, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const tag = displayMode ? 'div' : 'span';
    const escaped = escapeHtml(source);
    return {
      html: `<${tag} class="ra-math-error" data-error="true">${escaped}</${tag}>`,
      ok: false,
      errorMessage: message
    };
  }
}
