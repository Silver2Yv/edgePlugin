// 锚点（5.7、V-09 原型的三级降级）：精确 → 候选块内近似 → 滚动比例；重复文本不取第一个。
import { describe, expect, it } from 'vitest';
import { makeAnchor, matchAnchor } from '@/core/anchor/anchor';

const blocks = [
  { id: 'b1', text: '第一段讲背景。光合作用把光能转成化学能。', headingPath: ['一'] },
  { id: 'b2', text: '第二段讲过程：叶绿体吸收光能，水被分解，释放氧气。', headingPath: ['一'] },
  { id: 'b3', text: '第三段是总结。光合作用把光能转成化学能。', headingPath: ['二'] },
];

describe('makeAnchor', () => {
  it('精确文本、前后各约 32 字、块摘要、偏移', () => {
    const b = blocks[1] as (typeof blocks)[number];
    const start = b.text.indexOf('叶绿体');
    const a = makeAnchor(b, start, start + 3, 0.4);
    expect(a).toMatchObject({ exact: '叶绿体', offsetInBlock: start, scrollRatio: 0.4, headingPath: ['一'] });
    expect(a.prefix).toBe(b.text.slice(0, start));
    expect(a.suffix.length).toBeLessThanOrEqual(32);
    expect(a.blockDigest).toMatch(/^[0-9a-z]+$/);
  });
});

describe('matchAnchor', () => {
  const anchorOn = (id: string, exact: string) => {
    const b = blocks.find((x) => x.id === id) as (typeof blocks)[number];
    const i = b.text.indexOf(exact);
    return makeAnchor(b, i, i + exact.length, 0.5);
  };

  it('唯一出现：精确命中', () => {
    expect(matchAnchor(anchorOn('b2', '水被分解'), blocks)).toMatchObject({ level: 'exact', blockId: 'b2' });
  });

  it('重复出现：用前后文消歧，不取第一个', () => {
    expect(matchAnchor(anchorOn('b3', '光合作用把光能转成化学能'), blocks)).toMatchObject({
      level: 'exact',
      blockId: 'b3',
    });
  });

  it('重复且上下文也一样：降级为位置不确定（score 0）', () => {
    const same = [
      { id: 'x1', text: '同一句话。' },
      { id: 'x2', text: '同一句话。' },
    ];
    const a = { ...makeAnchor({ text: '同一句话。', headingPath: [] }, 0, 4, 0.2), blockDigest: 'zz' };
    expect(matchAnchor(a, same)).toMatchObject({ level: 'fuzzy', score: 0 });
  });

  it('原文改了几个字：近似命中原来那块', () => {
    const a = anchorOn('b2', '叶绿体吸收光能，水被分解，释放氧气');
    const changed = [
      blocks[0],
      { id: 'b2x', text: '第二段讲过程：叶绿素吸收光能，水被分开，释放氧气。' },
      blocks[2],
    ] as {
      id: string;
      text: string;
    }[];
    const m = matchAnchor(a, changed);
    expect(m).toMatchObject({ level: 'fuzzy', blockId: 'b2x' });
    if (m.level === 'fuzzy') expect(m.score).toBeGreaterThan(0.8);
  });

  it('新文档里没有：退到滚动比例；没有块：不可点击', () => {
    const a = anchorOn('b2', '水被分解');
    expect(matchAnchor(a, [{ id: 'n1', text: '完全无关的新内容。' }])).toEqual({
      level: 'scroll',
      scrollRatio: 0.5,
    });
    expect(matchAnchor(a, [])).toEqual({ level: 'none' });
  });
});
