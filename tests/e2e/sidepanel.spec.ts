// 侧边栏最小版（V-11、5.4、5.12）：显示本窗口活动标签页的对话、跟随切换标签页、本窗口授权、
// 开关快捷键（关的一半）、两个界面同时向同一对话发送（V-03）、侧边栏开合与阅读位置（V-12）。
// 侧边栏页面 Playwright 拿不到，经浏览器级调试协议附加（sidepanel-helpers.ts）。
import { chromium, type Page, type Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { EXTENSION_ID, EXTENSION_PATH, expect, test } from './fixtures';
import {
  ANSWER,
  askInFloat,
  clickAsk,
  parseBody,
  type Relay,
  selectAndOpen,
  settingsWith,
  startRelay,
  writeSettings,
} from './page-helpers';
import {
  askInPanel,
  attachPanel,
  dispatchCommand,
  expectPanels,
  openPanelByTrustedClick,
  panelContexts,
  panelText,
  sidePanelTargets,
  tabOf,
} from './sidepanel-helpers';

declare const chrome: typeof browser;

const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const OTHER = '潮汐主要由月球引力引起，太阳引力也有一部分作用。';
const article = (title: string, p: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body><article><h1>${title}</h1><p>第一段：用来做侧边栏测试的文章。</p><p id="target">${p}</p></article></body></html>`;

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(async ({ context, serviceWorker }) => {
  await r.reset();
  await writeSettings(serviceWorker, settingsWith(r));
  await context.route('https://e2e.test/**', (rt) => {
    const other = rt.request().url().includes('/b');
    return rt.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: other ? article('另一篇', OTHER) : article('侧边栏测试文章', PARAGRAPH),
    });
  });
});

const browserVersion = async (sw: Worker) =>
  sw.evaluate(() => navigator.userAgent.match(/(Edg|Chrome)\/[\d.]+/g)?.join(' ') ?? navigator.userAgent);

test('侧边栏显示本窗口活动标签页的引用与回答，接着问带上同一对话的历史；两个界面显示同一个任务', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  console.log('[V-11] 浏览器', await browserVersion(serviceWorker));
  await page.goto('https://e2e.test/a');
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '这段话讲了什么？');

  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  await expect.poll(() => panelText(panel, 'quote')).toContain(PARAGRAPH);
  await expect.poll(() => panelText(panel, 'answer')).toContain(ANSWER);
  await expect.poll(() => panelText(panel, 'job-state')).toBe('completed');

  await askInPanel(panel, '再说简单一点');
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(2);
  const sent = JSON.stringify(parseBody(r.bodies[1]).messages);
  expect(sent).toContain('这段话讲了什么？'); // 历史：同一对话的第一轮
  expect(sent).toContain('再说简单一点');
  expect(sent).toContain(PARAGRAPH); // 引用取所订阅标签页存下的选区
  await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
  // 小窗跟着显示侧边栏发起的这个任务，两边各一份完整回答、没有拼接
  await expect(frame.getByTestId('job-state')).toHaveText('completed');
  expect(await panelText(panel, 'answer')).toBe(ANSWER);
  await expect(frame.getByTestId('answer')).toHaveText(ANSWER);
  await panel.detach();
});

test('跟随切换标签页：每个标签页显示自己的对话，换到没有对话的标签页时不残留', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/a');
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '这段话讲了什么？');
  const pageB = await context.newPage();
  await pageB.goto('https://e2e.test/b');

  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  await expect.poll(() => panelText(panel, 'answer')).toContain(ANSWER);

  await pageB.bringToFront();
  await expect
    .poll(() => panel.evaluate<boolean>('!document.querySelector("[data-testid=answer]")'))
    .toBe(true);
  expect(await panel.text('[data-testid="quote"]')).toBeNull();
  // 在 B 上划词点「问」：侧边栏实时换上 B 的引用
  await pageB.locator('#target').click({ clickCount: 3 });
  await clickAsk(pageB);
  await expect.poll(() => panelText(panel, 'quote')).toContain(OTHER);

  await page.bringToFront();
  await expect.poll(() => panelText(panel, 'answer')).toContain(ANSWER);
  await expect.poll(() => panelText(panel, 'quote')).toContain(PARAGRAPH);
  expect(await tabOf(serviceWorker, pageB)).toMatchObject({
    windowId: (await tabOf(serviceWorker, page)).windowId,
  });
  await panel.detach();
});

const floatOpen = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-ra-float-host]')?.matches(':popover-open') ?? false);

test('侧边栏开着时点「问」（5.4、用户 11-21 确认）：引用进侧边栏、不开小窗，在侧边栏问答；后台被回收、侧边栏闲着时同样如此；关掉侧边栏后回到小窗', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  await page.goto('https://e2e.test/a');
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  await page.locator('#target').click({ clickCount: 3 });
  await clickAsk(page);
  await expect.poll(() => panelText(panel, 'quote')).toContain(PARAGRAPH);
  await page.waitForTimeout(500);
  expect(await floatOpen(page)).toBe(false);
  expect(await panelContexts(serviceWorker)).toHaveLength(1);
  console.log('[V-11] 点「问」后侧边栏是否拿到焦点', await panel.evaluate<boolean>('document.hasFocus()'));
  await askInPanel(panel, '这段话讲了什么？');
  await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
  expect(r.bodies).toHaveLength(1);
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).toContain(PARAGRAPH);

  // 后台被回收：侧边栏断线闲着（读网页时的常态）。划词时后台叫醒它，选完立即点「问」也仍去侧边栏
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
  await page.waitForTimeout(1_000);
  await page.locator('p').first().click({ clickCount: 3 });
  await clickAsk(page);
  const t0 = Date.now();
  await expect.poll(() => panelText(panel, 'quote')).toContain('用来做侧边栏测试的文章');
  console.log('[V-11] 后台被回收后点「问」到侧边栏显示引用 ms', Date.now() - t0);
  await page.waitForTimeout(500);
  expect(await floatOpen(page)).toBe(false);

  // 用户关掉侧边栏：再点「问」回到小窗
  await panel.evaluate('(window.close(), 1)').catch(() => undefined);
  const sw = context.serviceWorkers()[0] ?? serviceWorker;
  await expectPanels(sw, 0);
  await page.locator('#target').click({ clickCount: 3 });
  await clickAsk(page);
  await expect.poll(() => floatOpen(page)).toBe(true);
  expect(await panelContexts(sw)).toHaveLength(0);
});

test('本窗口授权：另一个窗口的侧边栏订阅不到这个窗口的标签页（5.12）', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  const helloLogs: string[] = [];
  const hook = (w: Worker) =>
    w.on('console', (m) => {
      if (m.text().includes('sidepanel/hello')) helloLogs.push(m.text());
    });
  hook(serviceWorker);
  context.on('serviceworker', hook);
  // 平台事实（V-11）：侧边栏端口的 sender 带哪些字段、getContexts 给侧边栏的 windowId
  await serviceWorker.evaluate(() => {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === 'probe') console.info(`[探针] 侧边栏端口 sender ${JSON.stringify(port.sender)}`);
    });
  });
  const probeLogs: string[] = [];
  serviceWorker.on('console', (m) => {
    if (m.text().includes('[探针]')) probeLogs.push(m.text());
  });
  await page.goto('https://e2e.test/a');
  await selectAndOpen(page, '#target');
  const tabA = await tabOf(serviceWorker, page);
  const pageWait = context.waitForEvent('page');
  const w2 = (await serviceWorker.evaluate(
    async () => (await chrome.windows.create({ url: 'https://e2e.test/b' }))?.id,
  )) as number;
  const page2 = await pageWait;
  await page2.waitForLoadState();
  expect(await openPanelByTrustedClick(context, w2)).toBe('ok');
  const panel = await attachPanel(context);
  expect(await panel.evaluate<number>('chrome.windows.getCurrent().then(w => w.id)')).toBe(w2);
  // 窗口 2 的面板跟着窗口 2 的活动标签页：没有窗口 1 的引用
  await page.waitForTimeout(500);
  expect(await panel.text('[data-testid="quote"]')).toBeNull();

  // 协议层：窗口 2 的面板去订阅窗口 1 的标签页，被拒
  const probe = (windowId: number, tabId: number) =>
    panel.evaluate<string[]>(`new Promise((resolve) => {
      const out = [];
      const port = chrome.runtime.connect({ name: 'conv' });
      port.onMessage.addListener((m) => {
        out.push(m.type === 'conv/rejected' ? 'rejected:' + m.reason : m.type);
        if (m.type === 'conv/ready') port.postMessage({ type: 'conv/subscribe', tabId: ${tabId} });
        if (m.type === 'conv/snapshot' || (m.type === 'conv/rejected' && out.length > 1)) { port.disconnect(); resolve(out); }
      });
      port.postMessage({ type: 'conv/helloSidepanel', windowId: ${windowId} });
      setTimeout(() => resolve(out), 3000);
    })`);
  expect(await probe(w2, tabA.id)).toEqual(['conv/ready', 'rejected:notOwner']);
  // 已知限制（决策 072）：后台核实不了侧边栏真在哪个窗口（getContexts 的 windowId 为 -1、sender 不带
  // documentId），面板自报别的窗口时只能核对窗口存在。这里如实记录这一点
  const lying = await probe(tabA.windowId, tabA.id);
  console.log('[V-11] 面板自报别的窗口时的结果', JSON.stringify(lying));
  expect(lying[0]).toBe('conv/ready');
  await panel.evaluate(`(chrome.runtime.connect({ name: 'probe' }), 1)`);
  await expect.poll(() => probeLogs.length).toBeGreaterThan(0);
  console.log('[V-11]', probeLogs[0]);
  console.log('[V-11] getContexts', JSON.stringify(await panelContexts(serviceWorker)));
  console.log('[V-11] 后台握手日志', JSON.stringify(helloLogs.slice(0, 2)));
  expect(helloLogs.every((l) => l.includes('"windowFrom":"hint"'))).toBe(true);
  await panel.detach();
});

test('开关快捷键（关的一半）：之前就开着的面板收到命令自行关闭；命令之后才打开的面板不受旧命令影响；只关本窗口的', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/a');
  const tab = await tabOf(serviceWorker, page);
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await expectPanels(serviceWorker, 1);
  // 没有手势：open 被拒，但广播照发，开着的面板自己关
  await dispatchCommand(serviceWorker, 'toggle-sidepanel', tab);
  await expectPanels(serviceWorker, 0, '面板自行关闭');

  // 命令记录（storage.session）早于新面板：新面板不关
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.waitForTimeout(1500);
  expect(await panelContexts(serviceWorker)).toHaveLength(1);

  // 两个窗口各开一个面板，只在窗口 2 按：只关窗口 2 的
  const pageWait = context.waitForEvent('page');
  const w2 = (await serviceWorker.evaluate(
    async () => (await chrome.windows.create({ url: 'https://e2e.test/b' }))?.id,
  )) as number;
  await (await pageWait).waitForLoadState();
  expect(await openPanelByTrustedClick(context, w2)).toBe('ok');
  await expectPanels(serviceWorker, 2);
  const targets = await sidePanelTargets(context);
  expect(targets).toHaveLength(2);
  await dispatchCommand(serviceWorker, 'toggle-sidepanel', { id: 0, windowId: w2 });
  await expectPanels(serviceWorker, 1, '只剩窗口 1 的面板');
  const left = await attachPanel(context);
  expect(await left.evaluate<number>('chrome.windows.getCurrent().then(w => w.id)')).toBe(tab.windowId);
  await left.detach();

  // 快速连按两次（没有手势时）：第一次关，第二次 open 被拒，不会又开回来
  await dispatchCommand(serviceWorker, 'toggle-sidepanel', tab);
  await dispatchCommand(serviceWorker, 'toggle-sidepanel', tab);
  await expectPanels(serviceWorker, 0);
  await page.waitForTimeout(1000);
  expect(await panelContexts(serviceWorker)).toHaveLength(0);
});

test('V-03：小窗与侧边栏同时向同一对话发送，只接一单，另一边看到「回答进行中」', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  // 回答要持续几秒（long 模式，约 3 秒），两边几乎同时发出时先到的那条还在生成，后到的必被拒
  const slow = await startRelay(0.01);
  try {
    await writeSettings(serviceWorker, {
      ...settingsWith(slow),
      connections: [
        { ...settingsWith(slow).connections[0], baseUrl: `${slow.relay.url}/m/long/v1` } as never,
      ],
    });
    await v03(context, page, slow);
  } finally {
    await slow.relay.close();
  }
});

async function v03(context: import('@playwright/test').BrowserContext, page: Page, slow: Relay) {
  await page.goto('https://e2e.test/a');
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, slow, '第一问');
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  await expect.poll(() => panelText(panel, 'job-state')).toBe('completed');
  const conversationId = await panel.evaluate<string>(`new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'conv' });
    port.onMessage.addListener((m) => { if (m.type === 'conv/subscribed') { port.disconnect(); resolve(m.conversationId); } });
    chrome.windows.getCurrent().then(async (w) => {
      const [t] = await chrome.tabs.query({ active: true, windowId: w.id });
      port.postMessage({ type: 'conv/helloSidepanel', windowId: w.id });
      setTimeout(() => port.postMessage({ type: 'conv/subscribe', tabId: t.id }), 200);
    });
  })`);
  expect(conversationId).toMatch(/^[a-z0-9-]{8,64}$/);

  // 小窗界面每次发问是新对话，不会向同一对话发；这里用小窗身份的对话端口（resumeFloat）在同一时刻
  // 向同一对话发问，与侧边栏界面里的发送并发
  await panel.click('textarea[aria-label="输入问题"]');
  await panel.type('侧边栏这边问');
  const floatAsk = frame.evaluate(
    (cid) =>
      new Promise<string>((resolve) => {
        const port = chrome.runtime.connect({ name: 'conv' });
        port.onMessage.addListener((raw: unknown) => {
          const m = raw as { type: string; reason?: string };
          if (m.type === 'conv/ready')
            port.postMessage({
              type: 'conv/ask',
              clientRequestId: crypto.randomUUID(),
              conversationId: cid,
              actionId: 'ask',
              text: '小窗这边问',
              contextTier: 'selection',
              lengthTier: 'normal',
              thinking: 'off',
              model: { connectionId: 'e2e-conn-0001', model: 'mock-flash' },
            });
          if (m.type === 'conv/accepted') resolve('accepted');
          if (m.type === 'conv/rejected') resolve(`rejected:${m.reason}`);
        });
        port.postMessage({ type: 'conv/resumeFloat' });
      }),
    conversationId,
  );
  await panel.press('Enter');
  const floatResult = await floatAsk;
  await expect.poll(() => slow.bodies.length, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => panelText(panel, 'job-state'), { timeout: 20_000 }).toBe('completed');
  await page.waitForTimeout(500);
  expect(slow.bodies).toHaveLength(2);
  const panelError = await panel.text('[data-testid="action-error"]');
  console.log('[V-03] 小窗端口结果', floatResult, '侧边栏提示', panelError);
  // 恰好一边被拒，拒绝原因是「回答进行中」
  expect(
    [floatResult === 'rejected:busy', panelError?.includes('回答进行中') === true].filter(Boolean),
  ).toHaveLength(1);
  // 两个界面显示同一个任务，回答只有一份
  const answer = await panelText(panel, 'answer');
  expect(answer).toContain('第 1 段。');
  expect(answer.split('第 1 段。')).toHaveLength(2);
  await expect(frame.getByTestId('answer')).toHaveText(answer);
  await panel.detach();
}

// V-12「侧边栏开合引起重排」：默认上下文按固定视口仿真（1280×720），开合侧边栏网页尺寸不变，看不出重排；
// 这里另起一个不做视口仿真（viewport: null）的上下文，让网页跟着窗口内容区走
test('V-12：侧边栏开合时网页重排，记录视口顶部段落与块内偏移的变化、网页焦点与选区', async () => {
  test.setTimeout(60_000);
  const EDGE = process.env.E2E_BROWSER === 'msedge';
  const ctx = await chromium.launchPersistentContext('', {
    channel: EDGE ? 'msedge' : 'chromium',
    ...(EDGE ? { headless: false } : {}),
    ...(!EDGE && process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
    viewport: null,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--window-size=1200,800',
    ],
  });
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    const paras = Array.from(
      { length: 80 },
      (_, i) => `<p id="p${i}">第${i}段：${'这是一段用来观察重排的正文，'.repeat(8)}</p>`,
    ).join('');
    await ctx.route('https://e2e.test/**', (rt) =>
      rt.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>重排</title></head><body>${paras}</body></html>`,
      }),
    );
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://e2e.test/reflow');
    await page.evaluate(() => {
      const p = document.getElementById('p40') as HTMLElement;
      window.scrollTo(0, p.offsetTop + 30);
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('p41') as HTMLElement);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    });
    const reading = (pg: Page) =>
      pg.evaluate(() => {
        const ps = [...document.querySelectorAll('p')];
        const top = ps.find((p) => p.getBoundingClientRect().bottom > 0) as HTMLElement;
        const rect = top.getBoundingClientRect();
        // 视口顶部落在这一段的第几个字附近（块内偏移，按行近似）
        const lineH = parseFloat(getComputedStyle(top).lineHeight) || 20;
        const lines = Math.round(-rect.top / lineH);
        const charsPerLine = Math.max(1, Math.floor(top.clientWidth / 16));
        return {
          width: window.innerWidth,
          topBlock: top.id,
          approxOffsetChars: lines * charsPerLine,
          selection: getSelection()?.toString().slice(0, 6),
        };
      });
    const before = await reading(page);
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await opt.evaluate(async () => {
      const w = (await chrome.windows.getCurrent()).id as number;
      document.addEventListener('click', () => void chrome.sidePanel.open({ windowId: w }));
    });
    await opt.mouse.click(5, 5);
    await opt.close();
    await page.bringToFront();
    await expect.poll(async () => (await panelContexts(sw)).length).toBe(1);
    await page.waitForTimeout(800);
    const opened = await reading(page);
    await sw.evaluate(async () => {
      for (const w of await chrome.windows.getAll())
        await chrome.sidePanel.close({ windowId: w.id as number });
    });
    await expect.poll(async () => (await panelContexts(sw)).length).toBe(0);
    await page.waitForTimeout(800);
    const closed = await reading(page);
    console.log('[V-12] 侧边栏开合', JSON.stringify({ before, opened, closed }));
    // 选区不因开合丢失
    expect(opened.selection).toBe(before.selection);
    expect(closed.selection).toBe(before.selection);
  } finally {
    await ctx.close();
  }
});
