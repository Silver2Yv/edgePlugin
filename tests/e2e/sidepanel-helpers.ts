// 侧边栏端到端用的小工具。Playwright 的 context.pages() 拿不到侧边栏页面（它不是标签页，自动附加不到；
// CfT 159、Edge 157 实测），只能用浏览器级调试协议找到侧边栏的 target 再附加上去：
// Target.attachToTarget（flatten: false）+ Target.sendMessageToTarget 收发协议消息。
// 在侧边栏里点按钮用 Input.dispatchMouseEvent（可信点击，带用户激活），取值用 Runtime.evaluate。
import type { BrowserContext, CDPSession, Page, Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { EXTENSION_ID, expect } from './fixtures';

declare const chrome: typeof browser;

export const SIDEPANEL_URL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`;

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export interface PanelHandle {
  targetId: string;
  /** 在侧边栏页面里求值（表达式字符串，可返回 Promise）；返回值按 JSON 传回 */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** 可信点击：先求出元素中心，再发真实鼠标事件 */
  click(selector: string): Promise<void>;
  /** 按 aria-label / data-testid / 文本找元素并取文本 */
  text(selector: string): Promise<string | null>;
  /** 在输入框里键入并可选回车（真实按键） */
  type(text: string): Promise<void>;
  press(key: 'Enter'): Promise<void>;
  /** 直接向侧边栏页面发一条调试协议命令（模拟深色模式、截图等） */
  cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  detach(): Promise<void>;
}

async function browserCdp(context: BrowserContext): Promise<CDPSession> {
  const b = context.browser();
  if (!b) throw new Error('取不到 Browser（持久化上下文应当有）');
  return b.newBrowserCDPSession();
}

export async function sidePanelTargets(context: BrowserContext): Promise<TargetInfo[]> {
  const cdp = await browserCdp(context);
  try {
    const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: TargetInfo[] };
    return targetInfos.filter((t) => t.url.startsWith(SIDEPANEL_URL));
  } finally {
    await cdp.detach();
  }
}

/** 后台看到的侧边栏上下文（5.4：开关状态以 runtime.getContexts 为准） */
export const panelContexts = (sw: Worker) =>
  sw.evaluate(async () => {
    const all = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL] });
    return all.map((c) => ({
      windowId: c.windowId,
      documentId: c.documentId as string,
      url: c.documentUrl as string,
    }));
  });

/** 等到恰好 n 个侧边栏上下文 */
export async function expectPanels(sw: Worker, n: number, message = `侧边栏个数为 ${n}`): Promise<void> {
  await expect.poll(async () => (await panelContexts(sw)).length, { message, timeout: 10_000 }).toBe(n);
}

/** 附加到已打开的侧边栏（只有一个时取它；多个时按 pick 选） */
export async function attachPanel(
  context: BrowserContext,
  pick: (t: TargetInfo[]) => TargetInfo | undefined = (t) => t[0],
): Promise<PanelHandle> {
  let target: TargetInfo | undefined;
  await expect
    .poll(
      async () => {
        target = pick(await sidePanelTargets(context));
        return target !== undefined;
      },
      { message: '侧边栏 target 出现', timeout: 10_000 },
    )
    .toBe(true);
  if (!target) throw new Error('没有侧边栏');
  const cdp = await browserCdp(context);
  const { sessionId } = (await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: false,
  })) as { sessionId: string };
  let next = 0;
  const pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
  cdp.on('Target.receivedMessageFromTarget', (e: { sessionId: string; message: string }) => {
    if (e.sessionId !== sessionId) return;
    const m = JSON.parse(e.message) as { id?: number; result?: unknown; error?: { message: string } };
    if (m.id !== undefined) pending.get(m.id)?.(m);
  });
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      pending.set(id, (m) => {
        pending.delete(id);
        if (m.error) reject(new Error(`${method}: ${m.error.message}`));
        else resolve(m.result as T);
      });
      void cdp
        .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
        .catch(reject);
    });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  };

  const center = (selector: string) =>
    evaluate<{ x: number; y: number } | null>(`(() => {
      // 侧边栏刚打开时先按 0 宽排版（innerWidth 为 0），这时量出的位置等真正排好后就不对了，点下去会落空
      if (innerWidth === 0) return null;
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);

  return {
    targetId: target.targetId,
    evaluate,
    async click(selector) {
      let c: { x: number; y: number } | null = null;
      await expect
        .poll(
          async () => {
            c = await center(selector);
            return c !== null;
          },
          { message: `侧边栏里出现 ${selector}`, timeout: 10_000 },
        )
        .toBe(true);
      const { x, y } = c as unknown as { x: number; y: number };
      for (const type of ['mousePressed', 'mouseReleased'] as const) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
    },
    text: (selector) =>
      evaluate<string | null>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`),
    async type(text) {
      await send('Input.insertText', { text });
    },
    async press(key) {
      const base = { key, code: key, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    cdp: send,
    async detach() {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    },
  };
}

/**
 * 在一个设置页标签里做一次可信点击来打开侧边栏（sidePanel.open 需要用户手势，规则 10）。
 * 监听器在点击的同步路径上调用 open，windowId 事先算好；返回 open 的结果
 */
export async function openPanelByTrustedClick(context: BrowserContext, windowOf?: number): Promise<string> {
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  await opt.evaluate(async (wid) => {
    const w = wid ?? (await chrome.windows.getCurrent()).id;
    const g = window as unknown as { __open?: string };
    document.addEventListener('click', () => {
      chrome.sidePanel.open({ windowId: w as number }).then(
        () => {
          g.__open = 'ok';
        },
        (e: Error) => {
          g.__open = `err: ${e.message}`;
        },
      );
    });
  }, windowOf);
  await opt.mouse.click(5, 5);
  await expect.poll(() => opt.evaluate(() => (window as unknown as { __open?: string }).__open)).toBeTruthy();
  const r = (await opt.evaluate(() => (window as unknown as { __open?: string }).__open)) as string;
  await opt.close();
  return r;
}

/** 在侧边栏输入框里提问并回车（真实点击聚焦、真实按键） */
export async function askInPanel(panel: PanelHandle, question: string): Promise<void> {
  const focused = () =>
    panel.evaluate<boolean>('document.activeElement?.getAttribute("aria-label") === "输入问题"');
  // 点进输入框；没聚焦就再点（面板刚换完内容、布局还在动时，第一下可能落在别处）
  await expect
    .poll(
      async () => {
        if (await focused()) return true;
        await panel.click('textarea[aria-label="输入问题"]');
        return focused();
      },
      { message: '侧边栏输入框获得焦点', timeout: 10_000 },
    )
    .toBe(true);
  await panel.type(question);
  await expect.poll(() => panel.evaluate<string>('document.querySelector("textarea").value')).toBe(question);
  await panel.press('Enter');
}

/** 元素文本（去掉首尾空白：回答区的 Markdown 渲染末尾带换行） */
export const panelText = (panel: PanelHandle, testId: string) =>
  panel.text(`[data-testid="${testId}"]`).then((t) => (t ?? '').trim());

export interface TabInfo {
  id: number;
  windowId: number;
  url: string;
}

/** 网页所在标签页（按地址找） */
export async function tabOf(sw: Worker, page: Page): Promise<TabInfo> {
  const url = page.url();
  const t = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((x) => x.url === u), url);
  if (t?.id === undefined || t.windowId === undefined) throw new Error(`找不到 ${url} 的标签页`);
  return { id: t.id, windowId: t.windowId, url };
}

/**
 * 在后台里直接触发快捷键 / 右键的处理函数：扩展事件对象自带 dispatch，会调到产品注册的监听器。
 * 这样触发没有用户手势，sidePanel.open 会被拒——测的是其余逻辑；手势那一步见手动检查清单
 */
export const dispatchCommand = (sw: Worker, command: string, tab: Partial<TabInfo>) =>
  sw.evaluate(
    ({ command, tab }) =>
      (chrome.commands.onCommand as unknown as { dispatch(...a: unknown[]): void }).dispatch(command, tab),
    { command, tab },
  );

export const dispatchMenu = (sw: Worker, info: Record<string, unknown>, tab: Partial<TabInfo>) =>
  sw.evaluate(
    ({ info, tab }) =>
      (chrome.contextMenus.onClicked as unknown as { dispatch(...a: unknown[]): void }).dispatch(info, tab),
    { info, tab },
  );
