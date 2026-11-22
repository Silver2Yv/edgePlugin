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

  it('选区本身（上下都）在视口外（超长选区最后一行远在屏幕下方）：夹到视口底部，不跟着超出（A5）', () => {
    const rect = { left: 100, right: 200, top: 1300, bottom: 1340 };
    expect(computeToolbarPosition(rect, SIZE, VIEWPORT)).toEqual({
      left: 100,
      top: VIEWPORT.height - SIZE.height - 8,
    });
  });

  it('多行选区最后一行贴近视口底部翻到上方时：贴着整个选区的上沿，不盖住选区前面几行（A5）', () => {
    // 选区从 y=200 一路往下选到最后一行 top=770/bottom=790：按最后一行翻上去会落在 730，
    // 正好盖住选区本身（从 200 开始）；传入选区上沿 200 后应该贴在选区上方 152
    const rect = { left: 100, right: 200, top: 770, bottom: 790 };
    const selectionTop = 200;
    expect(computeToolbarPosition(rect, SIZE, VIEWPORT, selectionTop)).toEqual({ left: 100, top: 152 });
  });

  it('不传选区上沿时退回按最后一行矩形（向后兼容）', () => {
    const rect = { left: 100, right: 200, top: 760, bottom: 780 };
    expect(computeToolbarPosition(rect, SIZE, VIEWPORT)).toEqual(
      computeToolbarPosition(rect, SIZE, VIEWPORT, rect.top),
    );
  });
});
