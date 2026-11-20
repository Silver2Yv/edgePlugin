import { resolve } from 'node:path';
import { type BrowserContext, test as base, chromium, type Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';

// evaluate 的回调在 Service Worker 里执行，那里的全局是 chrome
declare const chrome: typeof browser;

export const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', '.output', 'chrome-mv3');
export const EXTENSION_ID = 'pkahgpgifechjgdpecaebajnocgcnnnd';

// 加载解压缩扩展的持久化上下文。默认用 Playwright 自带 Chromium（channel: 'chromium'）；
// E2E_BROWSER=msedge 时用本机安装的 Edge（有界面运行，Edge 157 实测可加载解压缩扩展）
const EDGE = process.env.E2E_BROWSER === 'msedge';

export const test = base.extend<{ context: BrowserContext; serviceWorker: Worker }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture 约定
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: EDGE ? 'msedge' : 'chromium',
      ...(EDGE ? { headless: false } : {}),
      // 本机自带 Chromium 无法启动时，可用 E2E_CHROMIUM_PATH 指向一份可用的副本
      ...(!EDGE && process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    // 哨兵是安装后异步注册的（要先读设置算黑名单排除项）；注册完成前打开的网页没有哨兵，
    // 用例一开页就划词会偶发等不到工具栏，所以交出去之前先等注册完成
    await base
      .expect(async () => {
        const n = await sw.evaluate(
          async () => (await chrome.scripting.getRegisteredContentScripts()).length,
        );
        base.expect(n).toBeGreaterThan(0);
      })
      .toPass({ timeout: 10_000 });
    await use(sw);
  },
});

export const expect = test.expect;
