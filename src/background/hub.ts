// 对话端口的订阅登记（5.5）：按标签页分组。推送失败（端口已断）就移除，不影响任务（规则 2）。
// 另记已握手的侧边栏端口（按窗口）：划词去向要在点击的同步段里知道本窗口侧边栏开没开（5.4、route.ts）。
// 面板关掉时端口断开随之移除；后台被回收后这张表是空的，面板重连握手后再登记。
import type { BackgroundToClient } from '@/core/domain/messages';
import type { ConvPort } from './deps';

export type Hub = ReturnType<typeof createHub>;

/**
 * onSubscriberChange（contract-v1.5 增量，live）：某标签页的订阅者数量在 0 与正数之间跨越时回调一次
 * （重复订阅同一标签页、同一端口换标签页都只在真正跨越时触发）。调用方据此广播 live/toggle，
 * 告诉这个标签页的哨兵开始/停止实时上报选中的文字（没人看着就不上报）
 */
export function createHub(onSubscriberChange?: (tabId: number, hasSubscribers: boolean) => void) {
  const byTab = new Map<number, Set<ConvPort>>();
  const panels = new Map<number, Set<ConvPort>>();
  /** 等某个窗口的侧边栏握手的回调（route.ts 的 panelOpenIn） */
  const panelWaiters = new Map<number, Set<() => void>>();

  function unsubscribe(port: ConvPort): void {
    for (const [tabId, set] of byTab) {
      if (!set.delete(port)) continue;
      if (set.size === 0) {
        byTab.delete(tabId);
        onSubscriberChange?.(tabId, false);
      }
    }
  }

  function post(port: ConvPort, msg: BackgroundToClient): void {
    try {
      port.postMessage(msg);
    } catch {
      unsubscribe(port);
    }
  }

  return {
    post,
    unsubscribe,
    subscribe(tabId: number, port: ConvPort): void {
      const set = byTab.get(tabId);
      const hadNone = !set || set.size === 0;
      const next = set ?? new Set<ConvPort>();
      next.add(port);
      byTab.set(tabId, next);
      if (hadNone) onSubscriberChange?.(tabId, true);
    },
    hasSubscribers: (tabId: number) => (byTab.get(tabId)?.size ?? 0) > 0,
    toTab(tabId: number, msg: BackgroundToClient): void {
      for (const port of byTab.get(tabId) ?? []) post(port, msg);
    },
    forgetTab(tabId: number): void {
      byTab.delete(tabId);
    },
    addPanel(windowId: number, port: ConvPort): void {
      const set = panels.get(windowId) ?? new Set<ConvPort>();
      set.add(port);
      panels.set(windowId, set);
      for (const done of panelWaiters.get(windowId) ?? []) done();
    },
    /** 等这个窗口的侧边栏握手：已登记立即为真，超时为假 */
    waitPanel(windowId: number, ms: number): Promise<boolean> {
      if ((panels.get(windowId)?.size ?? 0) > 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const set = panelWaiters.get(windowId) ?? new Set<() => void>();
        panelWaiters.set(windowId, set);
        const finish = (ok: boolean) => {
          clearTimeout(timer);
          set.delete(done);
          if (set.size === 0) panelWaiters.delete(windowId);
          resolve(ok);
        };
        const done = () => finish(true);
        const timer = setTimeout(() => finish(false), ms);
        set.add(done);
      });
    },
    removePanel(windowId: number, port: ConvPort): void {
      const set = panels.get(windowId);
      set?.delete(port);
      if (set?.size === 0) panels.delete(windowId);
    },
    panelsIn: (windowId: number): readonly ConvPort[] => [...(panels.get(windowId) ?? [])],
    hasPanel: (windowId: number) => (panels.get(windowId)?.size ?? 0) > 0,
  };
}
