// 设置页端到端（ARCHITECTURE 5.8「测试连接」「错误分类与下一步」、5.11「设置」）：
// 地址故意漏写 /v1（html200 场景的真实表现）→ 测试连接提示改地址 → 点「改成 …/v1 并重测」→ 连接正常，
// 落盘的 settings 里多了这条连接且 defaultModel 已设好，页面任何时候都不出现 Key 原文。
// 再复用一遍 ask-flow.spec.ts 的划词提问流程，但设置是这里在设置页操作后落盘的那份，不是测试代码直接写的。
import type { CDPSession, Frame, Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/domain/settings';
import { SETTINGS_KEY } from '../../src/platform/settings-store';
import { type MockRelay, startMockRelay } from '../mock-relay/server';
import { EXTENSION_ID, expect, test } from './fixtures';

// evaluate 的回调在扩展页面里执行，那里的全局是 chrome（同 ask-flow.spec.ts）
declare const chrome: typeof browser;

const SITE = 'https://e2e-options.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>设置页端到端测试文章</title></head>
<body><article>
<p>第一段：这是一篇用来做端到端测试的文章，内容无关紧要。</p>
<p id="target">${PARAGRAPH}</p>
</article></body></html>`;
/** 模拟中转站 ok 模式的正文（server.ts 里的 ANSWER 拼接结果） */
const ANSWER = '这是模拟中转站的回答。它分多段流式返回。';
const CONN_NAME = '设置页端到端测试连接';
const MODEL = 'mock-flash';
const FAKE_KEY = 'e2e-options-fake-key-do-not-use';

let relay: MockRelay;

test.beforeAll(async () => {
  relay = await startMockRelay();
});
test.afterAll(() => relay.close());
test.beforeEach(async () => {
  await fetch(`${relay.url}/__reset`, { method: 'POST' });
});

/** 整份 outerHTML（文本 + 属性，不含输入框的 value 属性——Preact 受控输入只设 DOM 属性，不回写 HTML 属性）里不出现这串 */
async function assertNoKeyLeak(page: Page, key: string): Promise<void> {
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  expect(html).not.toContain(key);
}

// ───────────── 以下几个 helper 照抄 ask-flow.spec.ts：工具栏在封闭 shadow root 里， ─────────────
// ───────────── 定位器进不去，要用调试协议穿透取节点与盒模型，再用真实鼠标点击。 ─────────────

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

// ───────────── 正式用例 ─────────────

test('设置页：漏写 /v1 → 改地址重测成功 → 落盘且不泄露 Key；随后沿用这份设置划词提问', async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);

  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);

  await page.getByRole('button', { name: '添加连接' }).click();
  await page.getByLabel('名称').fill(CONN_NAME);
  // 故意漏写 /v1：chatCompletions 适配器会拼成 <relay>/chat/completions，
  // 模拟中转站对不是 /v1/chat/completions 的路径一律回网页（server.ts 文件头注释的 html200 场景）
  await page.getByLabel('接口地址').fill(relay.url);
  await page.getByLabel('Key').fill(FAKE_KEY);
  await page.getByLabel('模型').fill(MODEL);
  await assertNoKeyLeak(page, FAKE_KEY);

  await page.getByRole('button', { name: '测试连接' }).click();

  const retestButton = page.getByRole('button', { name: /^改成 .*\/v1 并重测$/ });
  await expect(retestButton).toBeVisible({ timeout: 15_000 });
  await retestButton.click();

  await expect(page.getByText(/连接正常/)).toBeVisible({ timeout: 15_000 });
  await assertNoKeyLeak(page, FAKE_KEY);

  const stored = (await page.evaluate(
    (key) => chrome.storage.local.get(key).then((r: Record<string, unknown>) => r[key]),
    SETTINGS_KEY,
  )) as Settings;
  const saved = stored.connections.find((c) => c.name === CONN_NAME);
  expect(saved).toBeTruthy();
  expect(saved?.baseUrl.endsWith('/v1')).toBe(true);
  expect(stored.defaultModel).toMatchObject({ connectionId: saved?.id, model: MODEL });

  // 续接一遍 ask-flow 的划词提问，但这次的设置是上面在设置页操作后落盘的那份
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
  await page.goto(`${SITE}article`);
  await page.locator('#target').click({ clickCount: 3 });
  const cdp = await context.newCDPSession(page);
  await clickToolbarButton(cdp, page, '问');
  await cdp.detach();
  const frame = await floatFrame(page);
  await askInFloat(frame, '这段话讲了什么？');
  await expect(frame.getByTestId('answer').last()).toContainText(ANSWER, { timeout: 15_000 });
  await expect(frame.getByTestId('job-state').last()).toHaveText('completed');
});

// ───────────── 网络层诊断（H9、5.8）：webRequest 对扩展自己发出的请求是否生效 ─────────────

test('连不上的地址：ModelError.netError 带着浏览器错误码（webRequest 对扩展自己的请求确实生效）', async ({
  page,
}) => {
  // fetch() 本身只给 TypeError: Failed to fetch，分不清是 DNS 失败、连接被拒还是证书问题；
  // 浏览器错误码只能从 webRequest.onErrorOccurred 拿（prototypes/net-probe T6c 已有证据）。
  // 这里直接连一个保证连不上的本机地址（没有监听者，不依赖 DNS、不依赖外网），实测这条链路在
  // 真实扩展里确实接通了
  const connId = 'e2e-net-unreachable-0001';
  const settings: Settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    connections: [
      {
        id: connId,
        name: '连不上的地址',
        preset: 'custom',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'whatever',
        headers: {},
        interfaceType: 'chatCompletions',
        stream: true,
        extraParams: {},
        configVersion: 1,
      },
    ],
  };
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  await page.evaluate(({ key, value }) => chrome.storage.local.set({ [key]: value }), {
    key: SETTINGS_KEY,
    value: settings,
  });
  const result = await page.evaluate(
    (connectionId) =>
      chrome.runtime.sendMessage({ type: 'connection/test', connectionId, model: 'whatever-model' }),
    connId,
  );
  expect(result).toMatchObject({ ok: false, error: { kind: 'network' } });
  const netError = (result as { error?: { netError?: string } }).error?.netError;
  console.log('[H9] 连不上的地址 netError', netError);
  expect(netError).toMatch(/^net::/);
});
