// 小窗定位（5.3）：贴着最近一次选区定位，放不下翻到上方并夹在视口内；没有选区时放右下角。
import { describe, expect, it } from 'vitest';
import { computeFloatPosition } from '@/page/float-host';

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
