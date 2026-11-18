// 对话端口的订阅登记（5.5）：按标签页分组。推送失败（端口已断）就移除，不影响任务（规则 2）。
import type { BackgroundToClient } from '@/core/domain/messages';
import type { ConvPort } from './deps';

export type Hub = ReturnType<typeof createHub>;

export function createHub() {
  const byTab = new Map<number, Set<ConvPort>>();

  function unsubscribe(port: ConvPort): void {
    for (const [tabId, set] of byTab) {
      set.delete(port);
      if (set.size === 0) byTab.delete(tabId);
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
      const set = byTab.get(tabId) ?? new Set<ConvPort>();
      set.add(port);
      byTab.set(tabId, set);
    },
    hasSubscribers: (tabId: number) => (byTab.get(tabId)?.size ?? 0) > 0,
    toTab(tabId: number, msg: BackgroundToClient): void {
      for (const port of byTab.get(tabId) ?? []) post(port, msg);
    },
    forgetTab(tabId: number): void {
      byTab.delete(tabId);
    },
  };
}
