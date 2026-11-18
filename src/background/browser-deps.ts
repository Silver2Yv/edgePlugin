// 后台依赖的真实实现：扩展接口、网络、随机数都在这里，其余模块只依赖 BackgroundDeps（单测换成假的）。
import { browser } from 'wxt/browser';
import { chatCompletionsAdapter } from '@/core/llm/chat-completions';
import { loadSettings } from '@/platform/settings-store';
import type { BackgroundDeps } from './deps';

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

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function browserDeps(): BackgroundDeps {
  const session = browser.storage.session;
  return {
    self: { runtimeId: browser.runtime.id, protocol: new URL(browser.runtime.getURL('/')).protocol },
    session: {
      get: (keys) => session.get(keys),
      set: (items) => session.set(items),
      remove: (keys) => session.remove(keys),
    },
    loadSettings,
    injectReader,
    sendToFrame: async (tabId, frameId, documentId, msg) => {
      await browser.tabs.sendMessage(tabId, msg, { frameId, documentId });
    },
    fetch: (url, init) => fetch(url, init),
    adapters: { chatCompletions: chatCompletionsAdapter },
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    newToken: () => hex(crypto.getRandomValues(new Uint8Array(16))),
    log: (event, detail) => console.info(`[后台] ${event}${detail ? ` ${JSON.stringify(detail)}` : ''}`),
  };
}
