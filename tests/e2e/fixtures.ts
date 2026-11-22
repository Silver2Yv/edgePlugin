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

/**
 * 每个用例都是全新的用户目录，扩展算「首次安装」，后台会自动打开欢迎页（L1）并把它切到前台。
 * 用例不关心欢迎页时先把它关掉：否则它抢走活动标签页，后面依赖前台、焦点、「当前标签页」的用例会受影响。
 * 自己起浏览器的用例（不走这里的 context 夹具）在拿到上下文后也要调一次
 */
export async function dismissWelcome(context: BrowserContext): Promise<void> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await base.expect
    .poll(
      () =>
        sw.evaluate(async () => {
          const tabs = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] });
          const welcome = tabs.filter((c) => c.documentUrl?.endsWith('/welcome.html'));
          await Promise.all(welcome.map((c) => chrome.tabs.remove(c.tabId)));
          return welcome.length;
        }),
      { message: '首次安装自动打开的欢迎页出现并被关掉', timeout: 10_000 },
    )
    .toBeGreaterThan(0);
}

export const test = base.extend<{ context: BrowserContext; serviceWorker: Worker; keepWelcome: boolean }>({
  /** 欢迎页的用例设为 true：保留首次安装自动打开的欢迎页 */
  keepWelcome: [false, { option: true }],
  context: async ({ keepWelcome }, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: EDGE ? 'msedge' : 'chromium',
      ...(EDGE ? { headless: false } : {}),
      // 本机自带 Chromium 无法启动时，可用 E2E_CHROMIUM_PATH 指向一份可用的副本
      ...(!EDGE && process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    if (!keepWelcome) await dismissWelcome(context);
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
