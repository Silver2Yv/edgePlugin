// @vitest-environment happy-dom
// 移植自 prototypes/v10-render/test/security.test.ts（V-10 原型已验证），断言内容未改动，
// 只是改从 @/ui/render 公开入口导入。
import { describe, expect, it } from 'vitest';
import { createMarkdownIt, createStreamingRenderer, isAllowedLinkProtocol } from '@/ui/render';
import { assertSafeDom } from './dom-assert';
import * as F from './fixtures';

function renderFull(text: string, allowedIds: ReadonlySet<string> = new Set()) {
  const md = createMarkdownIt();
  const renderer = createStreamingRenderer({ md, document });
  renderer.update(text, allowedIds);
  return renderer.finalize(text, allowedIds);
}

describe('5.10 安全规则：html:false 下的原始 HTML', () => {
  it('不产生 <script>，不产生可执行的内联事件属性', () => {
    const blocks = renderFull(F.RAW_HTML_INJECTION);
    for (const b of blocks) {
      const violations = assertSafeDom(b.node);
      expect(violations).toEqual([]);
    }
    const allText = blocks.map((b) => b.node.textContent).join('\n');
    // 原始 HTML 被当纯文本转义输出，标签字符仍以文本形式可见，但不是真实元素
    expect(allText).toContain('<script>');
    for (const b of blocks) {
      expect(b.node.querySelector('script')).toBeNull();
      expect(b.node.querySelector('img')).toBeNull();
    }
  });
});

describe('5.10 安全规则：链接协议白名单', () => {
  it('isAllowedLinkProtocol 正确区分安全协议与各类绕过变体', () => {
    expect(isAllowedLinkProtocol('https://example.com')).toBe(true);
    expect(isAllowedLinkProtocol('http://example.com')).toBe(true);
    expect(isAllowedLinkProtocol('mailto:a@example.com')).toBe(true);
    expect(isAllowedLinkProtocol('javascript:alert(1)')).toBe(false);
    expect(isAllowedLinkProtocol('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isAllowedLinkProtocol('java\tscript:alert(1)')).toBe(false);
    expect(isAllowedLinkProtocol('java\nscript:alert(1)')).toBe(false);
    expect(isAllowedLinkProtocol('&#106;avascript:alert(1)')).toBe(false);
    expect(isAllowedLinkProtocol('&#x6A;avascript:alert(1)')).toBe(false);
    expect(isAllowedLinkProtocol('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isAllowedLinkProtocol('vbscript:msgbox(1)')).toBe(false);
    expect(isAllowedLinkProtocol('file:///etc/passwd')).toBe(false);
    expect(isAllowedLinkProtocol('  javascript:alert(1)')).toBe(false);
    expect(isAllowedLinkProtocol('//evil.example/x')).toBe(false); // 协议相对地址不在白名单内，按纯文本处理
  });

  it('危险协议链接渲染后 DOM 中没有危险 href，安全链接保留且带新标签属性', () => {
    const blocks = renderFull(F.DANGEROUS_PROTOCOL_LINKS);
    for (const b of blocks) {
      expect(assertSafeDom(b.node)).toEqual([]);
    }
    const anchors = blocks.flatMap((b) => Array.from(b.node.querySelectorAll('a')));
    expect(anchors.length).toBe(3); // 只剩 3 个安全链接
    for (const a of anchors) {
      expect(isAllowedLinkProtocol(a.getAttribute('href') ?? '')).toBe(true);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    // 危险链接的可见文字（链接标签文字）仍然存在，只是不再是可点击元素
    const text = blocks.map((b) => b.node.textContent).join('\n');
    expect(text).toContain('危险1');
    expect(text).toContain('危险9');
  });
});

describe('5.10 安全规则：图片不自动加载外链', () => {
  it('安全协议的图片降级为文字链接，不产生 <img>', () => {
    const md = '![alt文字](https://example.com/pic.png)';
    const blocks = renderFull(md);
    for (const b of blocks) {
      expect(b.node.querySelector('img')).toBeNull();
      expect(assertSafeDom(b.node)).toEqual([]);
    }
    const html = blocks.map((b) => b.node.innerHTML).join('');
    expect(html).toContain('ra-image-link');
  });

  it('危险协议的图片不产生 <img>（markdown-it 自身的 validateLink 已拦截为纯文本，图片插件兜底占位逻辑同样不产生 <img>）', () => {
    const md = '![坏协议](javascript:alert(1))';
    const blocks = renderFull(md);
    for (const b of blocks) {
      expect(b.node.querySelector('img')).toBeNull();
      expect(assertSafeDom(b.node)).toEqual([]);
    }
  });
});

describe('5.10 安全规则：引用标记里的属性字符', () => {
  it('非纯数字编号与越权编号都不会被当成可点击引用，也不会污染 DOM 属性', () => {
    const blocks = renderFull(F.CITATION_ATTRIBUTE_CHARS, F.CITATION_ALLOWED_IDS);
    for (const b of blocks) {
      expect(assertSafeDom(b.node)).toEqual([]);
    }
    const allHtml = blocks.map((b) => b.node.innerHTML).join('\n');
    // 【12" onclick=alert(1)】整体不匹配引用正则（含有非数字字符），原样当文本
    expect(allHtml).toContain('onclick=alert(1)');
    // 但不存在真实的 onclick 属性（上面的 assertSafeDom 已经断言过，这里再显式确认）
    for (const b of blocks) {
      expect(b.node.querySelector('[onclick]')).toBeNull();
    }
    // 允许的编号【12】被替换成引用元素
    const citeEls = blocks.flatMap((b) =>
      Array.from(b.node.querySelectorAll('.ra-citation, .ra-citation-quote')),
    );
    const idsSeen = citeEls.map((el) => el.getAttribute('data-id') ?? el.getAttribute('data-ids'));
    expect(idsSeen).toContain('12');
    // 不被允许的 99 号逐字引用，整体保持纯文本（标记符号本身可见）
    expect(allHtml).toContain('【99】原文片段【/99】');
    // 部分越权的多编号 【12,99】整体按纯文本显示，不生成引用元素
    expect(allHtml).toContain('【12,99】');
  });
});
