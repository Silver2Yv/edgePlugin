// @vitest-environment happy-dom
// 阅读器回报页面图片（E2）：只收选区所在块里「页面自己已经加载出来」的图——complete 且 naturalWidth > 0、取 currentSrc、
// 只收 http/https、去重、太小的装饰图跳过、最多 MAX_PAGE_IMAGES 张；内容版本对不上最近一次抽取就是空。
import { describe, expect, it } from 'vitest';
import { MAX_PAGE_IMAGES } from '@/core/domain/messages';
import type { ExtractResult } from '@/page/extract';
import { imagesInBlocks } from '@/page/page-read';

function img(
  parent: Element,
  src: string,
  o: { complete?: boolean; w?: number; h?: number; current?: string } = {},
) {
  const el = document.createElement('img');
  el.setAttribute('src', src);
  const def = (k: string, v: unknown) => Object.defineProperty(el, k, { value: v, configurable: true });
  def('complete', o.complete ?? true);
  def('naturalWidth', o.w ?? 200);
  def('naturalHeight', o.h ?? 100);
  def('currentSrc', o.current ?? src);
  parent.append(el);
  return el;
}

function result(blocks: Record<string, Element>, contentVersion = 'v1'): ExtractResult {
  return {
    report: { contentVersion },
    elements: new Map(Object.entries(blocks)),
  } as unknown as ExtractResult;
}

const para = () => {
  const p = document.createElement('p');
  document.body.append(p);
  return p;
};

describe('imagesInBlocks', () => {
  it('收已加载的 http/https 图，用 currentSrc，按文档顺序去重', () => {
    const p = para();
    img(p, 'https://a.test/1.png');
    img(p, 'https://a.test/1.png');
    img(p, 'https://a.test/small.jpg', { current: 'https://a.test/big.jpg' });
    expect(imagesInBlocks(result({ b1: p }), ['b1'], 'v1')).toEqual([
      'https://a.test/1.png',
      'https://a.test/big.jpg',
    ]);
  });

  it('跳过：还没加载完、解码失败、太小的装饰图、data:/blob:/file: 地址', () => {
    const p = para();
    img(p, 'https://a.test/loading.png', { complete: false });
    img(p, 'https://a.test/broken.png', { w: 0, h: 0 });
    img(p, 'https://a.test/icon.png', { w: 16, h: 16 });
    img(p, 'https://a.test/thin.png', { w: 400, h: 8 });
    img(p, 'data:image/png;base64,AAAA');
    img(p, 'blob:https://a.test/xyz');
    img(p, 'file:///etc/x.png');
    img(p, 'https://a.test/ok.png', { w: 32, h: 32 });
    expect(imagesInBlocks(result({ b1: p }), ['b1'], 'v1')).toEqual(['https://a.test/ok.png']);
  });

  it('只看给定的块：别的块里的图不收；块号不存在忽略', () => {
    const a = para();
    const b = para();
    img(a, 'https://a.test/in.png');
    img(b, 'https://a.test/out.png');
    expect(imagesInBlocks(result({ b1: a, b2: b }), ['b1', 'b99'], 'v1')).toEqual(['https://a.test/in.png']);
  });

  it(`最多 ${MAX_PAGE_IMAGES} 张`, () => {
    const p = para();
    for (let i = 0; i < 6; i++) img(p, `https://a.test/${i}.png`);
    expect(imagesInBlocks(result({ b1: p }), ['b1'], 'v1')).toHaveLength(MAX_PAGE_IMAGES);
  });

  it('内容版本对不上最近一次抽取、或还没抽取过：空', () => {
    const p = para();
    img(p, 'https://a.test/1.png');
    expect(imagesInBlocks(result({ b1: p }, 'v2'), ['b1'], 'v1')).toEqual([]);
    expect(imagesInBlocks(undefined, ['b1'], 'v1')).toEqual([]);
  });
});
