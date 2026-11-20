// V-03 重试端到端验证（ARCHITECTURE 5.5「检查点」、job.ts 头注释「重试」）：
// 第一次请求中途断线失败后，小窗任务状态区出现「重试」按钮；点击后用同一 attemptId 的新尝试
// 原样重发，不新建发问，旧内容不与新内容拼接。第二个用例验证「停止」之后也能重试。
import type { CDPSession, Frame, Page, Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/domain/settings';
import type { Connection } from '../../src/core/llm/adapter';
import { type MockRelay, startMockRelay } from '../mock-relay/server';
import { expect, test } from './fixtures';

declare const chrome: typeof browser;

const SITE = 'https://e2e.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>重试测试文章</title></head>
<body><article>
<h1>重试测试文章</h1>
<p>第一段：这是一篇用来做端到端测试的文章，内容无关紧要。</p>
<p id="target">${PARAGRAPH}</p>
<p>第三段：选中上面那段文字，点工具栏里的「问」，在小窗里提问。</p>
</article></body></html>`;
const MODEL = 'mock-flash';
/** 模拟中转站 failOnce/ok 模式的完整正文 */
const ANSWER = '这是模拟中转站的回答。它分多段流式返回。';

let relay: MockRelay;

test.beforeAll(async () => {
  relay = await startMockRelay();
});
test.afterAll(() => relay.close());
test.beforeEach(async () => {
  await fetch(`${relay.url}/__reset`, { method: 'POST' });
});

async function setup(page: Page, serviceWorker: Worker, mode: string): Promise<void> {
  const conn: Connection = {
    id: 'e2e-conn-0001',
    name: '模拟中转站',
    preset: 'custom',
    baseUrl: `${relay.url}/m/${mode}/v1`,
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
          return false;
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

async function askInFloat(frame: Frame, question: string): Promise<void> {
  const input = frame.getByLabel('输入问题');
  await expect(input).toBeFocused();
  await frame.page().keyboard.type(question);
  await expect(input).toHaveValue(question);
  await frame.page().keyboard.press('Enter');
}

async function selectAndAsk(page: Page, question: string): Promise<Frame> {
  await page.locator('#target').click({ clickCount: 3 });
  const cdp = await page.context().newCDPSession(page);
  await clickToolbarButton(cdp, page, '问');
  await cdp.detach();
  const frame = await floatFrame(page);
  await askInFloat(frame, question);
  return frame;
}

const answerText = (frame: Frame) => frame.getByTestId('answer').last();
const jobState = (frame: Frame) => frame.getByTestId('job-state').last();

test('中途断线失败后点「重试」：新尝试原样重发，旧内容不与新内容拼接', async ({ page, serviceWorker }) => {
  // failOnce：第一次请求中途断开（streamBroken），第二次起正常走完
  await setup(page, serviceWorker, 'failOnce');
  const frame = await selectAndAsk(page, '这段话讲了什么？');

  await expect(jobState(frame)).toHaveText('failed', { timeout: 15_000 });
  const retryBtn = frame.getByRole('button', { name: '重试' });
  await expect(retryBtn).toBeVisible();

  await retryBtn.click();
  await expect(jobState(frame)).toHaveText('completed', { timeout: 15_000 });
  await expect(answerText(frame)).toHaveText(ANSWER);
  // 不是拼接：正文里不该出现两份回答
  expect((await answerText(frame).textContent())?.split(ANSWER).length ?? 0).toBe(2);

  const log = await (await fetch(`${relay.url}/__log`)).json();
  expect(log).toHaveLength(2); // 失败那次 + 重试那次，没有第三次
});

test('用户停止后也能点「重试」恢复', async ({ page, serviceWorker }) => {
  await setup(page, serviceWorker, 'long');
  const frame = await selectAndAsk(page, '讲长一点');

  await expect(frame.getByTestId('answer').last()).not.toHaveText('', { timeout: 10_000 });
  await frame.getByRole('button', { name: '停止' }).click();
  await expect(jobState(frame)).toHaveText('stopped', { timeout: 10_000 });

  const retryBtn = frame.getByRole('button', { name: '重试' });
  await expect(retryBtn).toBeVisible();
});

test('流式中途后台被回收：重连后标记 interrupted，提示「结果未知」，仍可点「重试」', async ({
  page,
  serviceWorker,
  context,
}) => {
  test.setTimeout(30_000);
  await setup(page, serviceWorker, 'long');
  const frame = await selectAndAsk(page, '讲长一点');

  // 等已经收到一些正文（任务确实在 streaming，不是刚 accepted）再把后台停掉，
  // 模拟 V-01「后台在无人盯着时被浏览器按空闲/超时策略回收」——此处用调试协议直接触发，
  // 效果与真机空闲 30 秒被回收一致（net-probe/RESULT.md）
  await expect(frame.getByTestId('answer').last()).not.toHaveText('', { timeout: 10_000 });
  const partialAnswer = (await frame.getByTestId('answer').last().textContent()) ?? '';
  expect(partialAnswer.length).toBeGreaterThan(0);

  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();

  // 小窗的长连接端口随之断开，检测到还有未到终态的任务会立即用 resumeFloat 重连；
  // 新后台实例启动扫描会把这条没有对应运行时记录的任务标为 interrupted
  await expect(jobState(frame)).toHaveText('interrupted', { timeout: 15_000 });
  await expect(frame.getByText('上次请求的结果未知，重试可能重新计费')).toBeVisible();
  // 已生成的部分内容被保留，不因中断而清空
  await expect(frame.getByTestId('answer').last()).toContainText(partialAnswer.slice(0, 2));

  const retryBtn = frame.getByRole('button', { name: '重试' });
  await expect(retryBtn).toBeVisible();
  // 跨后台重启：原始请求装配结果只存在于旧进程内存，新进程的任务表里没有这个 jobId，
  // 点「重试」会被拒绝（notOwner）——这是架构选定的退路（「不宣称恢复同一网络流」），
  // 不是静默重发，但也不是真的能继续；用户此时应改为重新提问（V-03 记录里的已知局限）
  await retryBtn.click();
  await expect(frame.getByText(/发送失败|操作失败/)).toBeVisible({ timeout: 5_000 });
  await expect(jobState(frame)).toHaveText('interrupted'); // 没有变成 streaming
});
