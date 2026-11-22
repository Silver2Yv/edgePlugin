// D10：子页面（iframe）正文读取。证据是模拟中转站收到的完整请求正文与发送计划（规则 8）：
// 1. 全文档位：同源与跨源两个 iframe 的正文都进请求，块编号整页唯一、计划的 sentBlockIds 与请求里的块一致；
//    iframe 里的密码框与输入内容不进请求。
// 2. iframe 来源在「不读取」名单：它的正文不进请求，计划写明原因；不被读取的框架里也没有注入阅读器。
// 3. 在 iframe 里划词、带上下文档位：能带上 iframe 里的前后文（选区所在块在合并后的页面里找到）。
// （引用落在 iframe 块上给出明确原因，由单测 tests/unit/background/subframe-read.test.ts 覆盖。）
import type { Frame, Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { expect, test } from './fixtures';
import {
  clickAsk,
  convAsk,
  floatFrame,
  MODEL,
  pageBlocksIn,
  parseBody,
  type Relay,
  selectionRevision,
  settingsWith,
  startRelay,
  waitSentinelRegistered,
  writeSettings,
} from './page-helpers';

// evaluate 的回调在 Service Worker 里执行，那里的全局是 chrome
declare const chrome: typeof browser;

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(() => r.reset());

const model = { connectionId: 'e2e-conn-0001', model: MODEL };

const TOP_TEXT = '顶层正文：这一段在顶层页面里，讲的是光合作用的基本过程。';
const SAME_BEFORE = '同源内嵌第一段：叶绿体是光合作用的场所，位于植物细胞里。';
const SAME_SEL = '同源内嵌第二段：光反应在类囊体膜上进行，产生氧气和能量载体。';
const SAME_AFTER = '同源内嵌第三段：暗反应在叶绿体基质中固定二氧化碳。';
const CROSS_TEXT = '跨源内嵌正文：这一段来自另一个来源的页面，讲的是细胞呼吸。';
const PWD = 'IFRAME-PWD-合成秘密-0001';

const topPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>子框架读取样本</title></head>
<body><article>
<h1>子框架读取样本</h1>
<p id="top">${TOP_TEXT}</p>
</article>
<iframe id="same" src="https://e2e.test/inner-same" width="700" height="260"></iframe>
<iframe id="cross" src="https://other.test/inner-cross" width="700" height="200"></iframe>
</body></html>`;

const samePage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>同源内嵌页</title></head>
<body><article>
<h1>同源内嵌页</h1>
<p>${SAME_BEFORE}</p>
<p id="sel">${SAME_SEL}</p>
<p>${SAME_AFTER}</p>
<form><label>密码 <input id="pwd" type="password"></label></form>
</article></body></html>`;

const crossPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>跨源内嵌页</title></head>
<body><article><h1>跨源内嵌页</h1><p>${CROSS_TEXT}</p></article></body></html>`;

async function serveAll(page: Page, opts: { crossHost?: string } = {}) {
  const ctx = page.context();
  const html = (body: string) => ({ contentType: 'text/html; charset=utf-8', body });
  await ctx.route('https://e2e.test/inner-same', (rt) => rt.fulfill(html(samePage)));
  await ctx.route('https://other.test/inner-cross', (rt) => rt.fulfill(html(crossPage)));
  await ctx.route('https://e2e.test/top*', (rt) =>
    rt.fulfill(
      html(opts.crossHost ? topPage.replace('https://other.test', `https://${opts.crossHost}`) : topPage),
    ),
  );
  if (opts.crossHost)
    await ctx.route(`https://${opts.crossHost}/inner-cross`, (rt) => rt.fulfill(html(crossPage)));
}

const frameOf = (page: Page, url: string): Frame => {
  const f = page.frames().find((x) => x.url() === url);
  if (!f) throw new Error(`找不到框架 ${url}`);
  return f;
};

test('全文档位：同源与跨源 iframe 的正文都进请求，块编号整页唯一，计划与请求一致；iframe 里的输入值不进请求', async ({
  page,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await serveAll(page);
  await waitSentinelRegistered(serviceWorker);
  await page.goto('https://e2e.test/top');
  await expect.poll(() => page.frames().length).toBeGreaterThanOrEqual(3);
  // 用户在 iframe 的密码框里输入
  await frameOf(page, 'https://e2e.test/inner-same').fill('#pwd', PWD);

  await page.locator('#top').scrollIntoViewIfNeeded();
  await page.locator('#top').click({ clickCount: 3 });
  await clickAsk(page);
  const frame = await floatFrame(page);
  const rev = await selectionRevision(serviceWorker, page);
  const res = await convAsk(frame, {
    model,
    selectionRevision: rev,
    text: '总结一下',
    contextTier: 'fullPage',
  });
  expect(res.states.at(-1)).toBe('completed');

  const body = r.bodies[0] ?? '';
  const sent = parseBody(body);
  const blocks = pageBlocksIn(sent.messages[1]?.content ?? '');
  const texts = blocks.map((b) => b.text);
  expect(texts).toContain(TOP_TEXT);
  expect(texts).toContain(SAME_BEFORE);
  expect(texts).toContain(SAME_SEL);
  expect(texts).toContain(CROSS_TEXT);
  // 编号整页唯一；顶层块在前，内嵌页面的块在后
  const ids = blocks.map((b) => b.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(texts.indexOf(TOP_TEXT)).toBeLessThan(texts.indexOf(SAME_BEFORE));
  expect(texts.indexOf(TOP_TEXT)).toBeLessThan(texts.indexOf(CROSS_TEXT));
  // 计划与请求一致（规则 8）
  const plan = res.plan as { sentBlockIds: string[]; pageRead: boolean; notes: string[] };
  expect(plan.pageRead).toBe(true);
  expect(plan.sentBlockIds).toEqual(ids);
  expect(plan.notes.join()).not.toContain('子框架（iframe）内容没有读取');
  // 输入值不进请求（M6）
  expect(body).not.toContain(PWD);
  console.log('[D10] 全文档位计划', JSON.stringify({ ...plan, contextSnapshotId: undefined }));
});

test('iframe 来源在「不读取」名单：它的正文不进请求，计划写明原因，该框架里没有注入阅读器', async ({
  page,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, {
    ...settingsWith(r),
    sites: [{ host: 'blocked.test', level: 'noRead' }],
  });
  await serveAll(page, { crossHost: 'sub.blocked.test' });
  await waitSentinelRegistered(serviceWorker);
  await page.goto('https://e2e.test/top');
  await expect.poll(() => page.frames().length).toBeGreaterThanOrEqual(3);

  await page.locator('#top').scrollIntoViewIfNeeded();
  await page.locator('#top').click({ clickCount: 3 });
  await clickAsk(page);
  const frame = await floatFrame(page);
  const rev = await selectionRevision(serviceWorker, page);
  const res = await convAsk(frame, {
    model,
    selectionRevision: rev,
    text: '总结一下',
    contextTier: 'fullPage',
  });
  expect(res.states.at(-1)).toBe('completed');
  const body = r.bodies[0] ?? '';
  expect(body).toContain(TOP_TEXT);
  expect(body).toContain(SAME_SEL); // 同源 iframe 照读
  expect(body).not.toContain(CROSS_TEXT);
  const plan = res.plan as { notes: string[]; sentBlockIds: string[] };
  expect(plan.notes.join()).toContain('1 个内嵌页面按站点规则不读取');
  // 被排除的框架里阅读器没有被注入（阅读器的标记在隔离环境里，经后台的 executeScript 取）
  const injected = await serviceWorker.evaluate(
    async (tabTitle) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.title === tabTitle);
      if (!tab?.id) return undefined;
      const rs = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () =>
          (globalThis as { [k: symbol]: unknown })[Symbol.for('readingAssistant.subframeReaderInjected')] ===
          true,
      });
      return rs.map((x) => ({ url: x.result === undefined ? '' : String(x.frameId), injected: x.result }));
    },
    await page.title(),
  );
  expect(injected?.filter((x) => x.injected).length).toBe(1); // 只有同源那一个
});

test('在 iframe 里划词、带上下文档位：能带上 iframe 里的前后文，计划的块与请求一致', async ({
  page,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await serveAll(page);
  await waitSentinelRegistered(serviceWorker);
  await page.goto('https://e2e.test/top');
  await expect.poll(() => page.frames().length).toBeGreaterThanOrEqual(3);

  const inner = page.frameLocator('#same');
  await inner.locator('#sel').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((rf) => requestAnimationFrame(() => requestAnimationFrame(rf))));
  await inner.locator('#sel').click({ clickCount: 3 });
  await clickAsk(page);
  const frame = await floatFrame(page);
  const rev = await selectionRevision(serviceWorker, page);
  const res = await convAsk(frame, {
    model,
    selectionRevision: rev,
    text: '解释一下',
    contextTier: 'nearby',
  });
  expect(res.states.at(-1)).toBe('completed');

  const sent = parseBody(r.bodies[0]);
  const user = sent.messages.filter((m) => m.role !== 'system');
  const blocks = user.flatMap((m) => pageBlocksIn(m.content));
  const texts = blocks.map((b) => b.text);
  expect(texts).toContain(SAME_BEFORE);
  expect(texts).toContain(SAME_SEL);
  expect(texts).toContain(SAME_AFTER);
  expect(JSON.stringify(user)).toContain('<selected_text>');
  const plan = res.plan as {
    sentBlockIds: string[];
    pageRead: boolean;
    contextTier: string;
    notes: string[];
  };
  expect(plan).toMatchObject({ pageRead: true, contextTier: 'nearby' });
  expect(plan.sentBlockIds).toEqual(blocks.map((b) => b.id));
  expect(plan.notes.join()).not.toContain('没有按选区取前后段落');
  console.log('[D10] iframe 划词 nearby 计划', JSON.stringify({ ...plan, contextSnapshotId: undefined }));
});
