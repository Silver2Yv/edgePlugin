// 本机自测：用 Playwright 加载诊断包，填入连接，跑快速测试（加 --long 再跑长任务），打印脱敏后的 Markdown。
// Key 从 Windows 用户环境变量读，只经过内存，不写文件、不打印。
// 用法：node prototypes/net-probe/self-test.mjs [--long] [--no-keepalive]
// 环境变量 E2E_CHROMIUM_PATH 可指向一份可用的 Chromium（与 e2e 相同）。
// 注意：Playwright 会通过调试协议连着后台，长任务结论偏乐观，只作开发自检；正式结论以真机回填为准。
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { getEndpoint1 } from '../suggest-hit/scripts/lib/keys.mjs';

const ext = resolve(import.meta.dirname, 'extension');
const long = process.argv.includes('--long');
const keepalive = !process.argv.includes('--no-keepalive');
const ep = getEndpoint1();

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const base = `chrome-extension://${new URL(sw.url()).host}`;
  const page = await ctx.newPage();
  await page.goto(`${base}/diag.html`);
  await page.fill('#baseUrl', ep.baseUrl);
  await page.fill('#key', ep.key);
  await page.fill('#model', ep.model);
  await page.selectOption('#network', 'UniVPN');
  await page.click('#save');

  const waitDone = async (startedAfter, timeoutMs) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const s = await (ctx.serviceWorkers()[0] ?? sw).evaluate(async (t) => {
        const { current } = await chrome.storage.local.get('current');
        return current && current.startedAt >= t ? current.state : undefined;
      }, startedAfter);
      if (s && s !== 'running') return s;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return 'timeout';
  };

  let t = Date.now();
  await page.click('#runQuick');
  console.log('快速测试：', await waitDone(t, 180_000));

  if (long) {
    if (!keepalive) await page.uncheck('#keepalive');
    t = Date.now();
    await page.click('#runLong');
    await page.waitForTimeout(1000);
    await page.close(); // 关掉页面，让后台在无界面订阅时独自撑完
    console.log(`长任务（保活${keepalive ? '开' : '关'}）：`, await waitDone(t, 600_000));
  }

  const p2 = await ctx.newPage();
  await p2.goto(`${base}/diag.html`);
  await p2.waitForTimeout(500);
  const tables = await p2.$$eval('#results h3, #results p, #results table', (els) =>
    els
      .map((e) =>
        e.tagName === 'TABLE'
          ? [...e.rows].map((r) => `| ${[...r.cells].map((c) => c.textContent.replace(/\|/g, '\\|')).join(' | ')} |`).join('\n')
          : e.textContent,
      )
      .join('\n\n'),
  );
  // 兜底再脱敏一次，防止页面漏网
  const host = new URL(ep.baseUrl).hostname;
  const out = tables.split(ep.key).join('<key>').split(host).join('<relay>').replace(/<relay>:\d+/g, '<relay>:<端口>');
  console.log(out);
} finally {
  await ctx.close();
}
