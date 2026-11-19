// 划词工具栏在「不理想」页面上的表现（ARCHITECTURE 5.1、5.2）：
// 1. 扩展安装或更新时，已经打开的网页不刷新也能用（L5：后台向已开网页注入哨兵，重复注入时旧哨兵退出）
// 2. 网页拦截了 mouseup 冒泡也能弹出（哨兵在 window 捕获阶段监听）
import type { CDPSession, Frame, Page, Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { expect, test } from './fixtures';

declare const chrome: typeof browser;

const SITE = 'https://e2e.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const article = (script = '') => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>工具栏测试</title></head>
<body><article><h1>工具栏测试</h1><p>第一段。</p><p id="target">${PARAGRAPH}</p><p>第三段。</p></article>
<script>${script}</script></body></html>`;

interface DomNode {
  backendNodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

function findByLabel(node: DomNode, label: string): DomNode | undefined {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === 'aria-label' && attrs[i + 1] === label) return node;
  }
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const hit = findByLabel(child, label);
    if (hit) return hit;
  }
  return node.contentDocument ? findByLabel(node.contentDocument, label) : undefined;
}

function countByLabel(node: DomNode, label: string): number {
  const attrs = node.attributes ?? [];
  let n = 0;
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'aria-label' && attrs[i + 1] === label) n++;
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])])
    n += countByLabel(child, label);
  return n;
}

/** 工具栏在封闭 shadow root 里：用调试协议穿透，返回可见的「问」按钮中心；没有或不可见返回 undefined */
async function askButtonCenter(cdp: CDPSession): Promise<{ x: number; y: number } | undefined> {
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
  const node = findByLabel(root, '问');
  if (!node) return undefined;
  try {
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    if (model.width === 0 || model.height === 0) return undefined;
    const q = model.content;
    return { x: ((q[0] ?? 0) + (q[4] ?? 0)) / 2, y: ((q[1] ?? 0) + (q[5] ?? 0)) / 2 };
  } catch {
    return undefined; // 已收起（popover 隐藏时没有盒模型）
  }
}

/** 像用户一样拖选目标段落 */
async function dragSelect(page: Page): Promise<void> {
  const box = await page.locator('#target').boundingBox();
  if (!box) throw new Error('找不到目标段落');
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
}

async function expectToolbar(cdp: CDPSession): Promise<{ x: number; y: number }> {
  let center: { x: number; y: number } | undefined;
  await expect
    .poll(
      async () => {
        center = await askButtonCenter(cdp);
        return center !== undefined;
      },
      { message: '工具栏出现', timeout: 5_000 },
    )
    .toBe(true);
  return center as { x: number; y: number };
}

const isFloat = (f: Frame) => f.url().includes('/float.html');

/** 哨兵是安装后异步注册的；注册完成前打开的网页没有哨兵（L5 的情形），这里先等注册完再开页 */
async function waitSentinelRegistered(sw: Worker): Promise<void> {
  await expect
    .poll(() => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length))
    .toBe(1);
}

test('哨兵注册之前就打开的网页：补注入后不刷新也能用，重复注入只留一个工具栏', async ({
  context,
  page,
  serviceWorker,
}) => {
  await page.route(`${SITE}**`, (r) =>
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: article() }),
  );
  await waitSentinelRegistered(serviceWorker);
  // 模拟「安装前就打开的网页」：先撤掉注册再开页，这个网页里没有哨兵
  await serviceWorker.evaluate(() => chrome.scripting.unregisterContentScripts({ ids: ['sentinel'] }));
  await page.goto(`${SITE}a`);
  const cdp = await context.newCDPSession(page);
  await test.step('没有哨兵：拖选不出工具栏', async () => {
    await dragSelect(page);
    await page.waitForTimeout(500);
    expect(await askButtonCenter(cdp)).toBeUndefined();
  });

  // 安装 / 更新时后台对已开网页做的注入（background/scripts.ts injectSentinelIntoOpenTabs）；
  // 扩展无法在 Playwright 里重新加载，这里直接执行同样的注入，并且注入两次（模拟旧哨兵还在）
  const inject = () =>
    serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://e2e.test/*' });
      await chrome.scripting.executeScript({
        target: { tabId: tab?.id ?? -1, allFrames: true },
        files: ['/content-scripts/sentinel.js'],
      });
    });
  await inject();
  await inject();

  await page.mouse.click(5, 5);
  await dragSelect(page);
  const center = await expectToolbar(cdp);
  // 页面里只有一个「问」按钮（旧哨兵的工具栏已移除；小窗宿主也是 popover，不能按 popover 数）
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
  expect(countByLabel(root, '问')).toBe(1);
  await page.mouse.click(center.x, center.y);
  await expect.poll(() => page.frames().some(isFloat), { message: '小窗出现' }).toBe(true);
});

test('网页拦截了 mouseup 冒泡，工具栏照样出现', async ({ context, page, serviceWorker }) => {
  const blocker = `
    document.body.addEventListener('mouseup', (e) => e.stopPropagation());
    window.addEventListener('mouseup', (e) => e.stopPropagation(), true);`;
  await page.route(`${SITE}**`, (r) =>
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: article(blocker) }),
  );
  await waitSentinelRegistered(serviceWorker);
  await page.goto(`${SITE}b`);
  const cdp = await context.newCDPSession(page);
  await dragSelect(page);
  await expectToolbar(cdp);
});
