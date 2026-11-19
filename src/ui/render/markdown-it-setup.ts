/**
 * markdown-it 实例配置（5.10 管线第一步）。
 *
 * 安全约束落点：
 * - `html: false`：原始 HTML 一律当纯文本转义输出，不是“渐进增强”而是硬开关。
 * - 链接：协议白名单 http/https/mailto；其余的链接整体降级为纯文本（显示链接
 *   文字，不生成 <a>，不保留原始 href），并给允许的链接加
 *   `target="_blank" rel="noopener noreferrer"`。
 * - 图片：不渲染 <img>（不产生任何浏览器会自动发起请求的标签）；协议允许时
 *   渲染成指向原图的文字链接，否则渲染成纯文本占位。
 * - 代码块：交给 highlight.ts（20k 字符上限 + 语言白名单 + 异常兜底）。
 * - 公式：交给 math-plugin.ts + katex-render.ts。
 *
 * 移植自 prototypes/v10-render/src/render/markdown-it-setup.ts（V-10 原型已验证）。
 */

import type { Env, RendererRule } from 'markdown-it';
import MarkdownIt from 'markdown-it';
import { escapeHtml, highlightCode } from './highlight';
import { renderMath } from './katex-render';
import { mathPlugin } from './math-plugin';
import { isAllowedLinkProtocol } from './protocol';

interface LinkEnv extends Env {
  __raLinkAllowedStack?: boolean[];
}

export function createMarkdownIt() {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: false,
  });
  md.use(mathPlugin);

  // ---- 链接：协议白名单 + 不允许时整体降级为纯文本 ----
  const defaultLinkOpen: RendererRule =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (!token) return '';
    const href = String(token.attrGet('href') ?? '');
    const allowed = isAllowedLinkProtocol(href);
    const linkEnv = env as LinkEnv;
    linkEnv.__raLinkAllowedStack ??= [];
    linkEnv.__raLinkAllowedStack.push(allowed);
    if (!allowed) return '';
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  const defaultLinkClose: RendererRule =
    md.renderer.rules.link_close ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_close = (tokens, idx, options, env, self) => {
    const linkEnv = env as LinkEnv;
    const allowed = linkEnv.__raLinkAllowedStack?.pop() ?? false;
    if (!allowed) return '';
    return defaultLinkClose(tokens, idx, options, env, self);
  };

  // ---- 图片：不产生 <img>；允许协议时降级为文字链接，否则降级为纯文本占位 ----
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return '';
    const src = String(token.attrGet('src') ?? '');
    const alt = token.content || '图片';
    if (isAllowedLinkProtocol(src)) {
      const safeHref = escapeHtml(src);
      const safeAlt = escapeHtml(alt);
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="ra-image-link">[图片: ${safeAlt}]</a>`;
    }
    return `<span class="ra-image-placeholder">[图片: ${escapeHtml(alt)}]</span>`;
  };

  // ---- 代码围栏 ----
  const renderFence: RendererRule = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return '';
    const lang = token.info.trim().split(/\s+/)[0] || undefined;
    const result = highlightCode(token.content, lang);
    const langClass = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    const highlightedClass = result.highlighted ? ' hljs' : '';
    return `<pre class="ra-code${highlightedClass}"${langClass}><code>${result.html}</code></pre>\n`;
  };
  md.renderer.rules.fence = renderFence;
  md.renderer.rules.code_block = renderFence;
  md.renderer.rules.code_inline = (tokens, idx) => {
    const token = tokens[idx];
    return token ? `<code class="ra-code-inline">${escapeHtml(token.content)}</code>` : '';
  };

  // ---- 公式 ----
  md.renderer.rules.math_block = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return '';
    const result = renderMath(token.content.trim(), true);
    return `<div class="ra-math ra-math-block"${result.ok ? '' : ' data-math-error="true"'}>${result.html}</div>\n`;
  };
  md.renderer.rules.math_inline = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return '';
    const result = renderMath(token.content.trim(), false);
    return `<span class="ra-math ra-math-inline"${result.ok ? '' : ' data-math-error="true"'}>${result.html}</span>`;
  };

  return md;
}
