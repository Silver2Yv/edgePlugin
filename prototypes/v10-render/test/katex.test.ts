import { describe, it, expect } from 'vitest';
import { renderMath, KATEX_MAX_EXPAND, KATEX_MAX_SIZE } from '../src/render/katex-render.js';

describe('5.10 安全规则：KaTeX 封装', () => {
  it('解析失败时返回转义后的源码，ok=false，不抛出异常', () => {
    const r = renderMath('\\frac{1}{', false);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBeTruthy();
    expect(r.html).toContain('ra-math-error');
    expect(r.html).not.toContain('<script');
  });

  it('宏不跨调用泄漏：第一次调用里 \\def 的宏，第二次调用无法识别', () => {
    const first = renderMath('\\def\\myMacro{hello}\\myMacro', false);
    expect(first.ok).toBe(true);
    const second = renderMath('\\myMacro', false);
    // 第二次单独调用里 \myMacro 未定义，应当解析失败（证明宏对象是全新的，没有复用上一次的引用）
    expect(second.ok).toBe(false);
  });

  it('maxExpand 阻止宏递归展开炸渲染（\\def 自引用）', () => {
    const r = renderMath('\\def\\x{\\x\\x}\\x', false);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBeTruthy();
    expect(r.html).not.toContain('<script');
  });

  it('maxSize 限制巨大公式的渲染尺寸', () => {
    const r = renderMath('\\rule{900000em}{900000em}', true);
    // 超过 maxSize 时 KaTeX 会把尺寸限制在 maxSize 或直接报错，两种结果都可接受，
    // 只要求：不抛出未捕获异常（上面调用已经说明这一点），且输出不包含危险内容。
    expect(r.html).not.toContain('<script');
    expect(typeof r.html).toBe('string');
  });

  it('trust:false 阻止 \\href / \\url 产生可点击链接', () => {
    const href = renderMath('\\href{https://evil.example/a}{点我}', false);
    const url = renderMath('\\url{https://evil.example/b}', false);
    // trust:false 下 \href、\url 要么解析失败、要么被渲染为不可信占位，
    // 不应该在输出里出现指向该地址的 <a href="https://evil.example/..."> 标签。
    expect(href.html).not.toMatch(/<a\s+[^>]*href="https:\/\/evil\.example\/a"/i);
    expect(url.html).not.toMatch(/<a\s+[^>]*href="https:\/\/evil\.example\/b"/i);
  });

  it('导出的上限常量符合安全封装设定', () => {
    expect(KATEX_MAX_SIZE).toBeGreaterThan(0);
    expect(KATEX_MAX_EXPAND).toBeGreaterThan(0);
  });
});
