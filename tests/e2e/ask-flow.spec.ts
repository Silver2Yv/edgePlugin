// 最细端到端通路（ARCHITECTURE 6.1）：划词 → 工具栏「问」→ 小窗 → 后台向模拟中转站发流式请求 → 增量回到小窗。
// 第二个用例在答完后用调试协议停掉后台（模拟真机空闲 30 秒被回收），验证小窗用 conv/resumeFloat 重连后还能接着问。
import type { IncomingMessage } from 'node:http';
import type { CDPSession, ConsoleMessage, Frame, Page, Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/domain/settings';
import type { Connection } from '../../src/core/llm/adapter';
import { type LogEntry, type MockRelay, startMockRelay } from '../mock-relay/server';
import { expect, test } from './fixtures';

// evaluate 的回调在扩展页面或 Service Worker 里执行，那里的全局是 chrome
declare const chrome: typeof browser;

const SITE = 'https://e2e.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>端到端测试文章</title></head>
<body><article>
<h1>端到端测试文章</h1>
<p>第一段：这是一篇用来做端到端测试的文章，内容无关紧要。</p>
<p id="target">${PARAGRAPH}</p>
<p>第三段：选中上面那段文字，点工具栏里的「问」，在小窗里提问。</p>
</article></body></html>`;
/** 模拟中转站 ok 模式的正文 */
const ANSWER = '这是模拟中转站的回答。它分多段流式返回。';
const MODEL = 'mock-flash';

let relay: MockRelay;
/** 模拟中转站收到的 chat 请求正文（它的 /__log 只记模型名，不记消息） */
const bodies: string[] = [];

test.beforeAll(async () => {
  relay = await startMockRelay();
  // 模拟中转站的处理函数先挂上了 data 监听，这里再挂一个只做记录，两边都能收到完整正文
  relay.server.on('request', (req: IncomingMessage) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => bodies.push(Buffer.concat(parts).toString('utf8')));
  });
});
test.afterAll(() => relay.close());
test.beforeEach(async () => {
  await fetch(`${relay.url}/__reset`, { method: 'POST' });
  bodies.length = 0;
});

const chatLog = async () =>
  ((await (await fetch(`${relay.url}/__log`)).json()) as LogEntry[]).filter((e) =>
    e.path.endsWith('/chat/completions'),
  );

/** 后台日志里的 sender 摘要（V-05 实测用）；不含令牌 */
function collectSenderLogs(worker: Worker, out: string[]): void {
  worker.on('console', (m: ConsoleMessage) => {
    if (m.text().includes('float/sender')) out.push(m.text());
  });
}

async function setup(page: Page, serviceWorker: Worker): Promise<void> {
  const conn: Connection = {
    id: 'e2e-conn-0001',
    name: '模拟中转站',
    preset: 'custom',
    baseUrl: `${relay.url}/v1`,
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

/**
 * 像用户一样直接打字：不点输入框、不用 fill（fill 会自己聚焦输入框，掩盖「点问后焦点没进小窗」的问题）。
 * 先确认焦点已在小窗输入框里，按键才会落到小窗而不是网页
 */
async function askInFloat(frame: Frame, question: string): Promise<void> {
  const input = frame.getByLabel('输入问题');
  await expect(input).toBeFocused();
  await frame.page().keyboard.type(question);
  await expect(input).toHaveValue(question);
  await frame.page().keyboard.press('Enter');
}

/** 从小窗（扩展页面）读 storage.session 里的任务热副本 */
const sessionJobs = (frame: Frame) =>
  frame.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('job:'))
      .map(([, v]) => v as { state: string; workerEpoch: string });
  });

const workerEpoch = (frame: Frame) =>
  frame.evaluate(async () => (await chrome.storage.session.get('workerEpoch')).workerEpoch as string);

/** 选中目标段落 → 点「问」→ 小窗里提问，等答完 */
async function selectAndAsk(page: Page, question: string): Promise<Frame> {
  await page.locator('#target').click({ clickCount: 3 });
  const cdp = await page.context().newCDPSession(page);
  await clickToolbarButton(cdp, page, '问');
  await cdp.detach();
  const frame = await floatFrame(page);
  await askInFloat(frame, question);
  await expect(frame.getByTestId('answer').last()).toContainText(ANSWER, { timeout: 15_000 });
  await expect(frame.getByTestId('job-state').last()).toHaveText('completed');
  return frame;
}

test('划词 → 问 → 小窗流式回答：后台只发一次请求，带着选中的文字', async ({ page, serviceWorker }) => {
  const senderLogs: string[] = [];
  collectSenderLogs(serviceWorker, senderLogs);
  await setup(page, serviceWorker);

  const frame = await selectAndAsk(page, '这段话讲了什么？');

  const log = await chatLog();
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ model: MODEL, stream: true, hasAuth: true });
  expect(bodies).toHaveLength(1);
  const sent = JSON.parse(bodies[0] ?? '{}') as { messages: unknown };
  expect(JSON.stringify(sent.messages)).toContain(PARAGRAPH);
  expect(JSON.stringify(sent.messages)).toContain('这段话讲了什么？');

  // V-05 实测记录：小窗文档自己的地址与来源、后台看到的 sender（都去掉了令牌片段）
  const own = await frame.evaluate(() => ({ url: location.href.split('#')[0], origin: location.origin }));
  console.log('[V-05] 小窗 location', JSON.stringify(own));
  for (const l of senderLogs) console.log('[V-05]', l);
});

test('答完后停掉后台：小窗用 resumeFloat 重连，接着问仍能答完', async ({ page, serviceWorker, context }) => {
  test.setTimeout(60_000);
  const senderLogs: string[] = [];
  collectSenderLogs(serviceWorker, senderLogs);
  context.on('serviceworker', (w) => collectSenderLogs(w, senderLogs));
  await setup(page, serviceWorker);

  const frame = await selectAndAsk(page, '这段话讲了什么？');
  const epochBefore = await workerEpoch(frame);

  // Playwright 连着后台时后台不会因空闲被回收，用调试协议直接停掉（与网络诊断包自测相同）
  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
  await page.waitForTimeout(1_000);

  await askInFloat(frame, '再说简单一点。');
  await expect
    .poll(async () => (await chatLog()).length, { message: '第二次请求到达', timeout: 15_000 })
    .toBe(2);
  await expect
    .poll(async () => (await sessionJobs(frame)).filter((j) => j.state === 'completed').length, {
      message: '两次任务都完成',
      timeout: 15_000,
    })
    .toBe(2);
  await expect(frame.getByTestId('answer').last()).toContainText(ANSWER);
  await expect(frame.getByTestId('job-state').last()).toHaveText('completed');

  // 后台确实换了进程，且第二次请求同样带着选中的文字（选区从 storage.session 取）
  expect(await workerEpoch(frame)).not.toBe(epochBefore);
  expect(JSON.stringify(JSON.parse(bodies[1] ?? '{}'))).toContain(PARAGRAPH);
  for (const l of senderLogs) console.log('[V-05]', l);
  expect(senderLogs.some((l) => l.includes('resumeFloat'))).toBe(true);
});
