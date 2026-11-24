// 多编号引用循环跳转（决策 097）、别的页面的对话「回到那一页」与收藏「回到原文」（决策 098）端到端。
// 模拟中转站在这里另起一个（回答里一处标了两个编号【2,4】，不改共用的 tests/mock-relay）：编号对着下面文章的块
// （b2 开头一段、b4 目标段）。高亮用 CSS 自定义高亮接口：阅读器（隔离环境）登记的高亮与网页同一份注册表，
// 网页里查 CSS.highlights 就能看到。网页由本地 http 服务提供（见 beforeAll），扩展自己新开的标签页也能取到内容。
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Frame, Page, Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/domain/settings';
import { expect, test } from './fixtures';
import {
  clickToolbarButton,
  floatFrame,
  tripleClick,
  waitSentinelRegistered,
  writeSettings,
} from './page-helpers';
import {
  askInPanel,
  attachPanel,
  openPanelByTrustedClick,
  type PanelHandle,
  panelText,
} from './sidepanel-helpers';

declare const chrome: typeof browser;

let SITE = '';
const INTRO = '开头一段：这篇文章介绍光合作用的背景与过程。';
const QUOTE = '叶绿素主要吸收红光和蓝光';
const TARGET = `第四段：${QUOTE}，反射绿光，所以叶子看起来是绿色的。`;
const ANSWER = '这页讲了光合作用。\n\n- 背景和过程都有提到【2,4】。';
const TALL = 'style="height:1800px"';

const article = (title: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body><article>
<h1>${title}</h1>
<p id="intro">${INTRO}</p>
<p ${TALL}>填充段落甲：植物通过根系吸收水分，再由导管输送到叶片，这一段只是为了把页面撑长。</p>
<p id="target">${TARGET}</p>
<p ${TALL}>填充段落乙：夜间植物主要进行呼吸作用，消耗白天合成的有机物，这一段同样只是填充。</p>
</article></body></html>`;

// ───────────── 模拟中转站：回答里一处带两个编号 ─────────────

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
    // 工具栏上放「总结本页」与「存」
    toolbarActions: ['ask', 'summarizePage', 'save'],
  };
}

let relay: CiteRelay;
let pageServer: Server;
test.beforeAll(async () => {
  relay = await startCiteRelay();
  // 网页用真的本地服务：扩展自己新开的标签页，Playwright 的路由拦不到它的第一次导航（会显示错误页）
  pageServer = createServer((req, res) => {
    const title = new URL(req.url ?? '/', 'http://x').pathname === '/b' ? '乙页' : '甲页';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(article(title));
  });
  await new Promise<void>((r) => pageServer.listen(0, '127.0.0.1', r));
  SITE = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}/`;
});
test.afterAll(async () => {
  await relay.close();
  await new Promise((r) => pageServer.close(r));
});

async function setup(sw: Worker): Promise<void> {
  await writeSettings(sw, settingsFor(relay));
  await waitSentinelRegistered(sw);
}

/**
 * 选中开头一段、点工具栏按钮。网页文档第一次选中时后台配置可能还没问回来，
 * 先选一次、点开、再选（同 cite.spec.ts）
 */
async function toolbar(page: Page, label: string, selector = '#intro'): Promise<void> {
  await tripleClick(page, selector);
  await page.waitForTimeout(300);
  await page.mouse.click(5, 5);
  await tripleClick(page, selector);
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

/** 本窗口当前活动标签页的地址 */
const activeUrl = (sw: Worker) =>
  sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url);

const notes = (panel: PanelHandle) =>
  panel.evaluate<string | null>('document.querySelector("[data-testid=cite-note]")?.textContent');

test('小窗里一处标了【2,4】：第一次点跳第一个，再点同一处跳下一个，最后一个之后回到第一个，提示写明第几处', async ({
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  await setup(serviceWorker);
  await page.goto(`${SITE}a`);
  const frame = await summarizeViaToolbar(page);
  const mark = frame.locator('[data-testid="answer"] sup.ra-citation');
  await expect(mark).toHaveText('[2,4]');
  const note = frame.getByTestId('cite-note');

  await mark.click();
  await expect.poll(() => highlighted(page)).toBe(INTRO);
  await expect(note).toHaveText(/^第 1 \/ 2 处：已跳到原文/);
  expect(await scrollY(page)).toBeLessThan(400);

  await mark.click();
  await expect.poll(() => highlighted(page)).toBe(TARGET);
  await expect(note).toHaveText(/^第 2 \/ 2 处：已跳到原文/);
  expect(await scrollY(page)).toBeGreaterThan(1000);

  await mark.click();
  await expect.poll(() => highlighted(page)).toBe(INTRO);
  await expect(note).toHaveText(/^第 1 \/ 2 处：已跳到原文/);
});

test('侧边栏里同样循环', async ({ context, page, serviceWorker }) => {
  test.setTimeout(60_000);
  await setup(serviceWorker);
  await page.goto(`${SITE}a`);
  await summarizeViaToolbar(page);
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  try {
    await expect
      .poll(() => panel.evaluate<number>('document.querySelectorAll("sup.ra-citation").length'), {
        message: '侧边栏显示带引用的回答',
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    for (const [want, text, order] of [
      [INTRO, '第 1 / 2 处', 1],
      [TARGET, '第 2 / 2 处', 2],
      [INTRO, '第 1 / 2 处', 3],
    ] as const) {
      await panel.click('sup.ra-citation');
      await expect.poll(() => highlighted(page), { message: `第 ${order} 次点击后的高亮` }).toBe(want);
      await expect.poll(() => notes(panel)).toContain(text);
    }
  } finally {
    await panel.detach();
  }
});

test('别的页面的对话：点「回到那一页」切到那一页（已打开）并显示这个对话，可以接着问', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  await setup(serviceWorker);
  await page.goto(`${SITE}a`);
  await summarizeViaToolbar(page);

  expect(await openPanelByTrustedClick(context)).toBe('ok');
  const pageB = await context.newPage();
  await pageB.goto(`${SITE}b`);
  await pageB.bringToFront();
  const panel = await attachPanel(context);
  try {
    // 面板跟随到乙页；历史里点开甲页的对话：只能看，旁边有「回到那一页」
    await expect.poll(() => panelText(panel, 'page-title')).toBe('乙页');
    await panel.click('[data-testid="panel-nav-history"]');
    await panel.click('[data-testid="history-item"] .ra-panel-item__main');
    await expect
      .poll(() =>
        panel.evaluate<number>('document.querySelectorAll("[data-testid=cross-page-notice]").length'),
      )
      .toBe(1);
    expect(await activeUrl(serviceWorker)).toBe(`${SITE}b`);
    const pagesBefore = context.pages().length;

    await panel.click('[data-testid="jump-to-page"]');
    await expect.poll(() => activeUrl(serviceWorker), { message: '活动标签页变成甲页' }).toBe(`${SITE}a`);
    expect(context.pages().length).toBe(pagesBefore);
    // 侧边栏显示这个对话，跨页提示没了，输入框回来了
    await expect.poll(() => panelText(panel, 'page-title')).toBe('甲页');
    await expect
      .poll(() =>
        panel.evaluate<number>('document.querySelectorAll("[data-testid=cross-page-notice]").length'),
      )
      .toBe(0);
    await expect.poll(() => panelText(panel, 'answer')).toContain('这页讲了光合作用');

    // 接着问
    const before = relay.count();
    await askInPanel(panel, '继续问一句');
    await expect.poll(() => relay.count(), { timeout: 15_000 }).toBe(before + 1);
    await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
    expect(await panel.text('[data-testid="user-message"]')).toContain('总结本页');
    await expect
      .poll(() =>
        panel.evaluate<string[]>(
          '[...document.querySelectorAll("[data-testid=user-message]")].map((e) => e.textContent)',
        ),
      )
      .toEqual(expect.arrayContaining([expect.stringContaining('继续问一句')]));
  } finally {
    await panel.detach();
  }
});

test('别的页面的对话：那一页没有打开时，在本窗口新开标签页，到了之后显示这个对话', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  await setup(serviceWorker);
  await page.goto(`${SITE}a`);
  await summarizeViaToolbar(page);

  expect(await openPanelByTrustedClick(context)).toBe('ok');
  const pageB = await context.newPage();
  await pageB.goto(`${SITE}b`);
  await pageB.bringToFront();
  // 甲页关掉：对话已经存库，历史里还在
  await page.close();
  const panel = await attachPanel(context);
  try {
    await expect.poll(() => panelText(panel, 'page-title')).toBe('乙页');
    await panel.click('[data-testid="panel-nav-history"]');
    await panel.click('[data-testid="history-item"] .ra-panel-item__main');
    await panel.click('[data-testid="jump-to-page"]');
    await expect
      .poll(() => activeUrl(serviceWorker), { message: '新开的标签页成了活动标签页' })
      .toBe(`${SITE}a`);
    await expect
      .poll(() => context.pages().filter((p) => p.url() === `${SITE}a`).length, {
        message: '新开了一个甲页标签页（只一个）',
      })
      .toBe(1);
    await expect.poll(() => panelText(panel, 'page-title')).toBe('甲页');
    await expect
      .poll(() =>
        panel.evaluate<number>('document.querySelectorAll("[data-testid=cross-page-notice]").length'),
      )
      .toBe(0);
    await expect.poll(() => panelText(panel, 'message-list')).toContain('这页讲了光合作用');
    // 能接着问
    const before = relay.count();
    await askInPanel(panel, '新标签页里接着问');
    await expect.poll(() => relay.count(), { timeout: 15_000 }).toBe(before + 1);
    await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
  } finally {
    await panel.detach();
  }
});

test('收藏「回到原文」：切回收藏时的页面，原文被高亮；那一页关了就新开再高亮', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  await setup(serviceWorker);
  await page.goto(`${SITE}a`);
  // 工具栏「存」：选中目标段
  await toolbar(page, '存', '#target');

  expect(await openPanelByTrustedClick(context)).toBe('ok');
  const pageB = await context.newPage();
  await pageB.goto(`${SITE}b`);
  await pageB.bringToFront();
  const panel = await attachPanel(context);
  try {
    await panel.click('[data-testid="panel-nav-favorites"]');
    await expect
      .poll(() => panel.evaluate<number>('document.querySelectorAll("[data-testid=favorite-item]").length'), {
        message: '收藏列表里有刚存的一条',
        timeout: 10_000,
      })
      .toBe(1);
    expect(await highlighted(page)).toBeNull();

    // 甲页还开着：切过去，原文被高亮
    await panel.click('[data-testid="favorite-jump"]');
    await expect.poll(() => activeUrl(serviceWorker), { message: '活动标签页变成甲页' }).toBe(`${SITE}a`);
    await expect.poll(() => notes(panel), { timeout: 10_000 }).toContain('已跳到原文');
    await expect.poll(() => highlighted(page), { timeout: 10_000 }).toContain(QUOTE);
    expect(await scrollY(page)).toBeGreaterThan(1000);

    // 甲页关掉、回到乙页：再点「回到原文」，新开标签页，等加载完成后高亮
    await page.close();
    await pageB.bringToFront();
    await expect.poll(() => panelText(panel, 'page-title')).toBe('乙页');
    await panel.click('[data-testid="panel-nav-favorites"]');
    await expect
      .poll(() => panel.evaluate<number>('document.querySelectorAll("[data-testid=favorite-item]").length'))
      .toBe(1);
    await panel.click('[data-testid="favorite-jump"]');
    await expect
      .poll(() => activeUrl(serviceWorker), { message: '新开的标签页是活动标签页' })
      .toBe(`${SITE}a`);
    await expect
      .poll(
        async () => {
          const reopened = context.pages().find((p) => p.url() === `${SITE}a`);
          return reopened ? await highlighted(reopened) : null;
        },
        { timeout: 15_000 },
      )
      .toContain(QUOTE);
    await expect.poll(() => notes(panel)).toContain('已跳到原文');
  } finally {
    await panel.detach();
  }
});
