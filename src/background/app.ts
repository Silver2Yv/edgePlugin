// 后台装配：各模块共用一份运行时状态。监听器的注册在 main.ts（顶层同步）。

import { createCitations } from './citations';
import { type CommandTab, createCommands, type MenuInfo } from './commands';
import { createConv } from './conv';
import type { BackgroundDeps, SenderLike } from './deps';
import { createFloatHost } from './float-host';
import { createHistory } from './history';
import { createHub } from './hub';
import { createIntents } from './intents';
import { createJobs } from './jobs';
import { createOptions } from './options';
import { createPages } from './pages';
import { senderRole } from './roles';
import { createRoute } from './route';
import { createStore } from './store';
import { createSummary } from './summary';

export type Background = ReturnType<typeof createBackground>;

const errName = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : 'unknown');

export function createBackground(deps: BackgroundDeps) {
  const store = createStore(deps.session, deps.now, deps.newToken);
  const hub = createHub();
  const host = createFloatHost(deps, store);
  const pages = createPages(deps);
  const jobs = createJobs(deps, store, hub, pages);
  const history = createHistory(deps, jobs);
  // 引用跳回与「总结本页」完整版（cite 块）
  const citations = createCitations(deps, jobs);
  const summary = createSummary(deps, history, pages, hub);
  const route = createRoute(deps, store, hub, host);
  const intents = createIntents(deps, store, hub, host, pages, route, jobs, { summary, citations });
  const commands = createCommands(deps, store, hub, host, jobs, route, { summary });
  const options = createOptions(deps);
  // 每次启动都收紧一次（5.11）：顶层同步路径里发起，不 await，不阻塞监听器注册；
  // 失败不当作安全保证，设置页写 Key 前会再调一次 settings/ensureLocked 确认
  void deps.lockStorage().catch((e: unknown) => deps.log('storage/lockFailed', { error: errName(e) }));
  // 就绪状态的内存副本（点「问」时同步决定去向要用，见 route.ts）：被唤醒后尽快从 storage.session 补回
  void store.warmReadiness().catch((e: unknown) => deps.log('store/warmFailed', { error: errName(e) }));
  return {
    /** 启动扫描完成 */
    ready: jobs.ready,
    epoch: jobs.epoch,
    onMessage(raw: unknown, sender: SenderLike) {
      return senderRole(sender, deps.self) === 'options' ? options(raw, sender) : intents(raw, sender);
    },
    onConnect: createConv(deps, store, hub, host, jobs, history, { citations, summary }),
    /** 快捷键（commands.onCommand）：在监听器的同步段里调用，要开侧边栏的当场 open（规则 10） */
    onCommand: (command: string, tab: CommandTab | undefined) => commands.onCommand(command, tab),
    /** 右键菜单（contextMenus.onClicked）：同上 */
    onMenuClicked: (info: MenuInfo, tab: CommandTab | undefined) => commands.onMenuClicked(info, tab),
    /** 历史与上次总结（下一轮「总结本页完整版」读 lastSummary） */
    history,
    /** 诊断与单测：某标签页缓存的页面版本（V-04/V-06 的缓存失效证据） */
    cachedPageVersion: (tabId: number) => pages.cachedVersion(tabId),
    /**
     * 设置变更（storage.onChanged）。站点规则变了：页面缓存全部失效，已接单未发出的任务取消（4.1、D-01）；
     * 新的发问每次都读最新设置，所以改完立即生效。哨兵注册的对账在 main.ts（扩展接口）
     */
    onSettingsChanged(sitesChanged: boolean): void {
      if (!sitesChanged) return;
      pages.purge('policyChanged');
      const n = jobs.cancelPending();
      deps.log('settings/sitesChanged', { cancelledJobs: n });
      // 改成「不读取页面内容」的站点：库里该站的快照删掉、发送全文里的页面片段去掉（4.1）
      void deps
        .loadSettings()
        .then((r) => (r.ok ? history.purgeNoRead(r.settings) : undefined))
        .then((purged) => {
          if (purged && purged.snapshots + purged.messages > 0) deps.log('db/noReadPurged', purged);
        })
        .catch((e: unknown) => deps.log('db/purgeFailed', { error: errName(e) }));
    },
    /** 标签页关闭：小窗绑定、选区、令牌一并作废；在途任务照常跑完（规则 2） */
    async onTabRemoved(tabId: number): Promise<void> {
      pages.forgetTab(tabId);
      host.forget(tabId);
      hub.forgetTab(tabId);
      jobs.forgetTab(tabId);
      citations.forgetTab(tabId);
      summary.forgetTab(tabId);
      await store.forgetTab(tabId);
    },
  };
}
