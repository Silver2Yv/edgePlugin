// 引用 → 锚点（5.7）：回答里的引用写法与后台核对、逐字原文在块里定位（忽略空白）、快照过期后只按原文；
// 生成的锚点交给 matchAnchor 走三级降级（页面没变 → 精确；改了几个字 → 近似；找不到 → 滚动比例）。
import { describe, expect, it } from 'vitest';
import { matchAnchor } from '@/core/anchor/anchor';
import {
  citationAnchor,
  citationInText,
  findCitationMatches,
  findQuoteInBlock,
  normalizeCitationNumber,
} from '@/core/anchor/citations';
import { blockDigest } from '@/core/context/content-version';

const blocks = [
  { id: 'b1', text: '测试文章' },
  { id: 'b2', text: '第二段讲背景。光合作用把光能转成化学能，并释放氧气。' },
  { id: 'b3', text: '第三段：叶绿素主要吸收红光和蓝光，\n反射绿光，所以叶子是绿色的。' },
];
const b3 = blocks[2] as (typeof blocks)[number];

describe('引用写法（与界面渲染同一套解析）', () => {
  it('逐字引用优先、编号可多个、前导零规范化', () => {
    const m = findCitationMatches('要点【2,3】。原文【3】反射绿光【/3】。【012】');
    expect(m.map((x) => [x.kind, x.ids])).toEqual([
      ['number', ['2', '3']],
      ['quote', ['3']],
      ['number', ['012']],
    ]);
    expect(normalizeCitationNumber('012')).toBe('12');
  });

  it('citationInText：编号在回答里出现过才算；原文与回答里的逐字引用一致（忽略空白）才给出', () => {
    const text = '要点【2】。原文：【3】叶绿素主要吸收\n红光【/3】';
    expect(citationInText(text, '2', undefined)).toEqual({ cited: true });
    expect(citationInText(text, '3', '叶绿素主要吸收 红光')).toEqual({
      cited: true,
      quote: '叶绿素主要吸收\n红光',
    });
    expect(citationInText(text, '3', '编造的原文')).toEqual({ cited: true });
    expect(citationInText(text, '9', undefined)).toEqual({ cited: false });
  });
});

describe('findQuoteInBlock', () => {
  it('原样出现直接给位置；只差空白、换行也能找到；找不到为 undefined', () => {
    expect(findQuoteInBlock(b3.text, '吸收红光和蓝光')).toEqual({
      start: b3.text.indexOf('吸收红光'),
      end: b3.text.indexOf('吸收红光') + 7,
    });
    const hit = findQuoteInBlock(b3.text, '蓝光， 反射绿光');
    expect(hit && b3.text.slice(hit.start, hit.end)).toBe('蓝光，\n反射绿光');
    expect(findQuoteInBlock(b3.text, '不在这里')).toBeUndefined();
    expect(findQuoteInBlock(b3.text, '  ')).toBeUndefined();
  });
});

describe('citationAnchor + matchAnchor（三级降级）', () => {
  it('逐字引用：锚点建在快照的块上，页面没变时精确命中那一段', () => {
    const a = citationAnchor({ block: b3, quote: '吸收红光和蓝光', scrollRatio: 0 });
    expect(a).toMatchObject({ exact: '吸收红光和蓝光', blockDigest: blockDigest(b3.text) });
    expect(a?.prefix).toBe('第三段：叶绿素主要');
    const m = a && matchAnchor(a, blocks);
    expect(m).toMatchObject({ level: 'exact', blockId: 'b3', start: b3.text.indexOf('吸收') });
  });

  it('要点编号：锚点是整块；原文在块里找不到时也退回整块', () => {
    const whole = citationAnchor({ block: b3, scrollRatio: 0 });
    expect(whole?.exact).toBe(b3.text);
    expect(citationAnchor({ block: b3, quote: '网页上没有的话', scrollRatio: 0 })?.exact).toBe(b3.text);
  });

  it('页面改了几个字：近似匹配（降级）；整段换掉：按滚动比例（再降级），不把旧块号套到新内容上', () => {
    const a = citationAnchor({ block: b3, scrollRatio: 0.6 });
    if (!a) throw new Error('应有锚点');
    const edited = [
      blocks[0],
      blocks[1],
      { id: 'b3', text: b3.text.replace('红光和蓝光', '红光与蓝光') },
    ] as {
      id: string;
      text: string;
    }[];
    expect(matchAnchor(a, edited)).toMatchObject({ level: 'fuzzy', blockId: 'b3' });
    const replaced = [blocks[0], blocks[1], { id: 'b3', text: '这一段已经完全换成了别的内容。' }] as {
      id: string;
      text: string;
    }[];
    expect(matchAnchor(a, replaced)).toEqual({ level: 'scroll', scrollRatio: 0.6 });
  });

  it('快照过期：只有原文的锚点（没有上下文与摘要）；连原文都没有就不能定位', () => {
    const a = citationAnchor({ quote: ' 反射绿光 ', scrollRatio: 0 });
    expect(a).toMatchObject({ exact: '反射绿光', prefix: '', suffix: '', blockDigest: '' });
    expect(a && matchAnchor(a, blocks)).toMatchObject({ level: 'exact', blockId: 'b3' });
    expect(citationAnchor({ scrollRatio: 0 })).toBeUndefined();
    expect(citationAnchor({ quote: '   ', scrollRatio: 0 })).toBeUndefined();
  });
});
