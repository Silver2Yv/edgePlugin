// V-12（交互与无障碍）的小窗部分，以及拖动 / 缩放（5.3 宿主侧不可见把手）。
// 覆盖：拖动、缩放（及落盘 settings.float.rect）、收起再打开草稿不丢、键盘选区弹工具栏、
// Tab 焦点顺序、焦点在小窗里按 Esc 收起、复制代码按钮、输入法组合输入回车不发送、
// 宿主原生 dialog 打开时的可交互性（照实记录）、200% 缩放、生成中继续阅读/划词不被打断。
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
<html lang="zh-CN"><head><meta charset="utf-8"><title>V-12 交互测试文章</title></head>
<body><article>
<h1>V-12 交互测试文章</h1>
<p id="p1">第一段：这是一篇用来做端到端测试的文章，内容无关紧要。</p>
<p id="target">${PARAGRAPH}</p>
<p>第三段：选中上面那段文字，点工具栏里的「问」，在小窗里提问。</p>
</article>
<dialog id="native-dialog"><p>原生模态对话框</p><button id="close-dialog">关闭</button></dialog>
<button id="open-dialog" onclick="document.getElementById('native-dialog').showModal()">打开原生对话框</button>
</body></html>`;
const MODEL = 'mock-flash';

let relay: MockRelay;

test.beforeAll(async () => {
  relay = await startMockRelay();
});
test.afterAll(() => relay.close());
test.beforeEach(async () => {
  await fetch(`${relay.url}/__reset`, { method: 'POST' });
});

async function setup(page: Page, serviceWorker: Worker, mode: 'ok' | 'markdown' = 'ok'): Promise<void> {
  const conn: Connection = {
    id: 'e2e-conn-0001',
    name: '模拟中转站',
    preset: 'custom',
    baseUrl: mode === 'ok' ? `${relay.url}/v1` : `${relay.url}/m/${mode}/v1`,
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

function findByTestId(node: DomNode, id: string): DomNode | undefined {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === 'data-testid' && attrs[i + 1] === id) return node;
  }
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const hit = findByTestId(child, id);
    if (hit) return hit;
  }
  return node.contentDocument ? findByTestId(node.contentDocument, id) : undefined;
}

/**
 * 宿主侧不可见把手（拖动区 / 缩放角）在宿主 div 的封闭 shadow root 里，不在小窗 iframe 里
 * （5.3：实时拖动/缩放改走宿主侧，见 float-host.ts 文件头注释）；用调试协议穿透取中心点。
 */
async function hostHandleCenter(cdp: CDPSession, testId: string): Promise<{ x: number; y: number }> {
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
  const node = findByTestId(root, testId);
  if (!node) throw new Error(`找不到把手 ${testId}`);
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
  const q = model.content;
  return { x: ((q[0] ?? 0) + (q[4] ?? 0)) / 2, y: ((q[1] ?? 0) + (q[5] ?? 0)) / 2 };
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

/** 选中目标段落 → 点「问」→ 拿到小窗 frame（不等待作答） */
async function selectAndOpenFloat(page: Page, cdp: CDPSession): Promise<Frame> {
  await page.locator('#target').click({ clickCount: 3 });
  await clickToolbarButton(cdp, page, '问');
  return floatFrame(page);
}

/** 小窗宿主 div 的位置与尺寸（它直接挂在 document.documentElement 下，用 data-ra-float-host 标记定位） */
const floatHostRect = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-ra-float-host]') as HTMLElement | null;
    if (!el) return null;
    return {
      left: Number.parseFloat(el.style.left),
      top: Number.parseFloat(el.style.top),
      width: Number.parseFloat(el.style.width),
      height: Number.parseFloat(el.style.height),
    };
  });

const openPopovers = (page: Page) =>
  page.evaluate(
    () => [...document.documentElement.children].filter((el) => el.matches(':popover-open')).length,
  );

/** 小窗私有端口握手完成（宿主收到合法连接）：拖动/缩放前先等它，避免端口还没连上就发消息 */
const waitFloatPortReady = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (document.querySelector('[data-ra-float-host]') as HTMLElement | null)?.dataset
              .raFloatPortReady === 'true',
        ),
      { message: '小窗私有端口已连接' },
    )
    .toBe(true);

const floatRectSetting = (sw: Worker) =>
  sw.evaluate(async () => {
    const { settings } = (await chrome.storage.local.get('settings')) as { settings?: Settings };
    return settings?.float.rect;
  });

test.describe('拖动 / 缩放（5.3 宿主侧不可见把手）', () => {
  test('拖动顶部拖动区：宿主位置按位移改变，并落盘 settings.float.rect', async ({
    page,
    serviceWorker,
    context,
  }) => {
    await setup(page, serviceWorker);
    const cdp = await context.newCDPSession(page);
    await selectAndOpenFloat(page, cdp);
    await waitFloatPortReady(page);

    const before = await floatHostRect(page);
    expect(before).not.toBeNull();

    const center = await hostHandleCenter(cdp, 'float-drag-handle');
    await cdp.detach();
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 40, center.y + 25);
    await page.mouse.up();

    const after = await floatHostRect(page);
    expect(after).not.toBeNull();
    expect(after?.left).toBeCloseTo((before?.left ?? 0) + 40, 0);
    expect(after?.top).toBeCloseTo((before?.top ?? 0) + 25, 0);

    await expect
      .poll(() => floatRectSetting(serviceWorker), { message: '位置落盘', timeout: 10_000 })
      .toMatchObject({ x: expect.closeTo(after?.left ?? 0, 0), y: expect.closeTo(after?.top ?? 0, 0) });
  });

  test('拖动右下角把手：宿主尺寸按位移改变（不小于 200×160），并落盘', async ({
    page,
    serviceWorker,
    context,
  }) => {
    await setup(page, serviceWorker);
    const cdp = await context.newCDPSession(page);
    await selectAndOpenFloat(page, cdp);
    await waitFloatPortReady(page);

    const before = await floatHostRect(page);
    const center = await hostHandleCenter(cdp, 'float-resize-handle');
    await cdp.detach();
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 60, center.y + 40);
    await page.mouse.up();

    const after = await floatHostRect(page);
    expect(after?.width).toBeCloseTo((before?.width ?? 0) + 60, 0);
    expect(after?.height).toBeCloseTo((before?.height ?? 0) + 40, 0);
    expect(after?.width ?? 0).toBeGreaterThanOrEqual(200);
    expect(after?.height ?? 0).toBeGreaterThanOrEqual(160);

    await expect
      .poll(() => floatRectSetting(serviceWorker), { message: '尺寸落盘', timeout: 10_000 })
      .toMatchObject({ w: expect.closeTo(after?.width ?? 0, 0), h: expect.closeTo(after?.height ?? 0, 0) });
  });
});

test('收起再打开草稿不丢：隐藏是 popover 隐藏而不是销毁 iframe', async ({ page, serviceWorker, context }) => {
  await setup(page, serviceWorker);
  const cdp = await context.newCDPSession(page);
  const frame = await selectAndOpenFloat(page, cdp);

  const input = frame.getByLabel('输入问题');
  await expect(input).toBeFocused();
  await frame.page().keyboard.type('还没发送的草稿');
  await expect(input).toHaveValue('还没发送的草稿');

  // 点网页别处：隐藏（不销毁）
  await page.mouse.click(5, 5);
  await expect.poll(() => openPopovers(page)).toBe(0);

  // 再次选中并点「问」：同一个小窗重新显示，草稿还在
  await selectAndOpenFloat(page, cdp);
  await cdp.detach();
  await expect(input).toHaveValue('还没发送的草稿');
});

test('键盘选区（Shift+方向键）弹出工具栏', async ({ page, serviceWorker, context }) => {
  await setup(page, serviceWorker);
  // 实测确认：Chrome 对非可编辑的普通页面文本，默认禁用键盘的选区扩展命令（Shift+方向键什么也
  // 不做）——这是浏览器自身的限制，只有打开“光标浏览”（F7，用户的无障碍设置）才会启用，和我们
  // 的扩展无关；Selection.modify() 同样受这条限制，直接调用也不生效。CDP 不能从页面外触发浏览器
  // 级的 F7 加速键，所以这里用 setBaseAndExtent 直接构造出「键盘扩选到了这个范围」的最终选区状态
  // （和用户真正打开光标浏览后按几次 Shift+方向键得到的 Selection 状态等价），再用一次真实的
  // （isTrusted）按键触发哨兵的 keyup 监听，验证哨兵对「键盘产生的选区变化」的反应：工具栏照常弹出。
  await page.locator('#target').click();
  await page.evaluate(() => {
    const p = document.getElementById('target') as HTMLElement;
    const node = p.firstChild as Node;
    window.getSelection()?.setBaseAndExtent(node, 0, node, 8);
  });
  await page.keyboard.press('Shift'); // 真实的、isTrusted 的按键事件，触发哨兵的 keyup 监听

  const cdp = await context.newCDPSession(page);
  let found = false;
  await expect
    .poll(
      async () => {
        const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as {
          root: DomNode;
        };
        found = findByLabel(root, '问') !== undefined;
        return found;
      },
      { message: '键盘选区后工具栏出现', timeout: 5_000 },
    )
    .toBe(true);
  await cdp.detach();
});

test('Tab / Shift+Tab 焦点顺序可见', async ({ page, serviceWorker, context }) => {
  await setup(page, serviceWorker);
  const cdp = await context.newCDPSession(page);
  const frame = await selectAndOpenFloat(page, cdp);
  await cdp.detach();

  const input = frame.getByLabel('输入问题');
  const askButton = frame.getByRole('button', { name: '问' });
  await expect(input).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(askButton).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(input).toBeFocused();
});

test('焦点在小窗里时按 Esc 收起（经私有端口）', async ({ page, serviceWorker, context }) => {
  await setup(page, serviceWorker);
  const cdp = await context.newCDPSession(page);
  const frame = await selectAndOpenFloat(page, cdp);
  await cdp.detach();

  await expect(frame.getByLabel('输入问题')).toBeFocused();
  await expect.poll(() => openPopovers(page)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => openPopovers(page)).toBe(0);
});

test('中文输入法组合输入时回车不发送，组合结束后再回车才发送', async ({ page, serviceWorker, context }) => {
  await setup(page, serviceWorker);
  const cdp = await context.newCDPSession(page);
  const frame = await selectAndOpenFloat(page, cdp);
  const input = frame.getByLabel('输入问题');
  await expect(input).toBeFocused();

  // Input.imeSetComposition 打开一次真实的 Chromium 合成会话（不是伪造 isComposing 属性）：
  // 输入框先进入组合态，显示拼音/候选阶段的文字
  await cdp.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 });
  await expect(input).toHaveValue('你好');

  // 组合态中按回车：不发送（shouldSendOnEnter 检查 isComposing），原生默认行为是在文本框里换行
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('你好\n');
  await expect(frame.locator('[data-testid="job-state"]')).toHaveCount(0); // 没有任何任务被创建

  // 提交合成（compositionend，isComposing 变回 false），再按一次回车：这次真正发送
  await cdp.send('Input.insertText', { text: '你好' });
  await cdp.detach();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('');
  await expect(frame.locator('[data-testid="job-state"]')).toHaveCount(1);
});

test('代码块复制按钮：点击后写入剪贴板（失败时退回 execCommand，按钮都会提示已复制）', async ({
  page,
  serviceWorker,
  context,
}) => {
  await setup(page, serviceWorker, 'markdown');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const cdp = await context.newCDPSession(page);
  const frame = await selectAndOpenFloat(page, cdp);
  await cdp.detach();
  await askInFloat(frame, '渲染一下这份文档');
  await expect(frame.getByTestId('job-state').last()).toHaveText('completed', { timeout: 15_000 });

  const copyBtn = frame.locator('button.ra-code-copy').first();
  await expect(copyBtn).toBeVisible();
  await copyBtn.click();
  await expect(copyBtn).toHaveText('已复制', { timeout: 3_000 });
});

test('生成中继续阅读与划词不被打断', async ({ page, serviceWorker, context }) => {
  await setup(page, serviceWorker, 'markdown');
  const cdp = await context.newCDPSession(page);
  const frame = await selectAndOpenFloat(page, cdp);
  await askInFloat(frame, '渲染一下这份文档');
  await expect(frame.getByTestId('job-state').last()).toHaveText('streaming', { timeout: 5_000 });

  // 生成中：在宿主页面选中别处文字，工具栏仍能正常出现，不受影响
  await page.locator('#p1').click({ clickCount: 3 });
  await expect
    .poll(
      async () => {
        const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as {
          root: DomNode;
        };
        return findByLabel(root, '问') !== undefined;
      },
      { message: '生成中选中别处仍弹出工具栏', timeout: 5_000 },
    )
    .toBe(true);
  await cdp.detach();

  // 生成没有被这次划词打断，照常完成
  await expect(frame.getByTestId('job-state').last()).toHaveText('completed', { timeout: 15_000 });
});

test('宿主打开原生模态 <dialog> 时小窗是否可交互（照实记录）', async ({ page, serviceWorker, context }) => {
  await setup(page, serviceWorker);
  const cdp = await context.newCDPSession(page);
  const frame = await selectAndOpenFloat(page, cdp);
  await cdp.detach();
  await expect(frame.getByLabel('输入问题')).toBeFocused();

  await page.evaluate(() => (document.getElementById('native-dialog') as HTMLDialogElement).showModal());
  await expect(page.locator('#native-dialog')).toBeVisible();

  // 记录实际行为：原生模态打开后，小窗是否还能被点击/输入
  const input = frame.getByLabel('输入问题');
  let interactable = true;
  try {
    await input.click({ timeout: 1_000 });
    await frame.page().keyboard.type('x');
    interactable = (await input.inputValue()).includes('x');
  } catch {
    interactable = false;
  }
  // 架构 5.3 已知约束：宿主开原生模态 dialog 时小窗可能不可交互。这里断言的是实测结果，
  // 不是我们主观期望；如果某个浏览器版本表现不同，这条断言会先失败，提醒去更新记录文档。
  expect(interactable).toBe(false);
});

test('200% 缩放下布局可用：划词 → 工具栏 → 小窗 → 作答全流程', async ({ page, serviceWorker, context }) => {
  // 自动化测试里模拟整浏览器「200% 缩放」最贴近的办法是把视口减半（同样物理屏幕下
  // CSS 像素减半，与浏览器缩放对布局的影响等价）；这对跨源 iframe（小窗）同样生效，
  // 不像 document.body.style.zoom 那样不会传播进 iframe。真实缩放下的最终验收仍需用户在
  // 真机上用 Ctrl+ 确认（见记录文档「需要用户确认」一节）。
  await page.setViewportSize({ width: 640, height: 360 });
  await setup(page, serviceWorker);
  const cdp = await context.newCDPSession(page);
  const frame = await selectAndOpenFloat(page, cdp);
  await cdp.detach();

  // 小窗本身被夹回缩小后的视口内，不越界
  const rect = await floatHostRect(page);
  expect(rect).not.toBeNull();
  if (rect) {
    expect(rect.left + rect.width).toBeLessThanOrEqual(640);
    expect(rect.top + rect.height).toBeLessThanOrEqual(360);
  }

  await askInFloat(frame, '这段话讲了什么？');
  await expect(frame.getByTestId('job-state').last()).toHaveText('completed', { timeout: 15_000 });
  await expect(frame.getByTestId('answer').last()).toBeVisible();
});
