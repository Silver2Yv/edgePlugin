// live（contract-v1.5，D11、B5、5.1、5.6）：引用实时更新、后台发起的任务补上提问、页面已变化提示。
// 图钉场景（钉住后换选一段）已在 chat-ui.spec.ts 的图钉用例里覆盖；这里补侧边栏、没有界面开着、
// 工具栏直接发送的动作、页面变化这几块。
import { expect, test } from './fixtures';
import {
  askInFloat,
  clickToolbarButton,
  collectLogs,
  type Relay,
  selectAndOpen,
  settingsWith,
  startRelay,
  waitSentinelRegistered,
  writeSettings,
} from './page-helpers';
import { attachPanel, openPanelByTrustedClick, panelText } from './sidepanel-helpers';

const SITE = 'https://e2e.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const FIRST = '第一段：这是一篇用来做 live 端到端测试的文章。';

const article = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>live 测试</title></head>
<body><article>
<h1>live 测试</h1>
<p id="p1">${FIRST}</p>
<p id="target">${PARAGRAPH}</p>
</article></body></html>`;

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(() => r.reset());

async function serve(page: import('@playwright/test').Page) {
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: article() }),
  );
}

test('没有小窗/侧边栏开着时，新选区不产生带文字的意图（隐私：没人看着就不上报）', async ({
  context,
  page,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await serve(page);
  const logs = collectLogs(context, serviceWorker);
  await waitSentinelRegistered(serviceWorker);
  await page.goto(`${SITE}article`);
  await page.locator('#target').click({ clickCount: 3 });
  await page.mouse.click(5, 5); // 收起工具栏，换一次选区
  await page.locator('#p1').click({ clickCount: 3 });
  await page.waitForTimeout(500);
  // selection/ready（弹工具栏用）会有；selection/live（实时上报文字）一次都不该有
  expect(logs.events('selection/live')).toEqual([]);
});

test('侧边栏开着时，新选中的文字立即更新引用（验收第 2 条）', async ({ context, page, serviceWorker }) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await serve(page);
  await waitSentinelRegistered(serviceWorker);
  await page.goto(`${SITE}article`);
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  // 侧边栏订阅、后台广播 live/toggle、哨兵收到都是异步的，留一点时间（同例：图钉状态经私有端口到阅读器）
  await page.waitForTimeout(600);

  await page.locator('#target').click({ clickCount: 3 });
  await expect.poll(() => panelText(panel, 'quote'), { timeout: 5_000 }).toContain(PARAGRAPH);
  // 不点「问」，直接换选另一段：引用立即变成新内容
  await page.locator('#p1').click({ clickCount: 3 });
  await expect.poll(() => panelText(panel, 'quote'), { timeout: 5_000 }).toContain(FIRST);
  await panel.detach();
});

test('工具栏直接发送的动作：已经开着的小窗能看到这一轮的提问（不只有回答）', async ({
  page,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await serve(page);
  await waitSentinelRegistered(serviceWorker);
  await page.goto(`${SITE}article`);
  // 先问一轮，小窗开着、订阅着（之后「解释」是后台自己起的任务，不是这个小窗发的）
  const frame = await selectAndOpen(page, '#p1');
  await askInFloat(frame, r, '这段讲了什么？', { fill: true });
  await expect(frame.getByTestId('user-message')).toHaveCount(1);

  await page.locator('#target').click({ clickCount: 3 });
  await clickToolbarButton(page, '解释');
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
  // 新来的这一轮多了一条用户消息（引用摘要是新选中的那段；直接发送的动作没有问题文字，显示动作名）
  await expect(frame.getByTestId('user-message')).toHaveCount(2);
  const latest = frame.getByTestId('user-message').last();
  await expect(latest).toContainText(PARAGRAPH.slice(0, 20));
  await expect(latest).toContainText('解释');
  await expect(latest).not.toContainText('没有输入问题');
});

test('改动页面正文后，界面出现「页面内容已变化」提示', async ({ page, serviceWorker }) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await serve(page);
  await waitSentinelRegistered(serviceWorker);
  await page.goto(`${SITE}article`);
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '这段讲了什么？', { fill: true });
  await expect(frame.getByTestId('page-changed-notice')).toHaveCount(0);

  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'injected';
    p.textContent =
      '这是脚本后来插入的一大段新内容，用来触发页面变化检测，字数要够多才会被当成实质变化。'.repeat(3);
    document.querySelector('article')?.appendChild(p);
  });
  await expect(frame.getByTestId('page-changed-notice')).toBeVisible({ timeout: 5_000 });
});
