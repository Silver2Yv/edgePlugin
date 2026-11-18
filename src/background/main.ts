import { browser } from 'wxt/browser';
import { createBackground } from './app';
import { browserDeps } from './browser-deps';
import { reconcileSentinel } from './scripts';

// 后台入口：监听器必须在顶层同步挂上，Service Worker 被唤醒时才收得到事件
export function startBackground(): void {
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  browser.runtime.onInstalled.addListener(() => void reconcileSentinel());
  browser.runtime.onStartup.addListener(() => void reconcileSentinel());

  // 每次唤醒都是新进程：新的 workerEpoch，启动扫描把上个进程留下的未终结任务标 interrupted
  const app = createBackground(browserDeps());
  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    void app.onMessage(raw, sender).then(sendResponse, () => sendResponse({ ok: false, reason: 'invalid' }));
    return true;
  });
  browser.runtime.onConnect.addListener((port) => app.onConnect(port));
  browser.tabs.onRemoved.addListener((tabId) => void app.onTabRemoved(tabId));
}
