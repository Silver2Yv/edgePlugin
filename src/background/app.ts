// 后台装配：各模块共用一份运行时状态。监听器的注册在 main.ts（顶层同步）。
import { createConv } from './conv';
import type { BackgroundDeps, SenderLike } from './deps';
import { createFloatHost } from './float-host';
import { createHub } from './hub';
import { createIntents } from './intents';
import { createJobs } from './jobs';
import { createOptions } from './options';
import { senderRole } from './roles';
import { createStore } from './store';

export type Background = ReturnType<typeof createBackground>;

const errName = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : 'unknown');

export function createBackground(deps: BackgroundDeps) {
  const store = createStore(deps.session, deps.now, deps.newToken);
  const hub = createHub();
  const host = createFloatHost(deps, store);
  const jobs = createJobs(deps, store, hub);
  const intents = createIntents(deps, store, hub, host);
  const options = createOptions(deps);
  // 每次启动都收紧一次（5.11）：顶层同步路径里发起，不 await，不阻塞监听器注册；
  // 失败不当作安全保证，设置页写 Key 前会再调一次 settings/ensureLocked 确认
  void deps.lockStorage().catch((e: unknown) => deps.log('storage/lockFailed', { error: errName(e) }));
  return {
    /** 启动扫描完成 */
    ready: jobs.ready,
    epoch: jobs.epoch,
    onMessage(raw: unknown, sender: SenderLike) {
      return senderRole(sender, deps.self) === 'options' ? options(raw, sender) : intents(raw, sender);
    },
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
