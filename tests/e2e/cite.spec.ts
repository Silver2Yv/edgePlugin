// 引用跳回原文（F1、F2、F4、5.7）与「总结本页」完整版（6.2、I6、验收第 8、11 条）端到端。
// 模拟中转站在这里另起一个（回答里带引用标记，不改共用的 tests/mock-relay）：编号对着下面文章的块（b2 开头一段、b4 目标段）。
// 高亮用 CSS 自定义高亮接口：阅读器（隔离环境）登记的高亮与网页同一份注册表，网页里查 CSS.highlights 就能看到。
// 截图只在设了 UI_SHOTS_DIR 时保存。
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Frame, Page, Worker } from '@playwright/test';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/domain/settings';
import { expect, test } from './fixtures';
import { clickToolbarButton, floatFrame, waitSentinelRegistered, writeSettings } from './page-helpers';
import { attachPanel, openPanelByTrustedClick } from './sidepanel-helpers';

const SITE = 'https://e2e.test/';
const QUOTE = '叶绿素主要吸收红光和蓝光';
const TARGET = `第四段：${QUOTE}，反射绿光，所以叶子看起来是绿色的。`;
const ANSWER = `这页讲了光合作用。\n\n- 背景在开头【2】。\n- 原文说：【4】${QUOTE}【/4】。`;
const TALL = 'style="height:1800px"';

const article = (target = TARGET) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>引用跳回测试</title></head>
<body><article>
<h1>引用跳回测试</h1>
<p id="intro">开头一段：这篇文章介绍光合作用的背景与过程。</p>
<p ${TALL}>填充段落甲：植物通过根系吸收水分，再由导管输送到叶片，这一段只是为了把页面撑长。</p>
<p id="target">${target}</p>
<p ${TALL}>填充段落乙：夜间植物主要进行呼吸作用，消耗白天合成的有机物，这一段同样只是填充。</p>
</article></body></html>`;

// ───────────── 模拟中转站：回答里带引用 ─────────────

interface CiteRelay {
  url: string;
  count(): number;
  close(): Promise<void>;
}

async function startCiteRelay(): Promise<CiteRelay> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      return void res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-flash' }] }));
    }
    req.resume();
    req.on('end', () => {
      n++;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', ...cors });
      const chunk = (content: string, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'mock-flash', choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
      const parts = [ANSWER.slice(0, 12), ANSWER.slice(12, 30), ANSWER.slice(30)];
      res.end(`${parts.map((p) => chunk(p)).join('')}${chunk('', 'stop')}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    count: () => n,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function settingsFor(relay: CiteRelay): Settings {
  const conn = {
    id: 'e2e-conn-0001',
    name: '模拟中转站',
    preset: 'custom' as const,
    baseUrl: `${relay.url}/v1`,
    apiKey: 'e2e-fake-key',
    headers: {},
    interfaceType: 'chatCompletions' as const,
    stream: true,
    extraParams: {},
    configVersion: 1,
  };
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    connections: [conn],
    defaultModel: { connectionId: conn.id, model: 'mock-flash' },
    // 工具栏上直接放「总结本页」
    toolbarActions: ['ask', 'summarizePage'],
  };
}

let relay: CiteRelay;
test.beforeAll(async () => {
  relay = await startCiteRelay();
});
test.afterAll(() => relay.close());

let body = article();
async function openArticle(page: Page, sw: Worker): Promise<void> {
  body = article();
  await writeSettings(sw, settingsFor(relay));
  await waitSentinelRegistered(sw);
  await page.route(`${SITE}**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
  await page.goto(`${SITE}article`);
}

/**
 * 选中开头一段、点工具栏按钮。网页文档第一次选中时后台配置可能还没问回来（出厂默认工具栏没有「总结本页」），
 * 先选一次、点开、再选（同 toolbar-actions.spec.ts）
 */
async function toolbar(page: Page, label: string): Promise<void> {
  await page.locator('#intro').click({ clickCount: 3 });
  await page.waitForTimeout(300);
  await page.mouse.click(5, 5);
  await page.locator('#intro').click({ clickCount: 3 });
  await clickToolbarButton(page, label);
}

/** 点工具栏「总结本页」，等小窗里答完 */
async function summarizeViaToolbar(page: Page): Promise<Frame> {
  await toolbar(page, '总结本页');
  const frame = await floatFrame(page);
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
  return frame;
}

/** 网页里登记的引用高亮：选中的文字；没有为 null */
const highlighted = (page: Page) =>
  page.evaluate(() => {
    const hl = CSS.highlights.get('ra-citation');
    if (!hl) return null;
    return [...(hl as unknown as Iterable<Range>)].map((r) => r.toString()).join('|');
  });

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

const SHOTS = process.env.UI_SHOTS_DIR;
function saveShot(name: string, png: Buffer): void {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, name), png);
}

test('点回答里的逐字引用：网页滚到那段并高亮，覆盖范围写在标题处；能回到刚才的位置', async ({
  page,
  serviceWorker,
}) => {
  await openArticle(page, serviceWorker);
  const frame = await summarizeViaToolbar(page);
  await expect(frame.getByTestId('coverage-title')).toHaveText(/^本次读取全文的 \d+%，约 \d+ 字$/);
  expect(await scrollY(page)).toBe(0);

  await frame.locator('[data-testid="answer"] mark.ra-citation-quote').click();
  await expect(frame.getByTestId('cite-note')).toHaveText(/已跳到原文/);
  await expect.poll(() => highlighted(page)).toBe(QUOTE);
  expect(await scrollY(page)).toBeGreaterThan(1000);
  const box = await page.locator('#target').boundingBox();
  expect(box && box.y >= 0 && box.y < (page.viewportSize()?.height ?? 720)).toBe(true);
  // 原文挪到小窗旁边，不被小窗挡住
  const floatBox = await (await frame.frameElement()).boundingBox();
  if (box && floatBox)
    expect(box.y >= floatBox.y + floatBox.height || box.y + box.height <= floatBox.y).toBe(true);
  // 网页 DOM 没被改动（高亮不包元素）
  expect(await page.locator('#target').innerHTML()).toBe(TARGET);
  await page.waitForTimeout(300);
  saveShot('cite-1-jumped.png', await page.screenshot());

  await frame.getByTestId('cite-back').click();
  await expect.poll(() => scrollY(page)).toBeLessThan(50);
  await expect(frame.getByTestId('cite-note')).toHaveCount(0);
  expect(await highlighted(page)).toBeNull();

  // 要点编号：整段高亮
  await frame.locator('[data-testid="answer"] sup.ra-citation').first().click();
  await expect.poll(() => highlighted(page)).toBe('开头一段：这篇文章介绍光合作用的背景与过程。');
});

test('页面内容改了之后点引用：按锚点重新定位，提示「原文可能已变化」', async ({ page, serviceWorker }) => {
  await openArticle(page, serviceWorker);
  const frame = await summarizeViaToolbar(page);
  await page.evaluate(() => {
    const el = document.getElementById('target') as HTMLElement;
    el.textContent = (el.textContent ?? '').replace('红光和蓝光', '红光与蓝光');
  });
  await frame.locator('[data-testid="answer"] mark.ra-citation-quote').click();
  await expect(frame.getByTestId('cite-note')).toHaveText(/原文可能已变化，这是最接近的位置/);
  await expect.poll(() => highlighted(page)).toBe('叶绿素主要吸收红光与蓝光');
  expect(await scrollY(page)).toBeGreaterThan(1000);
  await expect(frame.getByTestId('cite-back')).toBeVisible();
});

test('上次总结：重新打开后显示，点「总结本页」不发新请求，「重新总结」才发；页面改了标「基于旧版本」', async ({
  page,
  serviceWorker,
}) => {
  await openArticle(page, serviceWorker);
  const base = relay.count();
  await summarizeViaToolbar(page);
  const afterFirst = relay.count();
  expect(afterFirst).toBe(base + 1);

  // 关掉网页再打开（新文档、新小窗）：30 分钟内续接这个对话，总结在对话里；点「新对话」后看到上次总结卡片
  await page.reload();
  await toolbar(page, '问');
  let frame = await floatFrame(page);
  await expect(frame.getByText('这页讲了光合作用').first()).toBeVisible();
  await frame.getByLabel('新对话').click();
  const card = frame.getByTestId('summary-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('上次总结');
  await expect(card.getByTestId('coverage-title')).toHaveText(/^本次读取全文的/);
  await expect(card.getByTestId('summary-stale')).toHaveCount(0);
  saveShot('cite-2-last-summary.png', await page.screenshot());

  // 卡片里的引用也能点回原文（F3）
  await card.locator('mark.ra-citation-quote').click();
  await expect.poll(() => highlighted(page)).toBe(QUOTE);

  // 再点「总结本页」：页面没变，直接显示上次的，不发请求
  await page.evaluate(() => window.scrollTo(0, 0));
  await toolbar(page, '总结本页');
  frame = await floatFrame(page);
  await expect(frame.getByTestId('summary-card')).toBeVisible();
  await page.waitForTimeout(800);
  expect(relay.count()).toBe(afterFirst);

  // 「重新总结」：发一次新请求
  await frame.getByTestId('summary-card').getByRole('button', { name: '重新总结' }).click();
  await expect.poll(() => relay.count()).toBe(afterFirst + 1);
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
  await expect(frame.getByTestId('summary-card')).toHaveCount(0);

  // 页面内容改了：重新打开后卡片标「基于旧版本」；再点「总结本页」会重新总结
  body = article(TARGET.replace('所以叶子', '因此叶子'));
  await page.reload();
  await toolbar(page, '问');
  frame = await floatFrame(page);
  await frame.getByLabel('新对话').click();
  await expect(frame.getByTestId('summary-stale')).toHaveText('基于旧版本');
  saveShot('cite-3-stale.png', await page.screenshot());
  await toolbar(page, '总结本页');
  await expect.poll(() => relay.count()).toBe(afterFirst + 2);
});

test('侧边栏里点引用：网页滚到那段并高亮', async ({ context, page, serviceWorker }) => {
  await openArticle(page, serviceWorker);
  await summarizeViaToolbar(page);
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  try {
    await expect
      .poll(() => panel.evaluate<number>('document.querySelectorAll("mark.ra-citation-quote").length'), {
        message: '侧边栏显示带引用的回答',
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    await panel.click('mark.ra-citation-quote');
    await expect.poll(() => highlighted(page)).toBe(QUOTE);
    expect(await scrollY(page)).toBeGreaterThan(1000);
    await expect
      .poll(() =>
        panel.evaluate<string | null>('document.querySelector("[data-testid=cite-note]")?.textContent'),
      )
      .toContain('已跳到原文');
  } finally {
    await panel.detach();
  }
});
