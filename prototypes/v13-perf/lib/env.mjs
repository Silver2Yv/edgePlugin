// 启动带扩展的持久化浏览器上下文（CfT / 真实 Edge），以及不带扩展的对照上下文；
// 写设置（指向模拟中转站）。做法与 tests/e2e/fixtures.ts、page-helpers.ts 一致。
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

export const ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const EXTENSION_PATH = resolve(ROOT, '.output', 'chrome-mv3');
export const EXTENSION_ID = 'pkahgpgifechjgdpecaebajnocgcnnnd';

/**
 * src/core/domain/settings.ts 里的 DEFAULT_SETTINGS 的最小等价副本。
 * 没有直接 import 那个文件：它内部用的是无扩展名相对导入（给 Vite/tsc 的 bundler 模式用），
 * Node 原生跑 .ts（本脚本不经 wxt/vite，是纯 node 直接执行）要求相对导入带扩展名，
 * 跨好几层文件去改会牵连到产品代码，所以这里手写一份只含本脚本需要字段的默认值，
 * 字段取值与 2026-11-21 的 src/core/domain/settings.ts DEFAULT_SETTINGS 保持一致。
 */
const DEFAULT_SETTINGS = {
  version: 1,
  connections: [],
  sites: [],
  customActions: [],
  toolbarActions: ['ask', 'explain', 'save'],
  hiddenActions: [],
  promptOverrides: {},
  reply: { lengthTier: 'normal', language: 'auto', thinking: 'off' },
  context: { speedSoftBudgetRatio: 0.5, summaryReadRatio: 0.3, defaultTier: 'nearby' },
  float: { placement: 'nearSelection' },
  suggestions: { model: true, rules: true },
  updates: { autoCheck: false },
};

const EDGE = process.env.E2E_BROWSER === 'msedge';

/** 持久化上下文可能拿不到 context.browser()（取决于启动方式），改用 userAgent 兜底探测版本 */
async function detectVersion(context) {
  const b = context.browser();
  if (b) return b.version();
  const page = await context.newPage();
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => 'unknown');
  await page.close();
  return ua;
}

/** 带扩展的持久化上下文；serviceWorker 等注册完哨兵再返回，与 e2e fixtures 一致 */
export async function launchWithExtension() {
  const context = await chromium.launchPersistentContext('', {
    channel: EDGE ? 'msedge' : 'chromium',
    ...(EDGE ? { headless: false } : {}),
    ...(!EDGE && process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  const serviceWorker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const until = Date.now() + 10_000;
  for (;;) {
    // 回调在 Service Worker 里执行，那里的全局是 chrome（运行时存在，这里是 .mjs，无需类型声明）
    const n = await serviceWorker.evaluate(
      async () => (await chrome.scripting.getRegisteredContentScripts()).length,
    );
    if (n > 0) break;
    if (Date.now() > until) throw new Error('哨兵注册超时');
    await new Promise((r) => setTimeout(r, 50));
  }
  return { context, serviceWorker, browserVersion: await detectVersion(context) };
}

/** 不带扩展的对照上下文（基线场景：扩展禁用） */
export async function launchWithoutExtension() {
  const context = await chromium.launchPersistentContext('', {
    channel: EDGE ? 'msedge' : 'chromium',
    ...(EDGE ? { headless: false } : {}),
    ...(!EDGE && process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
  });
  return { context, browserVersion: await detectVersion(context) };
}

export const CONNECTION_ID = 'v13-conn-0001';
export const MODEL_NAME = 'mock-flash';
export const MODEL_REF = { connectionId: CONNECTION_ID, model: MODEL_NAME };

export function connectionTo(relayUrl, mode = 'ok') {
  return {
    id: CONNECTION_ID,
    name: '模拟中转站',
    preset: 'custom',
    baseUrl: mode === 'ok' ? `${relayUrl}/v1` : `${relayUrl}/m/${mode}/v1`,
    apiKey: 'v13-perf-fake-key',
    headers: {},
    interfaceType: 'chatCompletions',
    stream: true,
    extraParams: {},
    configVersion: 1,
  };
}

export function settingsFor(relayUrl, mode = 'ok') {
  const conn = connectionTo(relayUrl, mode);
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    connections: [conn],
    defaultModel: { connectionId: conn.id, model: 'mock-flash' },
  };
}

export const writeSettings = (sw, settings) =>
  sw.evaluate((v) => chrome.storage.local.set({ settings: v }), settings);
