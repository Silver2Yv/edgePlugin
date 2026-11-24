// 后台依赖的真实实现：扩展接口、网络、随机数都在这里，其余模块只依赖 BackgroundDeps（单测换成假的）。
import { browser } from 'wxt/browser';
import { MIN_FRAME_SIZE } from '@/core/context/frame-merge';
import { chatCompletionsAdapter } from '@/core/llm/chat-completions';
import { createIdbConvDb } from '@/platform/conv-db';
import { loadSettings } from '@/platform/settings-store';
import { offscreenCaptureImages } from './capture-image';
import type { BackgroundDeps } from './deps';
import { createNetDiagnostics } from './net-diagnostics';

const READER_FILE = '/content-scripts/reader.js';

/**
 * 在扩展的隔离环境里记一笔「阅读器已注入」，返回之前是否已记过。
 * 后台被回收后内存里的注入记录没了，靠它避免同一文档注入两次；网页脚本看不到隔离环境的全局。
 * 这两个函数被序列化后在页面里执行，不能引用外部变量。
 */
function markReader(): boolean {
  const g = globalThis as { __readingAssistantReader?: boolean };
  const had = g.__readingAssistantReader === true;
  g.__readingAssistantReader = true;
  return had;
}
function unmarkReader(): void {
  delete (globalThis as { __readingAssistantReader?: boolean }).__readingAssistantReader;
}

async function injectReader(tabId: number): Promise<string> {
  const target = { tabId, frameIds: [0] };
  const [probe] = await browser.scripting.executeScript({ target, func: markReader });
  if (!probe) throw new Error('顶层框架无法注入');
  if (probe.result !== true) {
    try {
      await browser.scripting.executeScript({ target, files: [READER_FILE] });
    } catch (e) {
      await browser.scripting.executeScript({ target, func: unmarkReader }).catch(() => undefined);
      throw e;
    }
  }
  return probe.documentId;
}

const SUBFRAME_READER_FILE = '/content-scripts/subframe-reader.js';

/** 在每个框架里一次性执行：只返回框架自己的地址与尺寸（被序列化后在页面里跑，不能引用外部变量，尺寸门槛作参数传入） */
function probeFrame(min: number): { href: string; tooSmall: boolean } {
  return { href: location.href, tooSmall: innerWidth < min || innerHeight < min };
}

async function probeSubframes(tabId: number) {
  const results = await browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: probeFrame,
    args: [MIN_FRAME_SIZE],
  });
  return results.flatMap((r) =>
    r.frameId === 0 || r.result === undefined || r.documentId === undefined
      ? []
      : [{ frameId: r.frameId, documentId: r.documentId, url: r.result.href, tooSmall: r.result.tooSmall }],
  );
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function browserDeps(): BackgroundDeps {
  const session = browser.storage.session;
  // webRequest 监听必须在这里同步注册（browserDeps() 由 main.ts 在顶层同步调用一次）才能观察到
  // Service Worker 自己发出的请求（prototypes/net-probe 实测，V-01/T6c）
  const netDiagnostics = createNetDiagnostics(browser.webRequest);
  return {
    self: { runtimeId: browser.runtime.id, protocol: new URL(browser.runtime.getURL('/')).protocol },
    session: {
      get: (keys) => session.get(keys),
      set: (items) => session.set(items),
      remove: (keys) => session.remove(keys),
    },
    loadSettings,
    injectReader,
    probeSubframes,
    injectSubframeReader: async (tabId, frameId) => {
      await browser.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: [SUBFRAME_READER_FILE],
      });
    },
    getTabUrl: async (tabId) => (await browser.tabs.get(tabId)).url,
    // 不包 async：调用方在手势的同步段里调它，open 必须在这一刻发出（规则 10）
    openSidePanel: (windowId) => browser.sidePanel.open({ windowId }),
    tabWindow: (tabId) =>
      browser.tabs.get(tabId).then(
        (t) => t.windowId,
        () => undefined,
      ),
    windowExists: (windowId) =>
      browser.windows.get(windowId).then(
        () => true,
        () => false,
      ),
    panelWindowOf: async (documentId) => {
      const ctx = await browser.runtime.getContexts({
        contextTypes: [browser.runtime.ContextType.SIDE_PANEL],
        documentIds: [documentId],
      });
      const w = ctx[0]?.windowId;
      return w !== undefined && w >= 0 ? w : undefined;
    },
    sidePanelOpen: async () =>
      (await browser.runtime.getContexts({ contextTypes: [browser.runtime.ContextType.SIDE_PANEL] })).length >
      0,
    // 没有扩展页面在听时 sendMessage 会报「Receiving end does not exist」，这不是失败
    notifyPages: (msg) =>
      browser.runtime.sendMessage(msg).then(
        () => undefined,
        () => undefined,
      ),
    sendToFrame: async (tabId, frameId, documentId, msg) => {
      await browser.tabs.sendMessage(tabId, msg, { frameId, documentId });
    },
    // 不指定 frameId/documentId：每个框架的哨兵各自收到。没有内容脚本在听（标签页已关、还没注入）不算失败
    broadcastToTab: (tabId, msg) =>
      browser.tabs.sendMessage(tabId, msg).then(
        () => undefined,
        () => undefined,
      ),
    fetch: (url, init) => fetch(url, init),
    adapters: { chatCompletions: chatCompletionsAdapter },
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    newToken: () => hex(crypto.getRandomValues(new Uint8Array(16))),
    log: (event, detail) => console.info(`[后台] ${event}${detail ? ` ${JSON.stringify(detail)}` : ''}`),
    lockStorage: () => browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    // 打开或升级失败只记错误名，不记内容；之后每次读写会重试打开
    db: createIdbConvDb({
      onError: (what, e) => console.warn(`[后台] db/${what}Failed`, e instanceof Error ? e.name : 'unknown'),
    }),
    netDiagnostics,
    insertCss: (tabId, documentId, css) =>
      browser.scripting.insertCSS({ target: { tabId, documentIds: [documentId] }, css }),
    requestFrame: (tabId, frameId, documentId, msg) =>
      browser.tabs.sendMessage(tabId, msg, { frameId, documentId }) as Promise<unknown>,
    tabState: (tabId) =>
      browser.tabs.get(tabId).then(
        (t) => ({ active: t.active, windowId: t.windowId }),
        () => undefined,
      ),
    captureVisibleTab: (windowId) => browser.tabs.captureVisibleTab(windowId, { format: 'png' }),
    captureImages: offscreenCaptureImages,
    tabs: jumpTabs,
  };
}

/**
 * 回到某一页用的标签页操作（jump/open，决策 098）。waitLoaded 先挂监听再查一次当前状态，两者之间不漏事件；
 * 新开的标签页一开始可能是空白页且状态已是 complete，所以现状查询只认有真实地址的 complete
 */
const jumpTabs: NonNullable<BackgroundDeps['tabs']> = {
  list: async (windowId) =>
    (await browser.tabs.query({ windowId })).flatMap((t) =>
      t.id === undefined ? [] : [{ id: t.id, url: t.url || t.pendingUrl || undefined, active: t.active }],
    ),
  activate: async (tabId) => {
    await browser.tabs.update(tabId, { active: true });
  },
  create: async (windowId, url) => {
    const t = await browser.tabs.create({ windowId, url, active: true });
    if (t.id === undefined) throw new Error('标签页没有编号');
    return t.id;
  },
  waitLoaded: (tabId, timeoutMs) =>
    new Promise((resolve) => {
      let done = false;
      const finish = (r: 'complete' | 'timeout' | 'closed'): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(onUpdated);
        browser.tabs.onRemoved.removeListener(onRemoved);
        resolve(r);
      };
      const onUpdated = (id: number, change: { status?: string }): void => {
        if (id === tabId && change.status === 'complete') finish('complete');
      };
      const onRemoved = (id: number): void => {
        if (id === tabId) finish('closed');
      };
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      browser.tabs.onUpdated.addListener(onUpdated);
      browser.tabs.onRemoved.addListener(onRemoved);
      browser.tabs.get(tabId).then(
        (t) => {
          if (t.status === 'complete' && t.url && t.url !== 'about:blank') finish('complete');
        },
        () => finish('closed'),
      );
    }),
};
