// 工具栏定位（5.2）：放在选区最后一行矩形下方，放不下翻到上方；水平方向夹在视口内。
import { describe, expect, it } from 'vitest';
import { computeToolbarPosition } from '@/page/toolbar';

const VIEWPORT = { width: 1000, height: 800 };
const SIZE = { width: 120, height: 40 };

describe('computeToolbarPosition', () => {
  it('下方放得下：放在矩形下方，左对齐矩形左边', () => {
    const rect = { left: 100, right: 200, top: 300, bottom: 320 };
    expect(computeToolbarPosition(rect, SIZE, VIEWPORT)).toEqual({ left: 100, top: 328 });
  });

  it('下方放不下但上方放得下：翻到上方', () => {
    const rect = { left: 100, right: 200, top: 760, bottom: 780 };
    expect(computeToolbarPosition(rect, SIZE, VIEWPORT)).toEqual({ left: 100, top: 712 });
  });

  it('水平方向超出视口右边：夹到视口内', () => {
    const rect = { left: 950, right: 990, top: 300, bottom: 320 };
    expect(computeToolbarPosition(rect, SIZE, VIEWPORT).left).toBe(VIEWPORT.width - SIZE.width - 8);
  });

  it('水平方向超出视口左边：夹到视口内', () => {
    const rect = { left: -50, right: 10, top: 300, bottom: 320 };
    expect(computeToolbarPosition(rect, SIZE, VIEWPORT).left).toBe(8);
  });
});
