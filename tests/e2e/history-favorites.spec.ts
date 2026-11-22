// 收藏与历史（核心功能开发第二批，G1–G3、C2、C5，验收第 13 条）：
// 工具栏「存」落库后按钮变「已存」、侧边栏收藏能看到并搜到；回答上的「存」；历史搜索与删除；本页对话列表切换。
// 导出 Markdown 的格式已由 tests/unit/core/favorite-export.test.ts 覆盖，这里不重复断言下载内容。
import { expect, test } from './fixtures';
import {
  ANSWER,
  askInFloat,
  clickToolbarButton,
  type Relay,
  selectAndOpen,
  settingsWith,
  startRelay,
  writeSettings,
} from './page-helpers';
import { askInPanel, attachPanel, openPanelByTrustedClick, panelText } from './sidepanel-helpers';

/** 工具栏「存」点了之后是一行文字提示（toolbar.ts 的 tip()，不是按钮），封闭 shadow DOM 里，
 * 用调试协议顺着 shadow 根找文本节点（与 page-helpers.ts 的 findByLabel 同一手法） */
interface TextNode {
  nodeName: string;
  nodeValue?: string;
  children?: TextNode[];
  shadowRoots?: TextNode[];
  contentDocument?: TextNode;
}
function findText(node: TextNode, text: string): boolean {
  if (node.nodeName === '#text' && node.nodeValue?.includes(text)) return true;
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    if (findText(child, text)) return true;
  }
  return node.contentDocument ? findText(node.contentDocument, text) : false;
}
async function toolbarShowsText(cdp: import('@playwright/test').CDPSession, text: string): Promise<boolean> {
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: TextNode };
  return findText(root, text);
}

const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const article = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>收藏测试文章</title></head>
<body><article><h1>收藏测试文章</h1><p id="target">${PARAGRAPH}</p></article></body></html>`;

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(async ({ context, serviceWorker }) => {
  await r.reset();
  await writeSettings(serviceWorker, settingsWith(r));
  await context.route('https://e2e.test/**', (rt) =>
    rt.fulfill({ contentType: 'text/html; charset=utf-8', body: article }),
  );
});

test('工具栏「存」：落库后按钮变「已存」；侧边栏收藏里能看到并搜到（验收第 13 条）', async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/a');
  await page.locator('#target').click({ clickCount: 3 });
  await clickToolbarButton(page, '存');
  const cdp = await page.context().newCDPSession(page);
  await expect.poll(() => toolbarShowsText(cdp, '已存'), { message: '工具栏提示「已存」' }).toBe(true);
  await cdp.detach();

  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  await panel.click('[data-testid="panel-nav-favorites"]');
  await expect
    .poll(() => panel.evaluate<number>('document.querySelectorAll(\'[data-testid="favorite-item"]\').length'))
    .toBe(1);
  expect(await panel.text('.ra-favorite-text')).toContain(PARAGRAPH);

  // 搜索原文里的一段：能搜到
  await panel.click('[data-testid="favorites-search"]');
  await panel.type(PARAGRAPH.slice(0, 6));
  await expect
    .poll(() => panel.evaluate<number>('document.querySelectorAll(\'[data-testid="favorite-item"]\').length'))
    .toBe(1);

  // 清空再搜一个不存在的词：搜不到
  await panel.evaluate(`(() => {
    const el = document.querySelector('[data-testid="favorites-search"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await panel.type('这个词绝对搜不到吧');
  await expect
    .poll(() => panel.evaluate<number>('document.querySelectorAll(\'[data-testid="favorite-item"]\').length'))
    .toBe(0);
  await panel.detach();
});

test('回答上的「存」：按钮变「已存」', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/a');
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '这段话讲了什么？');
  await frame.getByTestId('answer-save').click();
  await expect(frame.getByTestId('answer-save')).toHaveText('已存', { timeout: 5_000 });
  await expect(frame.getByTestId('answer-save')).toBeDisabled();
});

test('历史：能搜到一个对话并删除它', async ({ context, page }) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/a');
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '这段话讲了什么？');

  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  await panel.click('[data-testid="panel-nav-history"]');
  await expect
    .poll(() => panel.evaluate<number>('document.querySelectorAll(\'[data-testid="history-item"]\').length'))
    .toBe(1);

  await panel.click('[data-testid="history-search"]');
  await panel.type('这段话讲了什么');
  await expect
    .poll(() => panel.evaluate<number>('document.querySelectorAll(\'[data-testid="history-item"]\').length'))
    .toBe(1);

  await panel.click('[data-testid="history-delete"]');
  await panel.click('[data-testid="history-delete-confirm"]');
  await expect
    .poll(() => panel.evaluate<number>('document.querySelectorAll(\'[data-testid="history-item"]\').length'))
    .toBe(0);
  await panel.detach();
});

test('本页对话列表（C2）：切回较早的对话，看到的是它自己的提问', async ({ context, page }) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/a');
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '第一个问题');

  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  await expect.poll(() => panelText(panel, 'answer')).toBe(ANSWER);

  // 点「新对话」，再问第二个问题：按续接规则不会接回刚才那个对话（fresh）
  await panel.click('[aria-label="新对话"]');
  await askInPanel(panel, '第二个问题');
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
  expect(await panel.text('[data-testid="user-message"]')).toContain('第二个问题');

  // 本页对话列表：切回第一个对话
  await panel.click('.ra-conv-switcher > button');
  await expect
    .poll(() => panel.evaluate<number>('document.querySelectorAll(".ra-conv-switcher__panel button").length'))
    .toBe(2);
  const firstConvId =
    await panel.evaluate<string>(`[...document.querySelectorAll('.ra-conv-switcher__panel button')]
    .map((b) => b.getAttribute('data-conversation-id')).at(-1)`);
  await panel.click(`.ra-conv-switcher__panel button[data-conversation-id="${firstConvId}"]`);
  await expect.poll(() => panelText(panel, 'job-state')).toBe('completed');
  await expect.poll(() => panel.text('[data-testid="user-message"]')).toContain('第一个问题');
  await panel.detach();
});
