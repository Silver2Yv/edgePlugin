/**
 * 代码高亮（5.10）：
 * - 超过 20k 字符跳过高亮（仍渲染为转义后的纯文本代码块，不是不渲染）。
 * - 语言白名单：只注册"常用子集"，不引入 highlight.js 全量语言包。
 * - 任何异常都兜底为转义纯文本，不让一次高亮失败打断整条流式渲染。
 */
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';

export const CODE_HIGHLIGHT_MAX_CHARS = 20_000;

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsx: 'javascript',
  py: 'python',
  'c++': 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  html: 'xml',
  htm: 'xml',
  svg: 'xml'
};

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('java', java);
  hljs.registerLanguage('cpp', cpp);
  hljs.registerLanguage('csharp', csharp);
  hljs.registerLanguage('go', go);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('ruby', ruby);
  hljs.registerLanguage('php', php);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('yaml', yaml);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('css', css);
  registered = true;
}

export function isLanguageAllowed(lang: string | undefined | null): boolean {
  if (!lang) return false;
  const normalized = LANGUAGE_ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  ensureRegistered();
  return hljs.getLanguage(normalized) !== undefined;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface HighlightResult {
  html: string;
  highlighted: boolean;
  reason?: 'too-long' | 'language-not-allowed' | 'error';
}

/** 返回已转义/已高亮的代码 HTML（不含外层 <pre><code>）。 */
export function highlightCode(code: string, lang: string | undefined | null): HighlightResult {
  if (code.length > CODE_HIGHLIGHT_MAX_CHARS) {
    return { html: escapeHtml(code), highlighted: false, reason: 'too-long' };
  }
  if (!isLanguageAllowed(lang)) {
    return { html: escapeHtml(code), highlighted: false, reason: 'language-not-allowed' };
  }
  const normalized = LANGUAGE_ALIASES[(lang as string).toLowerCase()] ?? (lang as string).toLowerCase();
  try {
    ensureRegistered();
    const result = hljs.highlight(code, { language: normalized, ignoreIllegals: true });
    return { html: result.value, highlighted: true };
  } catch {
    return { html: escapeHtml(code), highlighted: false, reason: 'error' };
  }
}
