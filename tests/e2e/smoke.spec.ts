import type { browser } from 'wxt/browser';
import { EXTENSION_ID, expect, test } from './fixtures';

// evaluate 的回调在扩展 Service Worker 里执行，那里的全局是 chrome
declare const chrome: typeof browser;

test('扩展能加载：固定 ID、后台运行、哨兵已动态注册', async ({ serviceWorker }) => {
  expect(new URL(serviceWorker.url()).host).toBe(EXTENSION_ID);
  await expect
    .poll(() => serviceWorker.evaluate(() => chrome.scripting.getRegisteredContentScripts()))
    .toEqual([expect.objectContaining({ id: 'sentinel', allFrames: true })]);
});
