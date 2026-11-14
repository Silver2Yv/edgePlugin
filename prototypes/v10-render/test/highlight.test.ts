import { describe, it, expect } from 'vitest';
import { highlightCode, isLanguageAllowed, CODE_HIGHLIGHT_MAX_CHARS } from '../src/render/highlight.js';

describe('5.10 安全规则：代码高亮语言白名单与长度上限', () => {
  it('白名单内语言（含别名）被接受', () => {
    expect(isLanguageAllowed('javascript')).toBe(true);
    expect(isLanguageAllowed('js')).toBe(true);
    expect(isLanguageAllowed('ts')).toBe(true);
    expect(isLanguageAllowed('py')).toBe(true);
  });

  it('不在白名单内的语言被拒绝', () => {
    expect(isLanguageAllowed('brainfuck')).toBe(false);
    expect(isLanguageAllowed('cobol')).toBe(false);
    expect(isLanguageAllowed(undefined)).toBe(false);
    expect(isLanguageAllowed(null)).toBe(false);
    expect(isLanguageAllowed('')).toBe(false);
  });

  it('语言不在白名单：降级为转义纯文本，不高亮', () => {
    const r = highlightCode('<script>alert(1)</script>', 'brainfuck');
    expect(r.highlighted).toBe(false);
    expect(r.reason).toBe('language-not-allowed');
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('超过 20k 字符跳过高亮，但仍转义输出全部内容', () => {
    const longCode = 'x'.repeat(CODE_HIGHLIGHT_MAX_CHARS + 1);
    const r = highlightCode(longCode, 'javascript');
    expect(r.highlighted).toBe(false);
    expect(r.reason).toBe('too-long');
    expect(r.html.length).toBeGreaterThanOrEqual(longCode.length);
  });

  it('白名单内语言且长度允许时正常高亮', () => {
    const r = highlightCode('function foo() { return 1; }', 'javascript');
    expect(r.highlighted).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});
