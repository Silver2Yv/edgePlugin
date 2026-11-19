import { browser } from 'wxt/browser';
import { createBackground } from './app';
import { browserDeps } from './browser-deps';
import { injectSentinelIntoOpenTabs, reconcileSentinel } from './scripts';

const warn = (what: string) => (e: unknown) =>
  console.warn(`[后台] ${what}`, e instanceof Error ? e.name : e);

// 后台入口：监听器必须在顶层同步挂上，Service Worker 被唤醒时才收得到事件
export function startBackground(): void {
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  browser.runtime.onInstalled.addListener(() => {
    void reconcileSentinel().catch(warn('哨兵注册失败'));
    void injectSentinelIntoOpenTabs().catch(warn('向已开网页注入哨兵失败'));
  });
  browser.runtime.onStartup.addListener(() => void reconcileSentinel().catch(warn('哨兵注册失败')));

  // 每次唤醒都是新进程：新的 workerEpoch，启动扫描把上个进程留下的未终结任务标 interrupted
  const app = createBackground(browserDeps());
  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    void app.onMessage(raw, sender).then(sendResponse, () => sendResponse({ ok: false, reason: 'invalid' }));
    return true;
  });
  browser.runtime.onConnect.addListener((port) => app.onConnect(port));
  browser.tabs.onRemoved.addListener((tabId) => void app.onTabRemoved(tabId));
}
