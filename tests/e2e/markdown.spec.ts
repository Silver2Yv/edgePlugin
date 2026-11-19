// V-10 回答渲染接入小窗的端到端验证（ARCHITECTURE 5.10）：划词 → 问 → 模拟中转站
// 以 markdown 模式流式返回一份含标题/列表/代码/表格/公式/链接/原始 HTML 的正文 →
// 断言小窗把它安全渲染成真实 DOM（而不是原样显示 Markdown 源码或执行危险内容）。
// 第二个用例在流式中途用真实鼠标选中已完成的第一个块，验证用户选区/阅读位置不被打断。
import type { CDPSession, Frame, Page, Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/domain/settings';
import type { Connection } from '../../src/core/llm/adapter';
import { type MockRelay, startMockRelay } from '../mock-relay/server';
import { expect, test } from './fixtures';

// evaluate 的回调在扩展页面或 Service Worker 里执行，那里的全局是 chrome
declare const chrome: typeof browser;

const SITE = 'https://e2e.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>markdown 渲染测试文章</title></head>
<body><article>
<h1>markdown 渲染测试文章</h1>
<p>第一段：这是一篇用来做端到端测试的文章，内容无关紧要。</p>
<p id="target">${PARAGRAPH}</p>
<p>第三段：选中上面那段文字，点工具栏里的「问」，在小窗里提问。</p>
</article></body></html>`;
const MODEL = 'mock-flash';

let relay: MockRelay;

test.beforeAll(async () => {
  relay = await startMockRelay();
});
test.afterAll(() => relay.close());
test.beforeEach(async () => {
  await fetch(`${relay.url}/__reset`, { method: 'POST' });
});

async function setup(page: Page, serviceWorker: Worker): Promise<void> {
  const conn: Connection = {
    id: 'e2e-conn-0001',
    name: '模拟中转站',
    preset: 'custom',
    // markdown 模式：分约 20 段流式返回含标题/列表/代码/表格/公式/链接/原始 HTML 的正文
    baseUrl: `${relay.url}/m/markdown/v1`,
    apiKey: 'e2e-fake-key',
    headers: {},
    interfaceType: 'chatCompletions',
    stream: true,
    extraParams: {},
    configVersion: 1,
  };
  const settings: Settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    connections: [conn],
    defaultModel: { connectionId: conn.id, model: MODEL },
  };
  await serviceWorker.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
  await page.goto(`${SITE}article`);
}

interface DomNode {
  nodeName: string;
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

/** 工具栏在封闭 shadow root 里，定位器进不去：用调试协议穿透取节点与盒模型，再用真实鼠标点 */
async function clickToolbarButton(cdp: CDPSession, page: Page, label: string): Promise<void> {
  let center: { x: number; y: number } | undefined;
  await expect
    .poll(
      async () => {
        const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as {
          root: DomNode;
        };
        const node = findByLabel(root, label);
        if (!node) return false;
        try {
          const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
          const q = model.content;
          center = { x: ((q[0] ?? 0) + (q[4] ?? 0)) / 2, y: ((q[1] ?? 0) + (q[5] ?? 0)) / 2 };
          return model.width > 0 && model.height > 0;
        } catch {
          return false; // 还没渲染出来
        }
      },
      { message: `工具栏按钮「${label}」出现`, timeout: 5_000 },
    )
    .toBe(true);
  if (!center) throw new Error('取不到按钮位置');
  await page.mouse.click(center.x, center.y);
}

const isFloat = (f: Frame) => {
  try {
    return new URL(f.url()).pathname === '/float.html';
  } catch {
    return false;
  }
};

async function floatFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some(isFloat), { message: '小窗 iframe 出现' }).toBe(true);
  return page.frames().find(isFloat) as Frame;
}

/** 像用户一样直接打字：先确认焦点已在小窗输入框里，按键才会落到小窗而不是网页 */
async function askInFloat(frame: Frame, question: string): Promise<void> {
  const input = frame.getByLabel('输入问题');
  await expect(input).toBeFocused();
  await frame.page().keyboard.type(question);
  await expect(input).toHaveValue(question);
  await frame.page().keyboard.press('Enter');
}

/** 选中目标段落 → 点「问」→ 小窗里提问，返回小窗 frame（不等待完成，调用方自己决定） */
async function selectAndAsk(page: Page, question: string): Promise<Frame> {
  await page.locator('#target').click({ clickCount: 3 });
  const cdp = await page.context().newCDPSession(page);
  await clickToolbarButton(cdp, page, '问');
  await cdp.detach();
  const frame = await floatFrame(page);
  await askInFloat(frame, question);
  return frame;
}

const answer = (frame: Frame) => frame.locator('[data-testid="answer"]').last();

test('markdown 回答被安全渲染成真实 DOM：标题/列表/代码/表格/公式都渲染，危险内容被挡下', async ({
  page,
  serviceWorker,
}) => {
  await setup(page, serviceWorker);
  const frame = await selectAndAsk(page, '渲染一下这份文档');
  await expect(frame.getByTestId('job-state').last()).toHaveText('completed', { timeout: 15_000 });

  const root = answer(frame);
  // 标题 h1–h3
  await expect(root.locator('h1')).toHaveCount(1);
  await expect(root.locator('h2').first()).toBeVisible();
  await expect(root.locator('h3').first()).toBeVisible();
  // 有序 / 无序列表
  await expect(root.locator('ul').first()).toBeVisible();
  await expect(root.locator('ol').first()).toBeVisible();
  // 代码块：高亮后的 class
  const code = root.locator('pre.ra-code');
  await expect(code.first()).toBeVisible();
  await expect(code.first()).toHaveClass(/hljs/);
  await expect(code.locator('code')).toContainText('function greet');
  // 表格
  await expect(root.locator('table')).toHaveCount(1);
  await expect(root.locator('table')).toContainText('张三');
  // 公式：行内与块级都渲染成 .katex
  await expect(root.locator('.katex').first()).toBeVisible();
  expect(await root.locator('.katex').count()).toBeGreaterThanOrEqual(2);

  // 安全链接：http，带 target=_blank 与 noopener
  const safeLink = root.locator('a', { hasText: '示例网站' });
  await expect(safeLink).toHaveAttribute('target', '_blank');
  await expect(safeLink).toHaveAttribute('rel', /noopener/);
  await expect(safeLink).toHaveAttribute('href', 'http://example.com');

  // 危险链接：javascript: 协议不在白名单内，没有变成 <a>，但文字仍可见
  await expect(root.locator('a', { hasText: '点我' })).toHaveCount(0);
  await expect(root).toContainText('点我');

  // 外链图片：不产生 <img>（不抓取、不显示）
  await expect(root.locator('img')).toHaveCount(0);

  // 原始 HTML：<script>/<img onerror> 被当纯文本转义，不是真实元素
  await expect(root.locator('script')).toHaveCount(0);
  await expect(root).toContainText('<script>');
});

/** 流式阶段里，已完成块容器的直接子节点数（用于等待“已有多个块，第一块已不是 open 态”） */
const blockCount = (frame: Frame) => answer(frame).locator('> *').count();

test('流式中途选中已完成的第一个块：继续接收增量时选区、节点、滚动位置都不受影响', async ({
  page,
  serviceWorker,
}) => {
  await setup(page, serviceWorker);
  const frame = await selectAndAsk(page, '渲染一下这份文档');

  // 等到至少出现两个块（第一块——标题——已经不是最后一块，不会再被重渲染）
  await expect
    .poll(() => blockCount(frame), { message: '至少两个块已挂载', timeout: 10_000 })
    .toBeGreaterThan(1);

  const heading = answer(frame).locator('h1').first();
  await expect(heading).toBeVisible();
  // 用一个只有渲染器自己会写的属性值标记这个节点，稍后检查它是否还在（证明没被替换）
  await heading.evaluate((el) => el.setAttribute('data-e2e-keep', '1'));

  // 真实鼠标拖选标题文字的一部分
  const box = await heading.boundingBox();
  if (!box) throw new Error('取不到标题位置');
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();

  const selectedBefore = await frame.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selectedBefore.length).toBeGreaterThan(0);
  const scrollYBefore = await frame.evaluate(() => window.scrollY);
  const hostScrollYBefore = await page.evaluate(() => window.scrollY);

  // 继续等待流式完成（后续增量不断到达）
  await expect(frame.getByTestId('job-state').last()).toHaveText('completed', { timeout: 15_000 });

  const selectedAfter = await frame.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selectedAfter).toBe(selectedBefore);
  // 节点没被替换：标记属性还在同一个 h1 上
  await expect(answer(frame).locator('h1[data-e2e-keep="1"]')).toHaveCount(1);
  expect(await frame.evaluate(() => window.scrollY)).toBe(scrollYBefore);
  expect(await page.evaluate(() => window.scrollY)).toBe(hostScrollYBefore);
});
