// 转到侧边栏（V-11、6.4、AR-19）：小窗里点「转到侧边栏」是扩展页面上的用户手势，点击处理里同步 sidePanel.open；
// 侧边栏连上、订阅、收到初始推送后后台才通知小窗收起。流式中途转接要无缝续上；侧边栏先连上、转接后到；
// 转接时小窗被关掉；侧边栏迟迟没连上（小窗不收起，给一行提示）。
import type { Frame, Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { expect, test } from './fixtures';
import {
  askInFloat,
  clickAsk,
  connection,
  type Relay,
  selectAndOpen,
  settingsWith,
  startRelay,
  writeSettings,
} from './page-helpers';
import {
  attachPanel,
  expectPanels,
  openPanelByTrustedClick,
  panelContexts,
  panelText,
} from './sidepanel-helpers';

declare const chrome: typeof browser;

const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>转接测试文章</title></head>
<body><article><h1>转接测试文章</h1><p>第一段。</p><p id="target">${PARAGRAPH}</p></article></body></html>`;

/** long 模式按 scale 缩放：0.01 → 约 3.3 秒，每秒一段「第 N 段。」 */
let r: Relay;
test.beforeAll(async () => {
  r = await startRelay(0.01);
});
test.afterAll(() => r.relay.close());
test.beforeEach(async ({ context, serviceWorker }) => {
  await r.reset();
  await writeSettings(serviceWorker, {
    ...settingsWith(r),
    connections: [connection(r, { baseUrl: `${r.relay.url}/m/long/v1` })],
  });
  await context.route('https://e2e.test/**', (rt) =>
    rt.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
});

const floatOpen = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-ra-float-host]')?.matches(':popover-open') ?? false);

/** 小窗里发问，等收到第一段正文（不等答完） */
async function askStreaming(page: Page): Promise<Frame> {
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#target');
  const input = frame.getByLabel('输入问题');
  await expect(input).toBeFocused();
  await page.keyboard.type('这段话讲了什么？');
  await input.press('Enter');
  await expect(frame.getByTestId('answer')).toContainText('第 1 段。', { timeout: 10_000 });
  return frame;
}

const occurrences = (s: string, sub: string) => s.split(sub).length - 1;

test('流式中途转接：侧边栏接着显示同一个回答（从头续播、不重不漏），接上之后小窗才收起；只发一次请求', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  const frame = await askStreaming(page);
  expect(await floatOpen(page)).toBe(true);
  await frame.getByRole('button', { name: '转到侧边栏' }).click();
  await expectPanels(serviceWorker, 1, '小窗里的点击打开了侧边栏');
  const panel = await attachPanel(context);
  // 侧边栏接上了正在生成的回答
  await expect.poll(() => panelText(panel, 'answer')).toContain('第 1 段。');
  await expect.poll(() => floatOpen(page), { message: '侧边栏接上后小窗收起' }).toBe(false);
  // 还在生成中就转过来了
  expect(['accepted', 'streaming']).toContain(await panelText(panel, 'job-state'));
  await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
  const answer = await panelText(panel, 'answer');
  const n = Number([...answer.matchAll(/第 (\d+) 段。/g)].at(-1)?.[1]);
  console.log('[V-11] 转接后侧边栏的回答共', n, '段');
  expect(n).toBeGreaterThanOrEqual(3);
  for (let i = 1; i <= n; i++) expect(occurrences(answer, `第 ${i} 段。`)).toBe(1);
  // 小窗里的那份与侧边栏一致（收起不销毁，照常收完）
  await expect(frame.getByTestId('answer')).toHaveText(answer);
  expect(r.bodies).toHaveLength(1);
  // 侧边栏引用条带着同一份选区
  expect(await panelText(panel, 'quote')).toContain(PARAGRAPH);
  await panel.detach();
});

test('侧边栏先打开、转接后到：已开的侧边栏接手这个对话，小窗收起；接着在侧边栏问带上历史', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/article');
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '第一问');
  await frame.getByRole('button', { name: '转到侧边栏' }).click();
  await expect.poll(() => floatOpen(page), { message: '小窗收起' }).toBe(false);
  // 侧边栏还是那一个（没有新开、没有闪开闪关）
  expect(await panelContexts(serviceWorker)).toHaveLength(1);
  await expect.poll(() => panelText(panel, 'job-state')).toBe('completed');
  expect(await panelText(panel, 'answer')).toContain('第 1 段。');
  await panel.click('textarea[aria-label="输入问题"]');
  await panel.type('第二问');
  await panel.press('Enter');
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(2);
  expect(r.bodies[1]).toContain('第一问');
  await panel.detach();
});

test('转接时小窗被网页移除：侧边栏照样接手对话，回答完整', async ({ context, page, serviceWorker }) => {
  test.setTimeout(60_000);
  const frame = await askStreaming(page);
  await frame.getByRole('button', { name: '转到侧边栏' }).click();
  await page.evaluate(() => document.querySelector('[data-ra-float-host]')?.remove());
  await expectPanels(serviceWorker, 1);
  const panel = await attachPanel(context);
  await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
  const answer = await panelText(panel, 'answer');
  expect(occurrences(answer, '第 1 段。')).toBe(1);
  expect(r.bodies).toHaveLength(1);
  await panel.detach();
});

test('后台被回收、侧边栏断线闲着：小窗转接叫醒它、接手对话后小窗收起；对话随旧后台没了时不转，小窗留着回答', async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const stopWorkers = async () => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await cdp.detach();
    await page.waitForTimeout(1_000);
  };
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '第一问');
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  await expect.poll(() => panelText(panel, 'job-state')).toBe('completed');
  // 两边都断线（没有在跑的任务，都闲着不重连）。小窗里接着问：小窗重连，新后台里有了新对话
  await stopWorkers();
  await page.locator('#target').click({ clickCount: 3 });
  await clickAsk(page);
  await expect.poll(() => floatOpen(page)).toBe(true);
  await askInFloat(frame, r, '第二问');
  await frame.getByRole('button', { name: '转到侧边栏' }).click();
  await expect.poll(() => floatOpen(page), { message: '侧边栏接上后小窗收起', timeout: 10_000 }).toBe(false);
  await expect.poll(() => panelText(panel, 'job-state')).toBe('completed');
  expect(await panelText(panel, 'answer')).toContain('第 1 段。');
  expect(r.bodies).toHaveLength(2);

  // 再停一次后台：内存里的对话没了，转不过去（gone）；小窗不收起，回答还在
  await stopWorkers();
  await page.locator('#target').click({ clickCount: 3 });
  await clickAsk(page);
  await expect.poll(() => floatOpen(page)).toBe(true);
  await frame.getByRole('button', { name: '转到侧边栏' }).click();
  await expect(frame.getByText('后台重启过，这段对话没法转过去')).toBeVisible({ timeout: 10_000 });
  expect(await floatOpen(page)).toBe(true);
  await expect(frame.getByTestId('answer')).toContainText('第 1 段。');
  await panel.detach();
});

test('侧边栏迟迟没接上：小窗不收起，提示一行，可以再点一次', async ({ page, serviceWorker }) => {
  test.setTimeout(60_000);
  const frame = await askStreaming(page);
  // 只在测试里：让小窗里的 sidePanel.open 什么也不做，模拟侧边栏没能打开 / 没连上
  await frame.evaluate(() => {
    (chrome.sidePanel as unknown as { open: () => Promise<void> }).open = () => Promise.resolve();
  });
  await frame.getByRole('button', { name: '转到侧边栏' }).click();
  await expect(frame.getByTestId('handoff-hint')).toBeVisible({ timeout: 10_000 });
  expect(await floatOpen(page)).toBe(true);
  expect(await panelContexts(serviceWorker)).toHaveLength(0);
  await expect(frame.getByRole('button', { name: '转到侧边栏' })).toBeEnabled();
  // 回答照常在小窗里答完
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
});
