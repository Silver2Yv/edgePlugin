// 小窗定位（5.3）：贴着最近一次选区定位，放不下翻到上方并夹在视口内；没有选区时放右下角。
import { describe, expect, it } from 'vitest';
import { FLOAT_LIMITS } from '@/core/domain/float';
import { clampRect, computeFloatPosition } from '@/page/float-host';

const VIEWPORT = { width: 1200, height: 900 };
const SIZE = { width: 380, height: 480 };

describe('computeFloatPosition', () => {
  it('没有选区：放右下角', () => {
    expect(computeFloatPosition(null, SIZE, VIEWPORT)).toEqual({
      left: VIEWPORT.width - SIZE.width - 16,
      top: VIEWPORT.height - SIZE.height - 16,
    });
  });

  it('有选区且下方放得下：贴着选区左边、下方', () => {
    const rect = { left: 100, right: 200, top: 100, bottom: 120 };
    expect(computeFloatPosition(rect, SIZE, VIEWPORT)).toEqual({ left: 100, top: 136 });
  });

  it('下方放不下：翻到上方', () => {
    const rect = { left: 100, right: 200, top: 850, bottom: 870 };
    const pos = computeFloatPosition(rect, SIZE, VIEWPORT);
    expect(pos.top).toBe(850 - SIZE.height - 16);
  });

  it('选区靠右：水平方向夹在视口内', () => {
    const rect = { left: 1150, right: 1190, top: 100, bottom: 120 };
    const pos = computeFloatPosition(rect, SIZE, VIEWPORT);
    expect(pos.left).toBe(VIEWPORT.width - SIZE.width - 16);
  });
});

describe('clampRect：拖动 / 缩放后夹回视口（5.3 拖动与缩放）', () => {
  it('尺寸与位置都在视口内：原样返回', () => {
    const rect = { left: 100, top: 100, width: 380, height: 480 };
    expect(clampRect(rect, VIEWPORT)).toEqual(rect);
  });

  it('缩放到小于最小尺寸：夹到最小 200×160', () => {
    const rect = { left: 100, top: 100, width: 50, height: 50 };
    const r = clampRect(rect, VIEWPORT);
    expect(r.width).toBe(FLOAT_LIMITS.minWidth);
    expect(r.height).toBe(FLOAT_LIMITS.minHeight);
  });

  it('拖动超出视口：位置夹回边界', () => {
    const rect = { left: -500, top: -500, width: 380, height: 480 };
    const r = clampRect(rect, VIEWPORT);
    expect(r.left).toBe(16);
    expect(r.top).toBe(16);
  });

  it('拖到右下角之外：夹到视口右下边界内', () => {
    const rect = { left: 2000, top: 2000, width: 380, height: 480 };
    const r = clampRect(rect, VIEWPORT);
    expect(r.left).toBe(VIEWPORT.width - 380 - 16);
    expect(r.top).toBe(VIEWPORT.height - 480 - 16);
  });

  it('缩放变大超过视口：尺寸夹到视口可用空间，位置随之收回', () => {
    const rect = { left: 16, top: 16, width: 3000, height: 3000 };
    const r = clampRect(rect, VIEWPORT);
    expect(r.width).toBe(VIEWPORT.width - 32);
    expect(r.height).toBe(VIEWPORT.height - 32);
    expect(r.left).toBe(16);
    expect(r.top).toBe(16);
  });
});
