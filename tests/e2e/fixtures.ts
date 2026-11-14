import { resolve } from 'node:path';
import { type BrowserContext, test as base, chromium, type Worker } from '@playwright/test';

export const EXTENSION_PATH = resolve(import.meta.dirname, '..', '..', '.output', 'chrome-mv3');
export const EXTENSION_ID = 'pkahgpgifechjgdpecaebajnocgcnnnd';

// 加载解压缩扩展的持久化上下文。扩展只能在 Playwright 自带 Chromium 中加载（channel: 'chromium'）。
export const test = base.extend<{ context: BrowserContext; serviceWorker: Worker }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture 约定
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      // 本机自带 Chromium 无法启动时，可用 E2E_CHROMIUM_PATH 指向一份可用的副本
      ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
});

export const expect = test.expect;
