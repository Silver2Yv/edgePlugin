// 工具栏直接发送的动作（A2、A3、A6、A7）：划词点「解释」直接在小窗/侧边栏出回答，不经过输入框；
// 代码块里第一个按钮是「解释代码」；工具栏按 PageConfig 排序，超过 5 个收进「更多」；超长选区先确认。
import { expect, test } from './fixtures';
import {
  askButtonCenter,
  askInFloat,
  clickAsk,
  clickToolbarButton,
  floatFrame,
  parseBody,
  type Relay,
  settingsWith,
  startRelay,
  toolbarButtonCenter,
  waitSentinelRegistered,
  writeSettings,
} from './page-helpers';
import { attachPanel, openPanelByTrustedClick, panelText } from './sidepanel-helpers';

const SITE = 'https://e2e.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const CODE = 'function add(a, b) { return a + b; }';

const article = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>工具栏动作测试</title></head>
<body><article>
<h1>工具栏动作测试</h1>
<p id="target">${PARAGRAPH}</p>
<pre><code id="code">${CODE}</code></pre>
<p id="long">${'长'.repeat(5001)}</p>
</article></body></html>`;

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(() => r.reset());

test('划词点「解释」：小窗直接出回答，不经过输入框', async ({ page, serviceWorker }) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: article() }),
  );
  await waitSentinelRegistered(serviceWorker);
  await page.goto(`${SITE}article`);
  await page.locator('#target').click({ clickCount: 3 });
  await clickToolbarButton(page, '解释');
  const frame = await floatFrame(page);
  // 不填写输入框、不按回车：直接看到回答
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
  expect(r.bodies).toHaveLength(1);
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).toContain(PARAGRAPH);
});

test('侧边栏开着时点「解释」：在侧边栏回答，不开小窗', async ({ context, page, serviceWorker }) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: article() }),
  );
  await waitSentinelRegistered(serviceWorker);
  await page.goto(`${SITE}article`);
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);

  await page.locator('#target').click({ clickCount: 3 });
  await clickToolbarButton(page, '解释');
  await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
  expect(
    await page.evaluate(
      () => document.querySelector('[data-ra-float-host]')?.matches(':popover-open') ?? false,
    ),
  ).toBe(false);
  expect(r.bodies).toHaveLength(1);
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).toContain(PARAGRAPH);
  await panel.detach();
});

test('代码块里第一个按钮是「解释代码」（A6），直接发请求带上代码', async ({ page, serviceWorker }) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: article() }),
  );
  await waitSentinelRegistered(serviceWorker);
  await page.goto(`${SITE}article`);
  // 三击在只有一个代码块、后面紧跟着别的块级元素时可能越界选到下一个元素（浏览器行为），
  // 改用鼠标拖选，稳定落在 code 元素内部
  const box = await page.locator('#code').boundingBox();
  if (!box) throw new Error('找不到代码块');
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  const cdp = await page.context().newCDPSession(page);
  await expect
    .poll(async () => (await toolbarButtonCenter(cdp, '解释代码')) !== undefined, {
      message: '工具栏第一个按钮是「解释代码」',
    })
    .toBe(true);
  // 普通「问」不应该还在（已被替换）
  expect(await askButtonCenter(cdp)).toBeUndefined();
  await cdp.detach();
  await clickToolbarButton(page, '解释代码');
  const frame = await floatFrame(page);
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).toContain(CODE);
});

test('「更多」里的动作能用：隐藏的按钮收进展开面板，点了照常发请求', async ({ page, serviceWorker }) => {
  await writeSettings(serviceWorker, {
    ...settingsWith(r),
    toolbarActions: ['ask', 'explain', 'save', 'translate', 'keyPoints', 'pageAbout'],
  });
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: article() }),
  );
  await waitSentinelRegistered(serviceWorker);
  await page.goto(`${SITE}article`);
  // 第一次选中时后台配置可能还没问回来（出厂默认工具栏只有 3 个按钮，不强求这一次立刻更新）；
  // 再选一次，这次配置已经到了，按钮列表才是设置里的那份
  await page.locator('#target').click({ clickCount: 3 });
  await page.waitForTimeout(300);
  await page.mouse.click(5, 5);
  await page.locator('#target').click({ clickCount: 3 });
  const cdp = await page.context().newCDPSession(page);
  await expect
    .poll(async () => (await toolbarButtonCenter(cdp, '更多')) !== undefined, { message: '「更多」出现' })
    .toBe(true);
  await cdp.detach();
  await clickToolbarButton(page, '更多');
  // 6 个动作超过 TOOLBAR_MAX(5)，留一个位置给「更多」：前 4 个（ask/explain/save/translate）直接显示，
  // 「提取要点」「这页在讲什么」收进「更多」
  await clickToolbarButton(page, '提取要点');
  const frame = await floatFrame(page);
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).toContain(PARAGRAPH);
});

const floatOpen = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.querySelector('[data-ra-float-host]')?.matches(':popover-open') ?? false);

test('超长选区（超过约 5000 字）：先确认一次才发送；「问」也算', async ({ page, serviceWorker }) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: article() }),
  );
  await waitSentinelRegistered(serviceWorker);
  await page.goto(`${SITE}article`);
  await page.locator('#long').click({ clickCount: 3 });
  await clickAsk(page);
  // 点了「问」之后不会立即打开小窗：工具栏先转成确认提示，小窗（即使已预热）不显示
  await page.waitForTimeout(500);
  expect(await floatOpen(page)).toBe(false);
  const cdp = await page.context().newCDPSession(page);
  await expect
    .poll(async () => (await toolbarButtonCenter(cdp, '确认')) !== undefined, { message: '确认按钮出现' })
    .toBe(true);
  await cdp.detach();
  await clickToolbarButton(page, '确认');
  // 确认之后才像平常一样打开小窗等输入（「问」本来就要等用户输入，确认只是多了这一步）
  const frame = await floatFrame(page);
  await askInFloat(frame, r, '这段讲了什么？', { fill: true });
});

test('点「存」：工具栏上提示一句，不发请求', async ({ page, serviceWorker }) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: article() }),
  );
  await waitSentinelRegistered(serviceWorker);
  await page.goto(`${SITE}article`);
  await page.locator('#target').click({ clickCount: 3 });
  await clickToolbarButton(page, '存');
  await page.waitForTimeout(500);
  expect(await floatOpen(page)).toBe(false);
  expect(r.bodies).toHaveLength(0);
});
