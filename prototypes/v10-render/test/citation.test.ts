import { describe, it, expect } from 'vitest';
import { findCitationMatches, applyCitations } from '../src/render/citation.js';

describe('V-09 引用标记解析（在 V-10 里复用）', () => {
  it('纯数字编号被识别，非数字字符导致整体不匹配', () => {
    const matches = findCitationMatches('见【12】与【abc】和【12" onclick=x】');
    const ids = matches.map((m) => m.ids.join(','));
    expect(ids).toEqual(['12']);
  });

  it('逐字引用优先于数字编号，且编号区间不与之重叠', () => {
    const matches = findCitationMatches('【12】原文【/12】');
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe('quote');
    expect(matches[0].ids).toEqual(['12']);
    expect(matches[0].quotedText).toBe('原文');
  });

  it('多编号写法【12,5】被拆分为多个 id', () => {
    const matches = findCitationMatches('【12,5】');
    expect(matches).toHaveLength(1);
    expect(matches[0].ids).toEqual(['12', '5']);
  });
});

describe('5.10：引用只对允许集合内的编号生效（DOM 挂载）', () => {
  function applyAndRead(text: string, allowed: ReadonlySet<string>) {
    const container = document.createElement('div');
    container.textContent = text;
    applyCitations(container, allowed, document);
    return container;
  }

  it('允许的编号生成 <sup class="ra-citation">，不允许的保持纯文本', () => {
    const container = applyAndRead('要点【12】，另一点【99】。', new Set(['12']));
    const sup = container.querySelector('sup.ra-citation');
    expect(sup).not.toBeNull();
    expect(sup?.getAttribute('data-ids')).toBe('12');
    expect(container.textContent).toContain('【99】');
    expect(container.querySelector('[data-ids="99"]')).toBeNull();
  });

  it('多编号中只要有一个不在允许集合内，整条标记整体保持纯文本（不展示半个引用）', () => {
    const container = applyAndRead('混合【12,99】结尾。', new Set(['12']));
    expect(container.querySelector('sup.ra-citation')).toBeNull();
    expect(container.textContent).toContain('【12,99】');
  });

  it('逐字引用只在允许编号时生成 <mark>，否则保持原始标记文本', () => {
    const allowed = applyAndRead('【12】原文【/12】', new Set(['12']));
    const mark = allowed.querySelector('mark.ra-citation-quote');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('原文');
    expect(mark?.getAttribute('data-id')).toBe('12');

    const disallowed = applyAndRead('【99】原文【/99】', new Set(['12']));
    expect(disallowed.querySelector('mark.ra-citation-quote')).toBeNull();
    expect(disallowed.textContent).toBe('【99】原文【/99】');
  });

  it('引用节点通过 createElement/setAttribute/textContent 生成，属性值不会提前闭合标签', () => {
    // 逐字引用正文里包含双引号与尖括号，不应影响节点结构（因为是 textContent 赋值，不是拼接 HTML）
    const container = applyAndRead('【12】a"b<c>d【/12】', new Set(['12']));
    const mark = container.querySelector('mark.ra-citation-quote');
    expect(mark?.textContent).toBe('a"b<c>d');
    expect(mark?.querySelector('*')).toBeNull(); // 没有被解析成子元素
    expect(container.querySelector('script')).toBeNull();
  });

  it('不跳过代码/公式子树之外的文本节点，但会跳过 CODE/PRE 内部', () => {
    const container = document.createElement('div');
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = '这不是引用：【12】';
    pre.appendChild(code);
    container.appendChild(pre);
    const p = document.createElement('p');
    p.textContent = '这是引用：【12】';
    container.appendChild(p);

    applyCitations(container, new Set(['12']), document);
    expect(pre.querySelector('sup.ra-citation')).toBeNull();
    expect(p.querySelector('sup.ra-citation')).not.toBeNull();
  });
});
