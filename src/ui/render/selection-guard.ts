/**
 * 用户选区保护（5.10：“用户正在选中的块延迟替换，直到选区离开；不自动滚动、不抢焦点”）。
 *
 * 只负责判断“是否要延后一次节点替换”与“延后到什么时候补上”，不碰容器 DOM 的挂载顺序——
 * 挂载顺序由 src/ui/render/mount.ts 负责。本模块不调用 scrollIntoView / focus / scrollTo，
 * 也不修改选区本身。
 */

/** 当前浏览器选区是否与 node 存在交集；没有选区或选区是折叠的（只是光标，没有选中文字）都算否 */
export function selectionIntersectsNode(node: Node, doc: Document = document): boolean {
  const sel = doc.getSelection ? doc.getSelection() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    if (sel.getRangeAt(i).intersectsNode(node)) return true;
  }
  return false;
}

export interface SelectionGuard {
  /**
   * 请求替换 key 对应的旧节点。若旧节点包含当前选区：记下 apply，返回 true（调用方应
   * 保留旧节点，先不执行替换）；否则返回 false（调用方应立即执行替换）。
   */
  protect(key: number, oldNode: Node, apply: () => void): boolean;
  /** key 已经以其他方式处理（内容未变、已被移除等），丢弃其待替换记录 */
  forget(key: number): void;
  /** 丢弃全部待替换记录，不执行它们（整体重置时用，旧内容本来就要整体清空） */
  clear(): void;
  /** 停止监听选区变化（组件卸载时用） */
  destroy(): void;
}

export interface SelectionGuardOptions {
  /** 判断某节点当前是否被选区覆盖；默认用 selectionIntersectsNode（真实浏览器 Selection/Range） */
  intersects?: (node: Node) => boolean;
  /** 订阅“选区可能已变化，该重新检查待替换列表了”；默认监听 document 的 selectionchange。
   * 返回取消订阅函数。单测可注入手动触发，不依赖 happy-dom 并未实现的 Selection/Range API。 */
  subscribe?: (onChange: () => void) => () => void;
}

export function createSelectionGuard(
  doc: Document = document,
  options: SelectionGuardOptions = {},
): SelectionGuard {
  const intersects = options.intersects ?? ((node: Node) => selectionIntersectsNode(node, doc));
  const subscribe =
    options.subscribe ??
    ((onChange: () => void) => {
      doc.addEventListener('selectionchange', onChange);
      return () => doc.removeEventListener('selectionchange', onChange);
    });
  const pending = new Map<number, { node: Node; apply: () => void }>();

  function onSelectionChange(): void {
    for (const [key, entry] of [...pending]) {
      if (!intersects(entry.node)) {
        pending.delete(key);
        entry.apply();
      }
    }
  }
  const unsubscribe = subscribe(onSelectionChange);

  return {
    protect(key, oldNode, apply) {
      if (intersects(oldNode)) {
        pending.set(key, { node: oldNode, apply });
        return true;
      }
      pending.delete(key);
      return false;
    },
    forget(key) {
      pending.delete(key);
    },
    clear() {
      pending.clear();
    },
    destroy() {
      pending.clear();
      unsubscribe();
    },
  };
}
