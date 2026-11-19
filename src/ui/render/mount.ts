/**
 * 小窗回答区的挂载器：把 streaming-renderer 产出的块节点，按稳定 key 增量挂载进
 * 真实容器 DOM，并接上节流调度（scheduler.ts）与用户选区保护（selection-guard.ts）。
 *
 * 只做 insertBefore / replaceChild / remove 这类定点 DOM 操作，不重建容器、不调用
 * scrollIntoView / focus / scrollTo，天然满足“不自动滚动、不抢焦点”。
 *
 * 调用方见 src/ui/FloatApp.tsx：容器 div 交给 Preact 的 ref，之后其子节点完全由本模块
 * 管理，Preact 不再对它做子节点 diff（JSX 里不给这个 div 写 children）。
 */
import { createMarkdownIt } from './markdown-it-setup';
import { createUpdateScheduler } from './scheduler';
import { createSelectionGuard, type SelectionGuard } from './selection-guard';
import { createStreamingRenderer, type RenderedBlock } from './streaming-renderer';

export interface AnswerRendererOptions {
  /**
   * 替换默认的选区保护实现；仅供单测注入可控的 intersects/subscribe，
   * 不依赖 happy-dom 并未实现的真实 Selection/Range API（见 selection-guard.ts）。
   * 生产代码不传，使用真实浏览器 Selection。
   */
  guard?: SelectionGuard;
}

export interface AnswerRenderer {
  /** 增量更新：走节流调度（scheduler.ts），不保证本次调用后立刻生效 */
  scheduleUpdate(text: string, allowedIds: ReadonlySet<string>): void;
  /** 流结束的一次完整校正：取消尚未执行的节流更新，立即同步执行 */
  finalize(text: string, allowedIds: ReadonlySet<string>): void;
  /** 新任务 / 新尝试：清空缓存、清空容器、取消尚未执行的更新；不做选区保护（整体清空） */
  reset(): void;
  /** 组件卸载：取消尚未执行的更新，移除事件监听 */
  destroy(): void;
}

export function createAnswerRenderer(
  container: HTMLElement,
  options: AnswerRendererOptions = {},
): AnswerRenderer {
  const doc = container.ownerDocument;
  const md = createMarkdownIt();
  const renderer = createStreamingRenderer({ md, document: doc });
  const scheduler = createUpdateScheduler();
  const guard = options.guard ?? createSelectionGuard(doc);
  /** key → 当前真正挂载在容器里的节点；选区保护期间会滞后于 renderer 刚产出的节点 */
  const attached = new Map<number, Element>();

  function mount(blocks: readonly RenderedBlock[]): void {
    const freshKeys = new Set(blocks.map((b) => b.key));
    for (const [key, node] of [...attached]) {
      if (freshKeys.has(key)) continue;
      guard.forget(key);
      node.remove();
      attached.delete(key);
    }

    let anchor: ChildNode | null = container.firstChild;
    for (const block of blocks) {
      const old = attached.get(block.key);
      if (old === block.node) {
        guard.forget(block.key);
        anchor = old.nextSibling;
        continue;
      }
      if (old) {
        const replaceNow = () => {
          if (old.parentNode === container) container.replaceChild(block.node, old);
          attached.set(block.key, block.node);
        };
        if (guard.protect(block.key, old, replaceNow)) {
          // 选区覆盖这个块：这一轮保留旧节点，等 selectionchange 后由 guard 补上替换
          anchor = old.nextSibling;
          continue;
        }
        container.replaceChild(block.node, old);
        attached.set(block.key, block.node);
        anchor = block.node.nextSibling;
        continue;
      }
      container.insertBefore(block.node, anchor);
      attached.set(block.key, block.node);
      anchor = block.node.nextSibling;
    }
  }

  return {
    scheduleUpdate(text, allowedIds) {
      scheduler.request(text.length, () => mount(renderer.update(text, allowedIds)));
    },
    finalize(text, allowedIds) {
      scheduler.cancel();
      mount(renderer.finalize(text, allowedIds));
    },
    reset() {
      scheduler.cancel();
      guard.clear();
      for (const node of attached.values()) node.remove();
      attached.clear();
      renderer.reset();
    },
    destroy() {
      scheduler.cancel();
      guard.destroy();
    },
  };
}
