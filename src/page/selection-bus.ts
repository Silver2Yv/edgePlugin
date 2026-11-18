// 哨兵与阅读器之间的小事件总线（ARCHITECTURE 5.1「两段之间」）：
// 同一网页同一隔离环境，靠全局符号共享状态，不经过后台。
// 这里只传「最近一次选区矩形」——阅读器显示小窗时用它定位，自己并不知道选中的文字。

const KEY = Symbol.for('readingAssistant.selectionBus');

interface Bus {
  rect: DOMRect | null;
}

function bus(): Bus {
  const g = globalThis as unknown as Record<symbol, Bus | undefined>;
  if (g[KEY] === undefined) g[KEY] = { rect: null };
  return g[KEY];
}

/** 哨兵在选区变化时调用：显示工具栏时传矩形，隐藏 / 选区消失时传 null */
export function setLastSelectionRect(rect: DOMRect | null): void {
  bus().rect = rect;
}

/** 阅读器显示小窗时读取，定位用；没有则返回 null（退回右下角） */
export function getLastSelectionRect(): DOMRect | null {
  return bus().rect;
}
