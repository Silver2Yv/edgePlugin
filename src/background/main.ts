import { browser } from 'wxt/browser';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import { migrateSettings } from '@/core/domain/settings';
import { SETTINGS_KEY } from '@/platform/settings-store';
import { createBackground } from './app';
import { browserDeps } from './browser-deps';
import { MENU_ITEMS } from './commands';
import { injectSentinelIntoOpenTabs, reconcileSentinel } from './scripts';

const warn = (what: string) => (e: unknown) =>
  console.warn(`[后台] ${what}`, e instanceof Error ? e.name : e);

/** 右键菜单（A8）：安装、更新时重建；菜单项随扩展保存，不必每次唤醒都建 */
function createMenus(): void {
  browser.contextMenus.removeAll(() => {
    for (const m of MENU_ITEMS)
      browser.contextMenus.create({ id: m.id, title: m.title, contexts: m.contexts });
  });
}

/** 站点规则（4.1）有没有变；读不出的一边按空规则比较 */
const sitesOf = (raw: unknown) => {
  const r = migrateSettings(raw);
  return JSON.stringify(r.ok ? r.settings.sites : []);
};

// 后台入口：监听器必须在顶层同步挂上，Service Worker 被唤醒时才收得到事件
export function startBackground(): void {
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  browser.runtime.onInstalled.addListener((details) => {
    createMenus();
    void reconcileSentinel().catch(warn('哨兵注册失败'));
    const injected = injectSentinelIntoOpenTabs();
    // 首次安装后自动打开欢迎页（L1）；更新、浏览器升级时不打开。补注入的结果留给欢迎页提示刷新（L5）
    if (details.reason === 'install') {
      void browser.tabs
        .create({ url: browser.runtime.getURL('/welcome.html') })
        .catch(warn('打开欢迎页失败'));
      void injected
        .then((r) => browser.storage.session.set({ [SESSION_KEYS.installOpenTabs]: r }))
        .catch(warn('向已开网页注入哨兵失败'));
    } else {
      void injected.catch(warn('向已开网页注入哨兵失败'));
    }
  });
  browser.runtime.onStartup.addListener(() => void reconcileSentinel().catch(warn('哨兵注册失败')));

  // 每次唤醒都是新进程：新的 workerEpoch，启动扫描把上个进程留下的未终结任务标 interrupted
  const app = createBackground(browserDeps());
  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    void app.onMessage(raw, sender).then(sendResponse, () => sendResponse({ ok: false, reason: 'invalid' }));
    return true;
  });
  browser.runtime.onConnect.addListener((port) => app.onConnect(port));
  // 快捷键与右键：处理函数里要开侧边栏的当场同步 open（规则 10），不在这里包任何异步
  browser.commands.onCommand.addListener((command, tab) => app.onCommand(command, tab));
  browser.contextMenus.onClicked.addListener((info, tab) => app.onMenuClicked(info, tab));
  browser.tabs.onRemoved.addListener((tabId) => void app.onTabRemoved(tabId));
  // 站点规则变更立即生效（4.1、D-01）：后台策略层马上拦截，哨兵注册表随之对账（已开网页下次加载生效）
  browser.storage.onChanged.addListener((changes, area) => {
    const c = area === 'local' ? changes[SETTINGS_KEY] : undefined;
    if (!c) return;
    const changed = sitesOf(c.oldValue) !== sitesOf(c.newValue);
    app.onSettingsChanged(changed);
    if (changed) void reconcileSentinel().catch(warn('哨兵注册对账失败'));
  });
}
