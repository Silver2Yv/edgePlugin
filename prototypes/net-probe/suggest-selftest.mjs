// 问题建议页自测：做完第 1 篇后让后台被回收，再看第 2、3 篇能否生成建议。
// Playwright 连着后台时后台不会因空闲被回收，所以用调试协议直接停掉后台，模拟真机上空闲 30 秒后的回收。
// Key 从 Windows 用户环境变量读，只经过内存，不写文件、不打印。需要能连上公司中转站。
// 用法：node prototypes/net-probe/suggest-selftest.mjs
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { getEndpoint1 } from '../suggest-hit/scripts/lib/keys.mjs';

const ext = resolve(import.meta.dirname, 'extension');
const ep = getEndpoint1();

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const base = `chrome-extension://${new URL(sw.url()).host}`;
  const diag = await ctx.newPage();
  await diag.goto(`${base}/diag.html`);
  await diag.fill('#baseUrl', ep.baseUrl);
  await diag.fill('#key', ep.key);
  await diag.fill('#model', ep.model);
  await diag.click('#save');
  await diag.close();

  const page = await ctx.newPage();
  await page.goto(`${base}/suggest.html`);
  const readyOf = () => page.textContent('#ready');
  const waitReady = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = await readyOf();
      if (!t.includes('生成中')) return t;
      await page.waitForTimeout(500);
    }
    return `超时：${await readyOf()}`;
  };
  const answer = async () => {
    await page.click('#ask');
    await page.fill('#q', '自测问题');
    await page.click('#submit');
    await page.click('[data-hit="0"]');
  };

  console.log('第 1 篇：', await waitReady(20_000));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  // 修复前此后第 2、3 篇一直停在「生成中」，可作为停掉生效的证据（Playwright 不会为此触发 close 事件）
  await cdp.send('ServiceWorker.stopAllWorkers');
  await page.waitForTimeout(1000);
  console.log('已停掉后台');
  await answer();
  console.log('第 2 篇：', await waitReady(20_000));
  await answer();
  console.log('第 3 篇（紧接着）：', await waitReady(20_000));
} finally {
  await ctx.close();
}
