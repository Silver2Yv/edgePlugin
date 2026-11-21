// 无预热入口与降级路由（V-02、5.2、6.3）：冷启动、后台休眠后点「问」；小窗加载失败、握手失败；
// 快捷键无选区唤起小窗；右键「问」「总结本页」。快捷键与右键在后台里直接触发处理函数（没有用户手势，
// 打开侧边栏那一步会被拒，测的是其余逻辑；手势那一步见 V-02 记录的手动检查清单）。
import type { CDPSession, Page, Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { expect, test } from './fixtures';
import {
  ANSWER,
  askInFloat,
  clickAsk,
  floatFrame,
  parseBody,
  type Relay,
  selectAndOpen,
  settingsWith,
  startRelay,
  writeSettings,
} from './page-helpers';
import {
  attachPanel,
  dispatchCommand,
  dispatchMenu,
  expectPanels,
  openPanelByTrustedClick,
  panelContexts,
  panelText,
  tabOf,
} from './sidepanel-helpers';

declare const chrome: typeof browser;

const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>路由测试文章</title></head>
<body><article><h1>路由测试文章</h1><p>第一段：路由测试用的文章。</p><p id="target">${PARAGRAPH}</p>
<p>第三段：总结时也会读到这一段。</p></article></body></html>`;

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(async ({ context, serviceWorker }) => {
  await r.reset();
  await writeSettings(serviceWorker, settingsWith(r));
  await context.route('https://e2e.test/**', (rt) =>
    rt.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
});

const floatOpen = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-ra-float-host]')?.matches(':popover-open') ?? false);

const readiness = (sw: Worker, tabId: number) =>
  sw.evaluate(async (t) => (await chrome.storage.session.get(`float:${t}`))[`float:${t}`], tabId);

const stopWorkers = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
};

interface DomNode {
  nodeType: number;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

/** 网页上的一行提示（封闭 shadow root 里）：用调试协议穿透取文字；没有或已收起返回 null */
async function pageNotice(page: Page): Promise<string | null> {
  const open = await page.evaluate(
    () => document.querySelector('[data-ra-page-notice]')?.matches(':popover-open') ?? false,
  );
  if (!open) return null;
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
  await cdp.detach();
  const find = (n: DomNode): DomNode | undefined => {
    const a = n.attributes ?? [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === 'data-ra-page-notice') return n;
    for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) {
      const hit = find(c);
      if (hit) return hit;
    }
    return undefined;
  };
  const text = (n: DomNode): string =>
    (n.nodeType === 3 ? (n.nodeValue ?? '') : '') +
    [...(n.shadowRoots ?? []), ...(n.children ?? [])].map(text).join('');
  const host = find(root);
  return host ? text(host) : null;
}

test('无预热：后台休眠时打开全新标签页立即选词点「问」——小窗出现、只发一次请求、不开侧边栏；记录时间线', async ({
  page,
  serviceWorker,
  context,
}) => {
  test.setTimeout(60_000);
  const timeline: Record<string, number> = {};
  await stopWorkers(page);
  await page.waitForTimeout(500);
  await page.goto('https://e2e.test/cold');
  await page.locator('#target').click({ clickCount: 3 });
  const t0 = Date.now();
  await clickAsk(page);
  timeline.clickDone = Date.now() - t0;
  await expect.poll(() => floatOpen(page), { timeout: 10_000 }).toBe(true);
  timeline.floatVisible = Date.now() - t0;
  const frame = await floatFrame(page);
  await expect(frame.getByLabel('输入问题')).toBeFocused({ timeout: 10_000 });
  timeline.inputFocused = Date.now() - t0;
  const sw = context.serviceWorkers()[0] ?? serviceWorker;
  await askInFloat(frame, r, '这段话讲了什么？');
  timeline.answered = Date.now() - t0;
  expect(r.bodies).toHaveLength(1);
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).toContain(PARAGRAPH);
  expect(await panelContexts(sw)).toHaveLength(0);
  expect(await page.locator('[data-ra-float-host]').count()).toBe(1);
  console.log('[V-02] 冷态（后台休眠 + 新标签页）时间线 ms', JSON.stringify(timeline));
});

test('暖态：已预热的页面再次点「问」，记录时间线', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/warm');
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '第一问');
  await page.mouse.click(5, 5);
  await expect.poll(() => floatOpen(page)).toBe(false);
  await page.locator('#target').click({ clickCount: 3 });
  const t0 = Date.now();
  await clickAsk(page);
  await expect.poll(() => floatOpen(page)).toBe(true);
  const visible = Date.now() - t0;
  await expect(frame.getByLabel('输入问题')).toBeFocused();
  console.log(
    '[V-02] 暖态时间线 ms',
    JSON.stringify({ floatVisible: visible, inputFocused: Date.now() - t0 }),
  );
});

test('小窗加载失败（网页移除宿主）：点「问」当场在网页提示「没能加载」（不说成不支持）；再点「问」由后台同步打开侧边栏，带上引用与说明', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  // 只在测试里：网页脚本一看到小窗宿主就把它移除（敌意网页或冲突脚本）
  await page.addInitScript(() => {
    new MutationObserver((records) => {
      for (const rec of records)
        for (const n of rec.addedNodes) if (n instanceof HTMLElement && n.dataset.raFloatHost) n.remove();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('https://e2e.test/hostile');
  const tab = await tabOf(serviceWorker, page);
  await page.locator('#target').click({ clickCount: 3 });
  await clickAsk(page);
  await expect.poll(() => pageNotice(page), { message: '网页上的一行提示' }).toContain('没能加载出来');
  const notice = (await pageNotice(page)) ?? '';
  expect(notice).not.toContain('放不了');
  expect(notice).toContain('Alt+Shift+D');
  expect(await panelContexts(serviceWorker)).toHaveLength(0);
  await expect.poll(() => readiness(serviceWorker, tab.id)).toBe('failedTransient');
  // 提示不挡网页：整条不接收指针事件
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-ra-page-notice]') as Element).pointerEvents,
    ),
  ).toBe('none');

  // 再选一次点「问」：后台在点击消息的同步段里打开侧边栏（Chrome 159 / Edge 157 实测可以）
  await page.locator('#target').click({ clickCount: 3 });
  await clickAsk(page);
  await expectPanels(serviceWorker, 1, '后台替网页工具栏的点击打开了侧边栏');
  const panel = await attachPanel(context);
  await expect.poll(() => panelText(panel, 'quote')).toContain(PARAGRAPH);
  await expect.poll(() => panelText(panel, 'panel-notice')).toContain('小窗这次没能加载出来');
  expect(await panelText(panel, 'panel-notice')).not.toContain('放不了');
  expect(await floatOpen(page)).toBe(false);
  // 偶发失败只代表这一次：下一次重新试小窗
  expect(await readiness(serviceWorker, tab.id)).toBe('unknown');
  await panel.click('textarea[aria-label="输入问题"]');
  await panel.type('这段话讲了什么？');
  await panel.press('Enter');
  await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
  expect(r.bodies).toHaveLength(1);
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).toContain(PARAGRAPH);
  expect(await panelText(panel, 'answer')).toBe(ANSWER);
  await panel.detach();
});

test('握手失败（令牌失效）：小窗提示失效；再点「问」换新令牌重建，能正常问答', async ({
  page,
  serviceWorker,
  context,
}) => {
  test.setTimeout(60_000);
  // 只在测试里：先扣住预热的小窗不让它加载，期间让令牌失效（删掉并重启后台），再放回去
  await page.addInitScript(() => {
    const g = window as unknown as { __hold: boolean; __held?: HTMLElement };
    g.__hold = true;
    new MutationObserver((records) => {
      for (const rec of records)
        for (const n of rec.addedNodes)
          if (g.__hold && n instanceof HTMLElement && n.dataset.raFloatHost) {
            g.__held = n;
            n.remove();
          }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('https://e2e.test/handshake');
  await page.locator('#target').click({ clickCount: 3 });
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { __held?: unknown }).__held)))
    .toBe(true);
  await serviceWorker.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith('token:')));
  });
  await stopWorkers(page);
  await page.evaluate(() => {
    const g = window as unknown as { __hold: boolean; __held?: HTMLElement };
    g.__hold = false;
    if (g.__held) document.documentElement.append(g.__held);
  });
  const stale = await floatFrame(page);
  // 预热的小窗是隐藏的：只看它握手失败后的状态
  await expect(stale.getByText('连接已失效')).toBeAttached({ timeout: 10_000 });
  // 「问」：后台给新令牌，阅读器重建小窗
  await clickAsk(page);
  await expect.poll(() => floatOpen(page)).toBe(true);
  await expect
    .poll(() => page.frames().filter((f) => f.url().includes('/float.html')).length, {
      message: '旧的被换掉',
    })
    .toBe(1);
  const fresh = await floatFrame(page);
  await expect(fresh.getByText('连接已失效')).toHaveCount(0);
  await askInFloat(fresh, r, '这段话讲了什么？');
  expect(r.bodies).toHaveLength(1);
  expect(await panelContexts(context.serviceWorkers()[0] ?? serviceWorker)).toHaveLength(0);
});

test('快捷键「打开小窗」（无选区）：注入阅读器并显示小窗，可以直接提问；不开侧边栏', async ({
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/shortcut');
  const tab = await tabOf(serviceWorker, page);
  await dispatchCommand(serviceWorker, 'open-float', tab);
  await expect.poll(() => floatOpen(page), { timeout: 10_000 }).toBe(true);
  const frame = await floatFrame(page);
  await askInFloat(frame, r, '这一页讲什么？');
  expect(r.bodies).toHaveLength(1);
  expect(await panelContexts(serviceWorker)).toHaveLength(0);
});

test('右键「问」：选中文字取自浏览器（不依赖哨兵），按需注入阅读器走小窗，请求带着这段文字', async ({
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/menu');
  const tab = await tabOf(serviceWorker, page);
  await dispatchMenu(
    serviceWorker,
    { menuItemId: 'ask', selectionText: PARAGRAPH, frameId: 0, editable: false },
    tab,
  );
  await expect.poll(() => floatOpen(page), { timeout: 10_000 }).toBe(true);
  const frame = await floatFrame(page);
  await expect(frame.getByText(PARAGRAPH)).toBeVisible();
  await askInFloat(frame, r, '这句话什么意思？');
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).toContain(PARAGRAPH);
});

test('右键「总结本页」：后台用固定问题发起整页请求（任务归后台）；侧边栏打开后接上这个回答；不显示小窗', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  const logs: string[] = [];
  serviceWorker.on('console', (m) => logs.push(m.text()));
  await page.goto('https://e2e.test/summary');
  const tab = await tabOf(serviceWorker, page);
  await dispatchMenu(serviceWorker, { menuItemId: 'summarizePage' }, tab);
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(1);
  const sent = JSON.stringify(parseBody(r.bodies[0]).messages);
  expect(sent).toContain('总结本页');
  expect(sent).toContain('第三段：总结时也会读到这一段。');
  // 没有手势：这次 open 被拒（真实右键点击时会打开，见手动检查清单）
  expect(logs.some((l) => l.includes('sidepanel/openFailed') && l.includes('summary'))).toBe(true);
  expect(await floatOpen(page)).toBe(false);
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
  expect(await panelText(panel, 'answer')).toBe(ANSWER);
  expect(r.bodies).toHaveLength(1);
  await panel.detach();
});
