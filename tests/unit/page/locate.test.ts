// @vitest-environment happy-dom
// 阅读器里的定位与高亮（5.7、F4）：版本相同直接用块号；版本不同按锚点重新定位（改过几个字 → 近似）；
// 高亮登记在 CSS.highlights（不改网页 DOM）；回到刚才的位置只能用一次。happy-dom 不做布局，滚动只验证调用。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { citationAnchor } from '@/core/anchor/citations';
import { extractPage } from '@/page/extract';
import { createLocator, HIGHLIGHT_NAME, rangeOfText } from '@/page/locate';

const PAGE = (third: string) => `
<article>
  <h1>定位测试</h1>
  <p id="p2">第二段正文，介绍背景，足够长的正文内容让语义根节点成立。${'补充正文。'.repeat(40)}</p>
  <p id="p3">${third}</p>
  <ul><li id="li">列表 <b>一项</b> 内容</li></ul>
</article>`;
const THIRD = '第三段：叶绿素主要吸收<em>红光</em>和蓝光，反射绿光。';

const registry = new Map<string, { ranges: Range[] }>();

beforeEach(() => {
  registry.clear();
  vi.stubGlobal(
    'Highlight',
    class {
      ranges: Range[];
      constructor(...r: Range[]) {
        this.ranges = r;
      }
    },
  );
  vi.stubGlobal('CSS', { highlights: registry });
  Element.prototype.scrollIntoView = vi.fn();
  document.body.innerHTML = PAGE(THIRD);
});
afterEach(() => vi.unstubAllGlobals());

async function blockOf(id: string) {
  const r = await extractPage(document, { sliceMs: 1 });
  const el = document.getElementById(id) as Element;
  const blockId = [...r.elements].find(([, e]) => e === el)?.[0] as string;
  const block = r.report.blocks.find((b) => b.id === blockId) as { id: string; text: string };
  return { r, block };
}

describe('rangeOfText', () => {
  it('跨行内元素、忽略空白差异找到原文；找不到为 undefined', () => {
    const p3 = document.getElementById('p3') as Element;
    expect(rangeOfText(p3, '吸收红光 和蓝光')?.toString()).toBe('吸收红光和蓝光');
    expect(rangeOfText(p3, '不在这里')).toBeUndefined();
  });
});

describe('createLocator', () => {
  it('版本相同：直接用块号，逐字原文高亮那一段，滚过去；可以回去一次', async () => {
    const { r, block } = await blockOf('p3');
    const anchor = citationAnchor({ block, quote: '吸收红光和蓝光', scrollRatio: 0 });
    const loc = createLocator();
    const res = await loc.locate({
      anchor: anchor as NonNullable<typeof anchor>,
      highlight: true,
      blockId: block.id,
      contentVersion: r.report.contentVersion,
    });
    expect(res).toEqual({ level: 'exact', back: true });
    expect(registry.get(HIGHLIGHT_NAME)?.ranges[0]?.toString()).toBe('吸收红光和蓝光');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // 网页 DOM 没被改动
    expect(document.getElementById('p3')?.innerHTML).toBe(THIRD);
    expect(loc.back()).toBe(true);
    expect(registry.has(HIGHLIGHT_NAME)).toBe(false);
    expect(loc.back()).toBe(false);
  });

  it('要点编号（整块）：高亮整个元素', async () => {
    const { r, block } = await blockOf('li');
    const anchor = citationAnchor({ block, scrollRatio: 0 });
    const res = await createLocator().locate({
      anchor: anchor as NonNullable<typeof anchor>,
      highlight: true,
      blockId: block.id,
      contentVersion: r.report.contentVersion,
    });
    expect(res.level).toBe('exact');
    expect(registry.get(HIGHLIGHT_NAME)?.ranges[0]?.toString()).toBe('列表 一项 内容');
  });

  it('页面改过（版本不同）：不套用旧块号，按锚点近似匹配，降级为 fuzzy', async () => {
    const { r, block } = await blockOf('p3');
    const anchor = citationAnchor({ block, quote: '吸收红光和蓝光', scrollRatio: 0 });
    (document.getElementById('p3') as Element).innerHTML =
      '第三段：叶绿素主要吸收<em>红光</em>与蓝光，反射绿光。';
    const res = await createLocator().locate({
      anchor: anchor as NonNullable<typeof anchor>,
      highlight: true,
      blockId: block.id,
      contentVersion: r.report.contentVersion,
    });
    expect(res).toEqual({ level: 'fuzzy', back: true });
    expect(registry.get(HIGHLIGHT_NAME)?.ranges[0]?.toString()).toBe('吸收红光与蓝光');
  });

  it('原文整段没了、也没有块号：none，不滚动、不高亮', async () => {
    const anchor = citationAnchor({ quote: '网页上根本没有的一句话', scrollRatio: 0 });
    const res = await createLocator().locate({
      anchor: anchor as NonNullable<typeof anchor>,
      highlight: true,
    });
    expect(res).toEqual({ level: 'none', back: false });
    expect(registry.size).toBe(0);
  });
});
