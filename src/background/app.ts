// 后台装配：各模块共用一份运行时状态。监听器的注册在 main.ts（顶层同步）。
import { createConv } from './conv';
import type { BackgroundDeps } from './deps';
import { createFloatHost } from './float-host';
import { createHub } from './hub';
import { createIntents } from './intents';
import { createJobs } from './jobs';
import { createStore } from './store';

export type Background = ReturnType<typeof createBackground>;

export function createBackground(deps: BackgroundDeps) {
  const store = createStore(deps.session, deps.now, deps.newToken);
  const hub = createHub();
  const host = createFloatHost(deps, store);
  const jobs = createJobs(deps, store, hub);
  return {
    /** 启动扫描完成 */
    ready: jobs.ready,
    epoch: jobs.epoch,
    onMessage: createIntents(deps, store, hub, host),
    onConnect: createConv(deps, store, hub, host, jobs),
    /** 标签页关闭：小窗绑定、选区、令牌一并作废；在途任务照常跑完（规则 2） */
    async onTabRemoved(tabId: number): Promise<void> {
      host.forget(tabId);
      hub.forgetTab(tabId);
      jobs.forgetTab(tabId);
      await store.forgetTab(tabId);
    },
  };
}
