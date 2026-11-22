// V-06：页面身份与缓存失效（VALIDATION_MATRIX）。每次发问前都让阅读器重新抽取、按内容指纹核对：
// 指纹没变才用缓存（page/docUnchanged），变了就用新正文；pageKey、documentId 取自 sender，不信页面自报。
// 证据：发送计划（conv/plan 的 pageKey / documentId / contentVersion / coverage）、模拟中转站收到的完整请求、
// 后台诊断日志里的 page/read 结果（parts = 重新回传正文，unchanged = 指纹相同用缓存）。
import { type BrowserContext, chromium, type Page } from '@playwright/test';
import { dismissWelcome, EXTENSION_PATH, expect, test } from './fixtures';
import {
  collectLogs,
  connection,
  convAsk,
  floatFrame,
  type Logs,
  MODEL,
  parseBody,
  type Relay,
  selectAndConvAsk,
  selectionRevision,
  sessionJobs,
  settingsWith,
  startRelay,
  waitSentinelRegistered,
  writeSettings,
} from './page-helpers';

const model = { connectionId: 'e2e-conn-0001', model: MODEL };
const ask = (text: string) => ({ model, text, contextTier: 'nearby' });

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(() => r.reset());

const html = (title: string, body: string, script = '') => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body><main id="m"><h1>${title}</h1>${body}</main><script>${script}</script></body></html>`;

type Sw = Parameters<typeof writeSettings>[0];

async function setup(sw: Sw) {
  await writeSettings(sw, settingsWith(r));
  await waitSentinelRegistered(sw);
}

/** 当前选区的修订号（同一文档里没有新选区时复用） */
const selRev = async (sw: Sw, page: Page) => (await selectionRevision(sw, page)) as number;

const readResults = (logs: Logs) => logs.events('page/read').map((e) => e.result);
const lastBody = () => r.bodies.at(-1) ?? '';

test('只换文字（URL、main 节点、长度都不变）：指纹变了就用新正文，长度一致不算内容一致', async ({
  context,
  page,
  serviceWorker,
}) => {
  const logs = collectLogs(context, serviceWorker);
  await setup(serviceWorker);
  await context.route('https://e2e.test/v06/text', (rt) =>
    rt.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: html(
        '换字测试',
        '<p id="sel">选区段落：这是用户选中的那一段，保持不变。</p><p id="var">变化段落：甲乙丙丁戊己庚辛壬癸。</p>',
      ),
    }),
  );
  await page.goto('https://e2e.test/v06/text');
  const { frame, res: a } = await selectAndConvAsk(page, serviceWorker, '#sel', ask('第一次'));
  expect(lastBody()).toContain('甲乙丙丁戊己庚辛壬癸');

  // 同一节点、同样长度，只换文字
  const mainBefore = await page.evaluate(() => {
    const m = document.getElementById('m') as HTMLElement & { __mark?: number };
    m.__mark = 1;
    // biome-ignore lint/performance/useDomNodeTextContent: 比较的是页面显示出来的文字长度
    return m.innerText.length;
  });
  await page.evaluate(() => {
    (document.getElementById('var') as HTMLElement).textContent = '变化段落：子丑寅卯辰巳午未申酉。';
  });
  const mainAfter = await page.evaluate(() => {
    const m = document.getElementById('m') as HTMLElement & { __mark?: number };
    // biome-ignore lint/performance/useDomNodeTextContent: 比较的是页面显示出来的文字长度
    return { len: m.innerText.length, same: m.__mark === 1 };
  });
  expect(mainAfter).toEqual({ len: mainBefore, same: true });

  const rev = a.plan?.contentVersion;
  const b = await convAsk(frame, { ...ask('第二次'), selectionRevision: await selRev(serviceWorker, page) });
  expect(lastBody()).toContain('子丑寅卯辰巳午未申酉');
  expect(lastBody()).not.toContain('甲乙丙丁戊己庚辛壬癸');
  expect(b.plan).toMatchObject({ pageKey: a.plan?.pageKey, documentId: a.plan?.documentId });
  expect(b.plan?.contentVersion).not.toBe(rev);
  const extractable = (p: Record<string, unknown> | undefined) =>
    (p?.coverage as { extractableChars: number } | undefined)?.extractableChars;
  expect(extractable(b.plan)).toBe(extractable(a.plan));

  // 不再变：第三次问用缓存（阅读器只回 docUnchanged）
  const c = await convAsk(frame, { ...ask('第三次'), selectionRevision: await selRev(serviceWorker, page) });
  expect(c.plan?.contentVersion).toBe(b.plan?.contentVersion);
  expect(readResults(logs)).toEqual(['parts', 'parts', 'unchanged']);

  // 选区所在的段落被换掉（旧选区还挂在小窗上）：不把旧选区套到新内容上，不按位置猜前后段落
  await page.evaluate(() => {
    (document.getElementById('sel') as HTMLElement).textContent = '选区段落已被网页脚本整段替换成别的话。';
  });
  const d = await convAsk(frame, { ...ask('第四次'), selectionRevision: await selRev(serviceWorker, page) });
  expect(d.plan).toMatchObject({ pageRead: false, sentBlockIds: [] });
  expect(String(d.plan?.notes)).toContain('没能在页面正文里找到选区');
  expect(parseBody(lastBody()).messages.at(-1)?.content).not.toContain('<page_content>');
  console.log(
    '[V-06] 换字',
    JSON.stringify({ a: a.plan?.contentVersion, b: b.plan?.contentVersion, reads: readResults(logs) }),
  );
});

const SPA_SCRIPT = `
const views = {
  '#/a': '视图A：第一个路由的正文，讲光合作用。',
  '#/b': '视图B：第二个路由的正文，讲呼吸作用。',
  'tab1': '标签一：查询参数切换前的正文。',
  'tab2': '标签二：查询参数切换后的正文。',
};
function render() {
  const q = new URLSearchParams(location.search).get('tab');
  document.getElementById('view').textContent = views[q ? 'tab' + q : location.hash] || views['#/a'];
}
addEventListener('hashchange', render);
window.__go = (q) => { history.pushState({}, '', q); render(); };
render();`;

test('hash 路由与查询参数切换：同一文档，pageKey 跟着变，正文按新内容读取；只加跟踪参数不算换页', async ({
  context,
  page,
  serviceWorker,
}) => {
  const logs = collectLogs(context, serviceWorker);
  await setup(serviceWorker);
  await context.route('https://e2e.test/v06/spa**', (rt) =>
    rt.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: html('单页应用', '<p id="view"></p><p>公共段落：每个视图都有的说明。</p>', SPA_SCRIPT),
    }),
  );
  await page.goto('https://e2e.test/v06/spa#/a');
  const a = (await selectAndConvAsk(page, serviceWorker, '#view', ask('A'))).res;
  expect(a.plan?.pageKey).toBe('https://e2e.test/v06/spa#/a');
  expect(lastBody()).toContain('视图A');

  await page.evaluate(() => {
    location.hash = '#/b';
  });
  await expect(page.locator('#view')).toContainText('视图B');
  const b = (await selectAndConvAsk(page, serviceWorker, '#view', ask('B'))).res;
  expect(b.plan).toMatchObject({ pageKey: 'https://e2e.test/v06/spa#/b', documentId: a.plan?.documentId });
  expect(b.plan?.contentVersion).not.toBe(a.plan?.contentVersion);
  expect(lastBody()).toContain('视图B');
  expect(lastBody()).not.toContain('视图A');

  await page.evaluate(() => (window as unknown as { __go(q: string): void }).__go('?tab=1'));
  const t1 = (await selectAndConvAsk(page, serviceWorker, '#view', ask('T1'))).res;
  expect(t1.plan?.pageKey).toBe('https://e2e.test/v06/spa?tab=1');
  await page.evaluate(() => (window as unknown as { __go(q: string): void }).__go('?tab=2'));
  const t2 = (await selectAndConvAsk(page, serviceWorker, '#view', ask('T2'))).res;
  expect(t2.plan).toMatchObject({
    pageKey: 'https://e2e.test/v06/spa?tab=2',
    documentId: a.plan?.documentId,
  });
  expect(lastBody()).toContain('标签二');
  expect(lastBody()).not.toContain('标签一');

  // 只加跟踪参数、内容不变：pageKey 不变，指纹不变，用缓存
  await page.evaluate(() => (window as unknown as { __go(q: string): void }).__go('?tab=2&utm_source=x'));
  const frame = await floatFrame(page);
  const t3 = await convAsk(frame, { ...ask('T3'), selectionRevision: await selRev(serviceWorker, page) });
  expect(t3.plan).toMatchObject({ pageKey: t2.plan?.pageKey, contentVersion: t2.plan?.contentVersion });
  expect(readResults(logs).at(-1)).toBe('unchanged');
});

/** 本机 HTTP 服务：前进后退用例不走 page.route（请求拦截可能让页面不进往返缓存），由真实服务器返回页面 */
async function startPages(pages: Record<string, string>): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    const body = pages[req.url ?? ''];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

/**
 * 前进后退要真的走往返缓存：Playwright 默认带 --disable-back-forward-cache，这个用例单独起一个不带它的浏览器
 * （其余同 fixtures.ts，不改共用夹具）
 */
const bfTest = test.extend<{ context: BrowserContext }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture 约定
  context: async ({}, use) => {
    const edge = process.env.E2E_BROWSER === 'msedge';
    const context = await chromium.launchPersistentContext('', {
      channel: edge ? 'msedge' : 'chromium',
      ...(edge ? { headless: false } : {}),
      ...(!edge && process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    // 自己起的浏览器同样是首次安装：关掉自动打开的欢迎页，免得它抢走前台
    await dismissWelcome(context);
    await use(context);
    await context.close();
  },
});

bfTest(
  '前进后退：回到旧页面按旧页面的内容读取；记录是否命中往返缓存及原因',
  async ({ page, serviceWorker }) => {
    await setup(serviceWorker);
    const pageshow = `addEventListener('pageshow', (e) => { document.body.dataset.persisted = String(e.persisted); });`;
    const site = await startPages({
      '/p1': html('第一页', '<p id="t">第一页正文：讲的是唐朝的历史。</p>', pageshow),
      '/p2': html('第二页', '<p id="t">第二页正文：讲的是宋朝的历史。</p>', pageshow),
      '/q1': html('第三页', '<p id="t">第三页正文：讲的是元朝的历史。</p>', pageshow),
      '/q2': html('第四页', '<p id="t">第四页正文：讲的是明朝的历史。</p>', pageshow),
    });
    // 往返缓存没用上时浏览器给出的原因（调试协议事件），写进记录
    const cdp = await page.context().newCDPSession(page);
    let notUsed: string[] = [];
    cdp.on('Page.backForwardCacheNotUsed', (e: { notRestoredExplanations?: { reason: string }[] }) => {
      notUsed = (e.notRestoredExplanations ?? []).map((x) => x.reason);
    });
    await cdp.send('Page.enable');
    const back = async (text: string) => {
      notUsed = [];
      // 从往返缓存恢复不触发 load，只等到提交
      await page.goBack({ waitUntil: 'commit' });
      await expect(page.locator('#t')).toContainText(text);
      return page.evaluate(() => document.body.dataset.persisted);
    };
    try {
      await test.step('没用过小窗的页面：后退从往返缓存恢复，之后提问按这一页的内容', async () => {
        await page.goto(`${site.url}/q1`);
        await page.goto(`${site.url}/q2`);
        const persisted = await back('元朝');
        console.log('[V-06] 后退（未交互）', JSON.stringify({ persisted, notRestoredReasons: notUsed }));
        const c = (await selectAndConvAsk(page, serviceWorker, '#t', ask('元'))).res;
        expect(c.states.at(-1)).toBe('completed');
        expect(c.plan?.pageKey).toBe(`${site.url}/q1`);
        expect(lastBody()).toContain('元朝');
        expect(lastBody()).not.toContain('明朝');
      });

      await test.step('用过小窗的页面：后退时是新文档（不进往返缓存），按旧页面内容重新读取', async () => {
        await page.goto(`${site.url}/p1`);
        const a = (await selectAndConvAsk(page, serviceWorker, '#t', ask('一'))).res;
        await page.goto(`${site.url}/p2`);
        const b = (await selectAndConvAsk(page, serviceWorker, '#t', ask('二'))).res;
        expect(b.plan?.documentId).not.toBe(a.plan?.documentId);
        expect(lastBody()).toContain('宋朝');
        const persisted = await back('唐朝');
        const c = (await selectAndConvAsk(page, serviceWorker, '#t', ask('三'))).res;
        console.log(
          '[V-06] 后退（用过小窗）',
          JSON.stringify({
            persisted,
            notRestoredReasons: notUsed,
            sameDocument: c.plan?.documentId === a.plan?.documentId,
            sameVersion: c.plan?.contentVersion === a.plan?.contentVersion,
          }),
        );
        expect(c.states.at(-1)).toBe('completed');
        expect(c.plan).toMatchObject({ pageKey: a.plan?.pageKey, contentVersion: a.plan?.contentVersion });
        // 往返缓存恢复时是同一个文档；不命中时是新文档。两种都必须按第一页的内容读取
        if (persisted === 'true') expect(c.plan?.documentId).toBe(a.plan?.documentId);
        else expect(c.plan?.documentId).not.toBe(a.plan?.documentId);
        expect(lastBody()).toContain('唐朝');
        expect(lastBody()).not.toContain('宋朝');
      });
    } finally {
      await cdp.detach().catch(() => undefined);
      await site.close();
    }
  },
);

test('同一 URL 两个标签页内容不同：各读各的，缓存不串', async ({ context, page, serviceWorker }) => {
  await setup(serviceWorker);
  let n = 0;
  await context.route('https://e2e.test/v06/same', (rt) => {
    n += 1;
    const body = n === 1 ? '标签页甲的正文：苹果。' : '标签页乙的正文：香蕉。';
    return rt.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: html(`同址页面${n}`, `<p id="t">${body}</p>`),
    });
  });
  await page.goto('https://e2e.test/v06/same');
  const page2 = await context.newPage();
  await page2.goto('https://e2e.test/v06/same');

  const a = (await selectAndConvAsk(page, serviceWorker, '#t', ask('甲'))).res;
  expect(lastBody()).toContain('苹果');
  await page2.bringToFront();
  const b = (await selectAndConvAsk(page2, serviceWorker, '#t', ask('乙'))).res;
  expect(lastBody()).toContain('香蕉');
  expect(lastBody()).not.toContain('苹果');
  expect(b.plan?.pageKey).toBe(a.plan?.pageKey);
  expect(b.plan?.documentId).not.toBe(a.plan?.documentId);
  expect(b.plan?.contentVersion).not.toBe(a.plan?.contentVersion);
  // 回到第一个标签页再问：仍是苹果
  await page.bringToFront();
  const a2 = (await selectAndConvAsk(page, serviceWorker, '#t', ask('甲二'))).res;
  expect(a2.plan?.contentVersion).toBe(a.plan?.contentVersion);
  expect(lastBody()).toContain('苹果');
  expect(lastBody()).not.toContain('香蕉');
});

test('模型回答前导航：在途任务按原版本跑完，新页面的发问用新版本', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  const slow = await startRelay(0.1); // head35 → 3.5 秒后才回响应头
  try {
    await writeSettings(serviceWorker, {
      ...settingsWith(slow),
      connections: [connection(slow, { baseUrl: `${slow.relay.url}/m/head35/v1` })],
    });
    await waitSentinelRegistered(serviceWorker);
    for (const [path, text] of [
      ['n1', '导航前页面：讲的是长江。'],
      ['n2', '导航后页面：讲的是黄河。'],
    ] as const) {
      await context.route(`https://e2e.test/v06/${path}`, (rt) =>
        rt.fulfill({ contentType: 'text/html; charset=utf-8', body: html(path, `<p id="t">${text}</p>`) }),
      );
    }
    await page.goto('https://e2e.test/v06/n1');
    const a = (await selectAndConvAsk(page, serviceWorker, '#t', ask('长江'), { untilPlan: true })).res;
    await expect.poll(() => slow.bodies.length).toBe(1);
    await page.goto('https://e2e.test/v06/n2'); // 小窗随旧页面销毁，任务归后台，照常跑完（规则 2）
    await expect
      .poll(
        async () => (await sessionJobs(serviceWorker)).find((j) => j.jobId === a.accepted?.jobId)?.state,
        {
          timeout: 15_000,
        },
      )
      .toBe('completed');
    const b = (await selectAndConvAsk(page, serviceWorker, '#t', ask('黄河'))).res;
    expect(b.states.at(-1)).toBe('completed');
    expect(slow.bodies[0]).toContain('长江');
    expect(slow.bodies[0]).not.toContain('黄河');
    expect(slow.bodies[1]).toContain('黄河');
    expect(slow.bodies[1]).not.toContain('长江');
    // 旧回答的计划仍是导航前的文档与版本；新发问是新文档
    expect(a.plan?.documentId).not.toBe(b.plan?.documentId);
    expect(a.plan?.contentVersion).not.toBe(b.plan?.contentVersion);
    expect(a.plan?.pageKey).toBe('https://e2e.test/v06/n1');
    expect(b.plan?.pageKey).toBe('https://e2e.test/v06/n2');
  } finally {
    await slow.relay.close();
  }
});
