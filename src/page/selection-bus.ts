// 哨兵与阅读器之间的小事件总线（ARCHITECTURE 5.1「两段之间」）：
// 同一网页同一隔离环境，靠全局符号共享状态，不经过后台；网页脚本看不到隔离环境的全局。
// 传两样：最近一次选区矩形（阅读器给小窗定位）与这次选区的修订号（阅读器给选区补锚点时对号，
// 后台只采用修订号与 action/click 存下的那份一致的锚点）。

const KEY = Symbol.for('readingAssistant.selectionBus');

interface Bus {
  rect: DOMRect | null;
  /** 哨兵发出的最近一次 selection/ready 的修订号；没有选区时为 undefined */
  revision: number | undefined;
}

function bus(): Bus {
  const g = globalThis as unknown as Record<symbol, Bus | undefined>;
  if (g[KEY] === undefined) g[KEY] = { rect: null, revision: undefined };
  return g[KEY];
}

/** 哨兵在选区变化时调用：显示工具栏时传矩形与修订号，隐藏 / 选区消失时传 null */
export function setLastSelectionRect(rect: DOMRect | null, revision?: number): void {
  const b = bus();
  b.rect = rect;
  b.revision = rect === null ? undefined : revision;
}

/** 阅读器显示小窗时读取，定位用；没有则返回 null（退回右下角） */
export function getLastSelectionRect(): DOMRect | null {
  return bus().rect;
}

/** 阅读器给选区补锚点时读取：当前选区对应哪一次 selection/ready */
export function getLastSelectionRevision(): number | undefined {
  return bus().revision;
}
