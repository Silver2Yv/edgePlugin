// 小窗空闲销毁（决策 078/101，5.3 预热与回收）：收起（或预热后从未显示）满 10 分钟，阅读器销毁 iframe 并通知后台；
// 后台作废这个文档的绑定与令牌，再次显示（工具栏「问」）按「没有小窗」走：新建、新令牌，对话从后台恢复。
//
// 不可能真等 10 分钟：计时在阅读器所在的隔离环境里（内容脚本世界），这里用调试协议在那个世界里把
// setTimeout 包一层，只把「恰好 10 分钟」的那一种延时换成几百毫秒。这是测试自己对自己那一页做的手脚，
// 生产代码里没有任何开关或后门，也不影响其他延时（加载超时 5 秒等）。
import type { Page, Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { FLOAT_LIMITS } from '../../src/core/domain/float';
import { expect, test } from './fixtures';
import {
  askInFloat,
  clickAsk,
  connection,
  floatFrame,
  type Relay,
  selectAndOpen,
  sessionJobs,
  settingsWith,
  startRelay,
  tripleClick,
  writeSettings,
} from './page-helpers';

// evaluate 的回调在 Service Worker 里执行，那里的全局是 chrome
declare const chrome: typeof browser;

const SITE = 'https://e2e.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>空闲销毁测试文章</title></head>
<body><article>
<h1>空闲销毁测试文章</h1>
<p id="p1">第一段：这是一篇用来做端到端测试的文章，内容无关紧要。</p>
<p id="target">${PARAGRAPH}</p>
<p>第三段：选中上面那段文字，点工具栏里的「问」，在小窗里提问。</p>
</article></body></html>`;
const ANSWER = '这是模拟中转站的回答。它分多段流式返回。';
/** 缩短后的「10 分钟」。要比点击收起到发起下一步的间隔长得多，又不能让用例等太久 */
const SHORT_IDLE_MS = 1_000;

let r: Relay;

test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(() => r.reset());

async function setup(page: Page, sw: Worker, mode: 'ok' | 'markdown' = 'ok'): Promise<void> {
  const conn = connection(r, mode === 'ok' ? {} : { baseUrl: `${r.relay.url}/m/${mode}/v1` });
  await writeSettings(sw, settingsWith(r, { connections: [conn] }));
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
  await page.goto(`${SITE}article`);
  await shortenIdleTimer(page);
}

/**
 * 在这一页的扩展隔离环境里，把恰好 FLOAT_LIMITS.idleDestroyMs 的 setTimeout 缩短成 SHORT_IDLE_MS。
 * 要在页面加载后、小窗被收起之前做（计时是收起那一刻才起的）；页面导航后隔离环境重建，补丁随之消失
 */
async function shortenIdleTimer(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const worlds: number[] = [];
  cdp.on('Runtime.executionContextCreated', (e) => {
    if (e.context.origin.startsWith('chrome-extension://')) worlds.push(e.context.id);
  });
  await cdp.send('Runtime.enable');
  await expect.poll(() => worlds.length, { message: '内容脚本的隔离环境出现' }).toBeGreaterThan(0);
  const expression = `(() => {
    const orig = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => orig(fn, ms === ${FLOAT_LIMITS.idleDestroyMs} ? ${SHORT_IDLE_MS} : ms, ...args);
  })()`;
  for (const contextId of worlds) await cdp.send('Runtime.evaluate', { contextId, expression });
  await cdp.detach();
}

const hostPresent = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-ra-float-host]') !== null);
const hostOpen = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-ra-float-host]')?.matches(':popover-open') ?? false);
const hasFloatFrame = (page: Page) =>
  page.frames().some((f) => {
    try {
      return new URL(f.url()).pathname === '/float.html';
    } catch {
      return false;
    }
  });
const bindingKeys = (sw: Worker) =>
  sw.evaluate(async () =>
    Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('floatBinding:')),
  );

test('收起满时限后销毁（网页里没有小窗宿主）→ 再点「问」新建小窗，看到之前的对话', async ({
  page,
  serviceWorker,
}) => {
  await setup(page, serviceWorker);
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '这句话什么意思？');
  await expect.poll(() => bindingKeys(serviceWorker), { message: '小窗已握手并绑定' }).toHaveLength(1);

  // 收起：点网页别处。计时开始，到点销毁
  await page.mouse.click(5, 5);
  await expect.poll(() => hostOpen(page)).toBe(false);
  await expect
    .poll(() => hostPresent(page), { message: '到点后宿主 div 被移除', timeout: 10_000 })
    .toBe(false);
  expect(hasFloatFrame(page)).toBe(false);
  // 后台作废了绑定
  await expect.poll(() => bindingKeys(serviceWorker), { message: '绑定作废' }).toHaveLength(0);

  // 再次选中、点「问」：新建小窗（新 iframe、新令牌），对话从后台恢复
  await tripleClick(page, '#target');
  await clickAsk(page);
  const again = await floatFrame(page);
  // 预热出来的隐藏 iframe 在点「问」之前就已经有了，floatFrame 会先返回它；等后台的显示指令到位
  await expect.poll(() => hostOpen(page), { message: '小窗显示出来' }).toBe(true);
  await expect(again.getByLabel('输入问题')).toBeFocused();
  await expect(again.locator('[data-testid="answer"], [data-testid="history-answer"]').last()).toContainText(
    ANSWER,
    { timeout: 10_000 },
  );
  await expect.poll(() => bindingKeys(serviceWorker), { message: '新小窗握手后重新绑定' }).toHaveLength(1);
  // 没有为了恢复对话重新发请求
  expect(await r.chatLog()).toHaveLength(1);

  // 新小窗照常能接着问
  await askInFloat(again, r, '再解释一遍');
  expect(await r.chatLog()).toHaveLength(2);
});

test('预热后从未显示：满时限同样销毁；之后点「问」新建并正常出现', async ({ page, serviceWorker }) => {
  await setup(page, serviceWorker);
  // 划词，工具栏出现即预热隐藏的小窗；不点「问」
  await tripleClick(page, '#target');
  await expect.poll(() => hostPresent(page), { message: '预热出隐藏的小窗' }).toBe(true);
  expect(await hostOpen(page)).toBe(false);
  await expect.poll(() => hostPresent(page), { message: '到点销毁', timeout: 10_000 }).toBe(false);

  // 选区还在、工具栏还在：直接点「问」
  await clickAsk(page);
  const frame = await floatFrame(page);
  // 预热出来的隐藏 iframe 在点「问」之前就已经有了，floatFrame 会先返回它；等后台的显示指令到位
  await expect.poll(() => hostOpen(page), { message: '小窗显示出来' }).toBe(true);
  await expect(frame.getByLabel('输入问题')).toBeFocused();
  await askInFloat(frame, r, '这句话什么意思？');
});

test('生成中收起、到点销毁：任务照常跑完，再打开看到完整回答，只发过一次请求（规则 2）', async ({
  page,
  serviceWorker,
}) => {
  await setup(page, serviceWorker, 'markdown');
  const frame = await selectAndOpen(page, '#target');
  await frame.getByLabel('输入问题').fill('渲染一下这份文档');
  await frame.getByLabel('输入问题').press('Enter');
  await expect(frame.getByTestId('job-state').last()).toHaveText('streaming', { timeout: 5_000 });

  await page.mouse.click(5, 5);
  await expect.poll(() => hostPresent(page), { message: '到点销毁', timeout: 10_000 }).toBe(false);
  // 销毁时任务还在跑（markdown 模式要流约 2 秒），没有被打断
  expect((await sessionJobs(serviceWorker)).map((j) => j.state)).not.toContain('completed');

  await expect
    .poll(async () => (await sessionJobs(serviceWorker)).map((j) => j.state), {
      message: '后台任务生成完成',
      timeout: 15_000,
    })
    .toContain('completed');

  await tripleClick(page, '#target');
  await clickAsk(page);
  const again = await floatFrame(page);
  await expect(again.locator('[data-testid="answer"], [data-testid="history-answer"]').last()).toContainText(
    '正文结束',
    { timeout: 10_000 },
  );
  expect(await r.chatLog()).toHaveLength(1);
});
