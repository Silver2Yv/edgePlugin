// 阅读器（ARCHITECTURE 4.3 规则 1-5、5.3）：只在顶层框架，由后台注入。
// 页面读取、定位高亮、截图框选（4.2）这轮不做；只接小窗相关指令。不发网络请求，不持有对话内容。
import { browser } from 'wxt/browser';
import { backgroundToContent } from '@/core/domain/messages';
import { createFloatHost } from './float-host';

const INJECTED = Symbol.for('readingAssistant.readerInjected');

export function startReader(): void {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (g[INJECTED]) return;
  g[INJECTED] = true;

  const floatHost = createFloatHost((result) => {
    const msg: { type: 'float/loadResult'; result: 'ready' | 'failedTransient' } = {
      type: 'float/loadResult',
      result,
    };
    void browser.runtime.sendMessage(msg);
  });

  browser.runtime.onMessage.addListener((raw, sender) => {
    // 只认来自后台的指令：sender.id 是本扩展，且没有 sender.tab（内容脚本发的消息都带 tab）
    if (sender.id !== browser.runtime.id || sender.tab !== undefined) return;
    const r = backgroundToContent.parse(raw);
    if (!r.ok) return;
    switch (r.value.type) {
      case 'float/prewarm':
        floatHost.prewarm(r.value.token);
        break;
      case 'float/show':
        floatHost.show({ token: r.value.token, focusInput: r.value.focusInput });
        break;
      case 'float/hide':
        floatHost.hide();
        break;
      default:
        // page/read、page/locate、capture/* 这轮不实现
        break;
    }
  });
}
