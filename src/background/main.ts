import { browser } from 'wxt/browser';
import { reconcileSentinel } from './scripts';

// 后台入口：监听器必须在顶层同步挂上，Service Worker 被唤醒时才收得到事件
export function startBackground(): void {
  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  browser.runtime.onInstalled.addListener(() => void reconcileSentinel());
  browser.runtime.onStartup.addListener(() => void reconcileSentinel());
}
