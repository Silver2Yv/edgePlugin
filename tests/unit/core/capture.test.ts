// 框选截图的纯逻辑（5.13、5.9 图片单列预算）：坐标换算（各种缩放比、图片与视口不一致）、data URL、提问装配里的图片部分。
import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, parseDataUrl, toDataUrl } from '@/core/capture/data-url';
import {
  clampToViewport,
  cropPixels,
  fitWithin,
  MIN_SELECTION_CSS,
  rectFromPoints,
  sameViewport,
} from '@/core/capture/geometry';
import { defaultBudget } from '@/core/context/plan';
import { type AskInput, assembleAsk, IMAGE_LEAD, IMAGE_QUESTION } from '@/core/prompt/ask';

describe('rectFromPoints / clampToViewport', () => {
  it('任意方向拖都规范成左上角 + 宽高', () => {
    expect(rectFromPoints({ x: 300, y: 200 }, { x: 100, y: 50 })).toEqual({ x: 100, y: 50, w: 200, h: 150 });
    expect(rectFromPoints({ x: 10, y: 90 }, { x: 60, y: 20 })).toEqual({ x: 10, y: 20, w: 50, h: 70 });
  });

  it('夹进视口；夹完太小或整个在视口外返回 undefined', () => {
    const vp = { w: 800, h: 600 };
    expect(clampToViewport({ x: -20, y: 580, w: 100, h: 100 }, vp)).toEqual({ x: 0, y: 580, w: 80, h: 20 });
    expect(clampToViewport({ x: 900, y: 10, w: 50, h: 50 }, vp)).toBeUndefined();
    expect(clampToViewport({ x: 10, y: 10, w: MIN_SELECTION_CSS - 1, h: 50 }, vp)).toBeUndefined();
  });
});

describe('cropPixels：按实际图片尺寸 ÷ 视口换算，不假定 DPR', () => {
  const rect = { x: 100, y: 50, w: 200, h: 100 };
  const vp = { w: 1280, h: 720 };

  it.each([
    [1, { sx: 100, sy: 50, sw: 200, sh: 100 }],
    [1.25, { sx: 125, sy: 62, sw: 250, sh: 126 }],
    [1.5, { sx: 150, sy: 75, sw: 300, sh: 150 }],
    [2, { sx: 200, sy: 100, sw: 400, sh: 200 }],
  ])('缩放比 %s', (k, expected) => {
    expect(cropPixels(rect, vp, { w: vp.w * k, h: vp.h * k })).toEqual(expected);
  });

  it('页面缩放 80%：视口变大（CSS 像素多了），图片还是设备像素，比例照样由尺寸算出', () => {
    // 1600×900 CSS 视口截成 1280×720 的图：比例 0.8
    expect(cropPixels({ x: 400, y: 200, w: 500, h: 250 }, { w: 1600, h: 900 }, { w: 1280, h: 720 })).toEqual({
      sx: 320,
      sy: 160,
      sw: 400,
      sh: 200,
    });
  });

  it('非整数比例：边界向外取整，不丢边上的像素，也不超出图片', () => {
    const c = cropPixels({ x: 1279, y: 719, w: 1, h: 1 }, vp, { w: 1600, h: 900 });
    // 太小：夹进视口后不到 MIN_SELECTION_CSS
    expect(c).toBeUndefined();
    const edge = cropPixels({ x: 1270, y: 710, w: 50, h: 50 }, vp, { w: 1601, h: 901 });
    expect(edge).toBeDefined();
    if (!edge) return;
    expect(edge.sx + edge.sw).toBeLessThanOrEqual(1601);
    expect(edge.sy + edge.sh).toBeLessThanOrEqual(901);
  });

  it('图片横纵比例与视口不一致（截图前后视口变了）：不裁，返回 undefined', () => {
    // 侧边栏打开后视口窄了：图是 1000×720，视口仍报 1280×720
    expect(cropPixels(rect, vp, { w: 1000, h: 720 })).toBeUndefined();
    expect(cropPixels(rect, vp, { w: 2560, h: 1300 })).toBeUndefined();
  });

  it('取整与滚动条带来的小误差不算变化（在 2% 以内）', () => {
    expect(cropPixels(rect, { w: 1280, h: 720 }, { w: 1281, h: 720 })).toBeDefined();
  });

  it('尺寸非法返回 undefined', () => {
    expect(cropPixels(rect, { w: 0, h: 720 }, { w: 1280, h: 720 })).toBeUndefined();
    expect(cropPixels(rect, vp, { w: 0, h: 0 })).toBeUndefined();
  });
});

describe('fitWithin / sameViewport', () => {
  it('等比缩到最长边以内，不放大', () => {
    expect(fitWithin({ w: 4000, h: 1000 }, 2048)).toEqual({ w: 2048, h: 512 });
    expect(fitWithin({ w: 300, h: 200 }, 480)).toEqual({ w: 300, h: 200 });
    expect(fitWithin({ w: 10000, h: 1 }, 100)).toEqual({ w: 100, h: 1 });
  });

  it('同一视口允许半个像素的差', () => {
    expect(sameViewport({ w: 800, h: 600 }, { w: 800.4, h: 599.6 })).toBe(true);
    expect(sameViewport({ w: 800, h: 600 }, { w: 801, h: 600 })).toBe(false);
  });
});

describe('data URL', () => {
  it('解析、往返', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    const url = toDataUrl('image/png', bytes);
    expect(url).toBe(`data:image/png;base64,${bytesToBase64(bytes)}`);
    const p = parseDataUrl(url);
    expect(p?.mime).toBe('image/png');
    expect(base64ToBytes(p?.base64 ?? '')).toEqual(bytes);
  });

  it('不是 base64 data URL 的拒绝', () => {
    expect(parseDataUrl('https://example.test/a.png')).toBeUndefined();
    expect(parseDataUrl('data:image/png,abc')).toBeUndefined();
  });
});

describe('assembleAsk：本轮附图', () => {
  const DATA = 'data:image/png;base64,iVBORw0KGgo=';
  const base: AskInput = {
    question: '',
    history: [],
    lengthTier: 'normal',
    language: 'auto',
    thinking: 'off',
    requestedContextTier: 'selection',
    model: { connectionId: 'conn-test-0001', model: 'mock-flash' },
    contextSnapshotId: 'snap-00000001',
    budget: defaultBudget(),
    actionId: 'ask',
  };

  it('图片是本轮用户消息的第一部分；没输入问题用截图的默认问题；计划 imageCount 为 1', () => {
    const a = assembleAsk({ ...base, image: { dataUrl: DATA } });
    const last = a.messages.at(-1);
    expect(last?.role).toBe('user');
    expect(last?.content[0]).toEqual({ kind: 'image', dataUrl: DATA });
    const text = last?.content
      .slice(1)
      .map((p) => (p.kind === 'text' ? p.text : ''))
      .join('');
    expect(text).toContain(IMAGE_LEAD);
    expect(text).toContain(IMAGE_QUESTION);
    expect(a.plan.imageCount).toBe(1);
    // 历史里只留文字：userText 不含图片数据
    expect(a.userText).not.toContain('base64');
  });

  it('有问题时用用户的问题；图片不计入文本预算（估算与不带图时只差那一句说明）', () => {
    const withImg = assembleAsk({ ...base, question: '这张图表说明了什么？', image: { dataUrl: DATA } });
    const without = assembleAsk({ ...base, question: '这张图表说明了什么？' });
    expect(withImg.userText).toContain('这张图表说明了什么？');
    expect(withImg.userText).not.toContain(IMAGE_QUESTION);
    expect(without.plan.imageCount).toBe(0);
    expect(withImg.plan.budget).toEqual(without.plan.budget);
    expect(withImg.plan.estimatedInputTokens - without.plan.estimatedInputTokens).toBeLessThan(100);
  });
});
