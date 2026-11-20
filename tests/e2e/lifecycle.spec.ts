// V-01 真实网络链路：等响应头的连接超时（ARCHITECTURE 5.5「保活」段）。
// head35 模式故意 35 秒才给响应头；JOB_LIMITS.connectTimeoutMs（28 秒，生产默认值，未覆盖）应当
// 抢在真正等到响应头之前中止请求，给出可辨认的 timeout 错误——而不是让用户一直看着「生成中」，
// 也不是等浏览器自己把后台回收掉。这里用真实未缩放的时间（不传 scale），真实跑一次 28 秒左右的等待。
// 故意单独成一个文件：这条用例天生要等接近 30 秒，不跟其它快速用例混在一起，方便单独跳过/单独跑。
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
<html lang="zh-CN"><head><meta charset="utf-8"><title>生命周期测试文章</title></head>
<body><article>
<h1>生命周期测试文章</h1>
<p>第一段：这是一篇用来做端到端测试的文章，内容无关紧要。</p>
<p id="target">${PARAGRAPH}</p>
<p>第三段：选中上面那段文字，点工具栏里的「问」，在小窗里提问。</p>
</article></body></html>`;
const MODEL = 'mock-flash';

let relay: MockRelay;

test.beforeAll(async () => {
  relay = await startMockRelay(); // 不传 scale：head35 真的等 35 秒才给响应头
});
test.afterAll(() => relay.close());

async function setup(page: Page, serviceWorker: Worker): Promise<void> {
  const conn: Connection = {
    id: 'e2e-conn-0001',
    name: '模拟中转站',
    preset: 'custom',
    baseUrl: `${relay.url}/m/head35/v1`,
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

test('head35（响应头 35 秒才到）：28 秒连接超时抢先亮出 timeout，不是无声等待（真实未缩放时间）', async ({
  page,
  serviceWorker,
}) => {
  test.setTimeout(40_000);
  await setup(page, serviceWorker);
  const frame = await selectAndAsk(page, '这段话讲了什么？');

  // 生产默认的 28 秒连接超时：真实未缩放等待，应当在服务端 35 秒延迟之前就亮出 timeout
  await expect(frame.getByTestId('job-state').last()).toHaveText('failed', { timeout: 32_000 });
  await expect(frame.getByText('等待超时')).toBeVisible();
});
