// V-05 IPC 授权与 iframe 边界（ARCHITECTURE 5.3、5.12，规则 4、6、7）：在真实浏览器里验证
// 单元测试（tests/unit/background/float-flow.test.ts）用假 sender 验证过的授权逻辑，
// 以及单元测试测不到的、依赖真实浏览器行为的部分——use_dynamic_url、封闭 shadow root、
// performance 资源条目、握手前的端口消息、跨标签页令牌隔离、导航后令牌作废。
import type { CDPSession, Page, Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { EXTENSION_ID, expect, test } from './fixtures';

declare const chrome: typeof browser;

const SITE = 'https://e2e.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const article = (path = 'a') => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"></head>
<body><article><h1>${path}</h1><p id="target">${PARAGRAPH}</p></article></body></html>`;

async function routeSite(page: Page): Promise<void> {
  await page.route(`${SITE}**`, (r) => {
    const path = new URL(r.request().url()).pathname.slice(1) || 'a';
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: article(path) });
  });
}

/** 等哨兵动态注册完成（见 toolbar.spec.ts） */
async function waitSentinelRegistered(sw: Worker): Promise<void> {
  await expect
    .poll(() => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length))
    .toBe(1);
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

/**
 * 轮询 page.frames()，找到比 beforeCount 更多出现的、地址包含 float.html 的 frame（取最后一个）。
 * 用动态地址（use_dynamic_url）创建的 iframe，Playwright/CDP 报告的 frame.url() 是 Chrome 内部解析后
 * 的真实扩展 ID 地址（而不是 src 属性原样的动态地址）——这是 V-05 的一项实测结论，不是测试逻辑错误：
 * 普通网页自己的 JS 读不到跨源 iframe 的 contentWindow.location，只有调试工具能看到这个解析结果。
 * 按数量而不是按 URL 字符串去重，因为预热产生的小窗 frame 与攻击者新建的 frame 解析后地址完全相同。
 */
async function waitForNewFloatFrame(
  page: Page,
  beforeCount: number,
  timeoutMs = 5000,
): Promise<import('@playwright/test').Frame> {
  const start = Date.now();
  for (;;) {
    const floats = page.frames().filter((fr) => fr.url().includes('float.html'));
    if (floats.length > beforeCount) return floats[floats.length - 1] as import('@playwright/test').Frame;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `没有出现新的 float frame；当前所有 frame：${page
          .frames()
          .map((fr) => fr.url())
          .join(', ')}`,
      );
    }
    await page.waitForTimeout(100);
  }
}

function findIframeSrc(node: DomNode): string | undefined {
  if (node.nodeName === 'IFRAME') {
    const attrs = node.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'src') return attrs[i + 1];
  }
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const hit = findIframeSrc(child);
    if (hit) return hit;
  }
  return node.contentDocument ? findIframeSrc(node.contentDocument) : undefined;
}

/** 像用户一样拖选目标段落并点工具栏「问」；返回小窗宿主 iframe 在穿透 DOM 树里的 src（含令牌片段） */
async function selectAndClickAsk(page: Page, cdp: CDPSession): Promise<string> {
  await page.locator('#target').click({ clickCount: 3 });
  let center: { x: number; y: number } | undefined;
  await expect
    .poll(async () => {
      const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
      const node = findByLabel(root, '问');
      if (!node) return false;
      try {
        const { model } = (await cdp.send('DOM.getBoxModel', {
          backendNodeId: node.backendNodeId,
        })) as { model: { width: number; height: number; content: number[] } };
        if (model.width === 0) return false;
        const q = model.content;
        center = { x: ((q[0] ?? 0) + (q[4] ?? 0)) / 2, y: ((q[1] ?? 0) + (q[5] ?? 0)) / 2 };
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  if (!center) throw new Error('取不到按钮位置');
  await page.mouse.click(center.x, center.y);
  let src: string | undefined;
  await expect
    .poll(async () => {
      const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
      src = findIframeSrc(root);
      return src !== undefined;
    })
    .toBe(true);
  return src as string;
}

test.describe('普通网页自行嵌入 float.html（没有后台发出的真实令牌）', () => {
  test('静态扩展 ID 地址被 use_dynamic_url 拒绝加载', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    await routeSite(page);
    await page.goto(`${SITE}a`);
    const framesBefore = page.frames().length;
    await page.evaluate((extId) => {
      const f = document.createElement('iframe');
      f.id = 'attacker-probe';
      f.src = `chrome-extension://${extId}/float.html`;
      document.body.appendChild(f);
    }, EXTENSION_ID);
    await page.waitForTimeout(800);
    // 被拒绝的加载不会产生一个指向 float.html 的真实 frame（最终停在 chrome-error://）
    expect(page.frames().some((f) => f.url().includes('float.html'))).toBe(false);
    expect(page.frames().length).toBeGreaterThan(framesBefore); // frame 元素本身还是被创建了
    expect(consoleErrors.some((e) => e.includes('web_accessible_resources'))).toBe(true);
  });

  test('知道当前动态地址但没有令牌：iframe 能加载页面本身，但页面停在 noToken，不发起任何连接', async ({
    page,
    serviceWorker,
  }) => {
    const dynamicUrl = await serviceWorker.evaluate(() => chrome.runtime.getURL('/float.html'));
    await routeSite(page);
    await page.goto(`${SITE}a`);
    const before = page.frames().filter((f) => f.url().includes('float.html')).length;
    await page.evaluate((u) => {
      const f = document.createElement('iframe');
      f.id = 'attacker-probe';
      f.src = u;
      document.body.appendChild(f);
    }, dynamicUrl);
    const frame = await waitForNewFloatFrame(page, before);
    await frame.waitForLoadState();
    // 没有令牌：显示提示文案，且不发起 runtime.connect（没有触发后台的 float/sender 日志）
    const text = await frame.evaluate(() => document.body.textContent);
    expect(text).toContain('没有有效的令牌，无法连接');
  });

  test('window.open 打开动态地址（无令牌）效果相同：不出现对话输入框', async ({ page, serviceWorker }) => {
    const dynamicUrl = await serviceWorker.evaluate(() => chrome.runtime.getURL('/float.html'));
    await routeSite(page);
    await page.goto(`${SITE}a`);
    const popupPromise = page.context().waitForEvent('page');
    await page.evaluate((u) => window.open(u, '_blank'), dynamicUrl);
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await expect(popup.getByText('没有有效的令牌，无法连接')).toBeVisible();
    expect(await popup.locator('textarea[aria-label="输入问题"]').count()).toBe(0);
    await popup.close();
  });
});

test('令牌片段不出现在宿主页面的 Performance Resource Timing 条目里', async ({
  context,
  page,
  serviceWorker,
}) => {
  await waitSentinelRegistered(serviceWorker);
  await routeSite(page);
  await page.goto(`${SITE}a`);
  await page.waitForTimeout(300); // 等哨兵在这个文档里就绪、阅读器预热
  await page.evaluate(() => performance.clearResourceTimings());
  const cdp = await context.newCDPSession(page);
  await selectAndClickAsk(page, cdp);
  await cdp.detach();
  const entries = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
  // 小窗 iframe 走的是 <iframe> 导航，不是常规子资源请求：真实表现是宿主页面的 resource
  // 时间线里完全不出现这次导航（空数组），令牌片段更无从谈起。记录下实际条目数，不假设为固定值。
  expect(entries.some((n) => n.includes('float.html') || n.includes('#t='))).toBe(false);
});

test('封闭 shadow root 不能被页面用 Element.prototype.attachShadow 劫持绕过，MutationObserver 也穿不进去', async ({
  context,
  page,
  serviceWorker,
}) => {
  await waitSentinelRegistered(serviceWorker);
  // 在内容脚本运行之前（document_start）劫持 attachShadow，把所有调用强制改成 open 并记下返回的 root；
  // 同时挂一个观察整棵文档子树的 MutationObserver，记录它看到的每条新增节点的 outerHTML
  await page.addInitScript(() => {
    (window as unknown as { __hijacked: unknown[] }).__hijacked = [];
    const orig = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      const root = orig.call(this, { ...init, mode: 'open' });
      (window as unknown as { __hijacked: unknown[] }).__hijacked.push(root);
      return root;
    };
    (window as unknown as { __mutations: string[] }).__mutations = [];
    new MutationObserver((records) => {
      const out = (window as unknown as { __mutations: string[] }).__mutations;
      for (const r of records) {
        for (const n of r.addedNodes) out.push((n as Element).outerHTML ?? String(n.nodeValue));
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  await routeSite(page);
  await page.goto(`${SITE}a`);
  await page.waitForTimeout(300);
  const cdp = await context.newCDPSession(page);
  // 工具栏与小窗宿主正常出现、正常可点（说明劫持没有破坏功能，只是验证它拿不到内容）
  const src = await selectAndClickAsk(page, cdp);
  expect(src).toContain('float.html');
  await cdp.detach();
  const hijacked = await page.evaluate(() =>
    (window as unknown as { __hijacked: { innerHTML?: string }[] }).__hijacked.map((r) => r.innerHTML ?? ''),
  );
  // 页面自己的 attachShadow 劫持从未捕获到工具栏或小窗宿主的 shadow root（它们在内容脚本的隔离环境里，
  // 用的是隔离环境自己的 Element.prototype，不受主世界原型篡改影响）
  expect(hijacked.every((html) => !html.includes('iframe') && !html.includes('aria-label'))).toBe(true);
  // MutationObserver 只能看到宿主 div 本身被加进 document.documentElement（没有 token），
  // 看不到 closed shadow root 内部的 iframe：子树观察不穿过 shadow 边界
  const mutations = await page.evaluate(() => (window as unknown as { __mutations: string[] }).__mutations);
  expect(mutations.some((html) => html.includes('float.html') || html.includes('#t='))).toBe(false);
});

test('握手前的端口消息：被拒绝，没有历史数据，也不建立订阅', async ({ context, page, serviceWorker }) => {
  await waitSentinelRegistered(serviceWorker);
  await routeSite(page);
  await page.goto(`${SITE}a`);
  const cdp = await context.newCDPSession(page);
  await selectAndClickAsk(page, cdp);
  await cdp.detach();
  await expect.poll(() => page.frames().some((f) => f.url().includes('float.html'))).toBe(true);
  const floatFrame = page.frames().find((f) => f.url().includes('float.html'));
  if (!floatFrame) throw new Error('小窗 frame 未出现');
  await floatFrame.waitForLoadState();
  // 在小窗自己的扩展页面上下文里，另开一个独立端口，握手前直接发订阅——验证的是真实浏览器里
  // 后台收到这条消息时看到的 sender 与协议层拒绝路径，不依赖单元测试的假 sender
  const result = await floatFrame.evaluate(
    () =>
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: 'conv' });
        const received: unknown[] = [];
        port.onMessage.addListener((m) => received.push(m));
        port.postMessage({ type: 'conv/subscribe' });
        setTimeout(() => resolve(received), 500);
      }),
  );
  expect(result).toEqual([{ type: 'conv/rejected', reason: 'notHandshaken', refType: 'conv/subscribe' }]);
});

test('跨标签页令牌隔离：在标签页 A 拿到的令牌，标签页 B 用它握手会被拒绝', async ({
  context,
  serviceWorker,
}) => {
  await waitSentinelRegistered(serviceWorker);
  const pageA = await context.newPage();
  await routeSite(pageA);
  await pageA.goto(`${SITE}a`);
  const cdpA = await context.newCDPSession(pageA);
  const srcA = await selectAndClickAsk(pageA, cdpA);
  await cdpA.detach();
  const tokenA = new URL(srcA.replace('#t=', '?t=')).searchParams.get('t') ?? srcA.split('#t=')[1];
  expect(tokenA).toMatch(/^[0-9a-f]{32}$/);

  const pageB = await context.newPage();
  await routeSite(pageB);
  await pageB.goto(`${SITE}b`);
  const dynamicUrl = await serviceWorker.evaluate(() => chrome.runtime.getURL('/float.html'));
  const beforeB = pageB.frames().filter((f) => f.url().includes('float.html')).length;
  await pageB.evaluate((u) => {
    const f = document.createElement('iframe');
    f.src = u; // 标签页 B 自己的动态地址（没有令牌，先建立页面）
    document.body.appendChild(f);
  }, dynamicUrl);
  const frameB = await waitForNewFloatFrame(pageB, beforeB);
  await frameB.waitForLoadState();
  const result = await frameB.evaluate(
    (token) =>
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: 'conv' });
        const received: unknown[] = [];
        port.onMessage.addListener((m) => received.push(m));
        port.postMessage({ type: 'conv/helloFloat', token });
        setTimeout(() => resolve(received), 500);
      }),
    tokenA,
  );
  // 令牌绑定的是标签页 A；标签页 B 的 sender.tab.id 不同，后台按 sender 判定（规则 7），拒绝且不写绑定
  expect(result).toEqual([{ type: 'conv/rejected', reason: 'badToken', refType: 'conv/helloFloat' }]);
  await pageA.close();
  await pageB.close();
});

test('宿主导航后，旧令牌在新文档里握手失败（按 documentId 作废，不是只看标签页）', async ({
  context,
  page,
  serviceWorker,
}) => {
  await waitSentinelRegistered(serviceWorker);
  await routeSite(page);
  await page.goto(`${SITE}a`);
  const cdp1 = await context.newCDPSession(page);
  const src = await selectAndClickAsk(page, cdp1);
  await cdp1.detach();
  const oldToken = src.split('#t=')[1];
  expect(oldToken).toMatch(/^[0-9a-f]{32}$/);

  // 同一个标签页导航到新文档（新 documentId），再次划词触发 selection/ready，
  // 让后台把这次顶层文档记为「新的」（host.noteTopDocument）；划词本身会预热出一个新的小窗 frame，
  // 直接用这个合法 frame 发送旧令牌即可——按规则 7，判定依据是「这个标签页当前的顶层文档」，
  // 不是发送握手的 frame 本身是哪一个
  await page.goto(`${SITE}b`);
  const beforeReselect = page.frames().filter((f) => f.url().includes('float.html')).length;
  await page.locator('#target').click({ clickCount: 3 });
  const frame = await waitForNewFloatFrame(page, beforeReselect);
  await frame.waitForLoadState();
  const result = await frame.evaluate(
    (token) =>
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: 'conv' });
        const received: unknown[] = [];
        port.onMessage.addListener((m) => received.push(m));
        port.postMessage({ type: 'conv/helloFloat', token });
        setTimeout(() => resolve(received), 500);
      }),
    oldToken,
  );
  expect(result).toEqual([{ type: 'conv/rejected', reason: 'badToken', refType: 'conv/helloFloat' }]);
});

// 小窗私有端口（FLOAT_PORT，tabs.connect）尚未实现（另一个 agent 在做拖动/缩放/Esc 收起），
// 按任务要求标 fixme 留着：私有端口落地后把下面两个场景补起来。
test.fixme('小窗私有端口只路由到目标阅读器：错误 frameId/documentId 连接被拒绝（待私有端口合并）', async () => {});
test.fixme('私有端口消息超限或类型未知时被拒绝，不影响已有连接（待私有端口合并）', async () => {});
