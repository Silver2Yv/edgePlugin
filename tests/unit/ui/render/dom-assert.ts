// V-10 通过条件里的"渲染出的 DOM 中没有脚本、事件属性、不在白名单的协议、
// 会自动发起网络请求的元素"检查器。返回空数组表示通过，否则列出违规项。
//
// 注意：KaTeX 的正常输出会包含 <svg><path> 这类纯矢量绘制标签（用于根号、
// 重音符号等），这不是"自动发起网络请求的元素"，本检查器允许它们存在，
// 但仍会检查其是否带有危险的 on* 事件属性或 href/src 等 URL 属性。
//
// 移植自 prototypes/v10-render/test/dom-assert.ts，内容未改动。
import { isAllowedLinkProtocol } from '@/ui/render';

const HARD_FORBIDDEN_TAGS = new Set([
  'SCRIPT',
  'IFRAME',
  'IMG',
  'LINK',
  'EMBED',
  'OBJECT',
  'VIDEO',
  'AUDIO',
  'SOURCE',
  'TRACK',
  'BASE',
  'META',
  'STYLE',
  'FORM',
]);

const URL_BEARING_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background'];

export function assertSafeDom(root: Element): string[] {
  const violations: string[] = [];
  const all = [root, ...Array.from(root.querySelectorAll('*'))];

  for (const el of all) {
    const tag = el.tagName.toUpperCase();
    if (HARD_FORBIDDEN_TAGS.has(tag)) {
      violations.push(`禁止的标签：<${tag.toLowerCase()}> outerHTML=${el.outerHTML.slice(0, 120)}`);
    }

    const attrNames = el.getAttributeNames ? el.getAttributeNames() : [];
    for (const name of attrNames) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on')) {
        violations.push(`事件属性：<${tag.toLowerCase()} ${name}="${el.getAttribute(name)}">`);
      }
      if (URL_BEARING_ATTRS.includes(lower)) {
        const value = el.getAttribute(name) ?? '';
        if (!isAllowedLinkProtocol(value)) {
          violations.push(`危险/非白名单协议：<${tag.toLowerCase()} ${name}="${value}">`);
        }
      }
    }

    // javascript:/data: 等伪协议也可能出现在非常规属性里（如 xlink:href 变体），
    // 做一次兜底：任何属性值若整体就是一个危险协议开头的字符串也记录。
    for (const name of attrNames) {
      const value = el.getAttribute(name) ?? '';
      if (/^\s*(javascript|vbscript|data|file)\s*:/i.test(value.replace(/[\t\n\r]/g, ''))) {
        if (!URL_BEARING_ATTRS.includes(name.toLowerCase())) {
          violations.push(`非 URL 属性里出现危险协议字符串：<${tag.toLowerCase()} ${name}="${value}">`);
        }
      }
    }
  }

  return violations;
}
