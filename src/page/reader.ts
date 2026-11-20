// 阅读器（ARCHITECTURE 4.3 规则 1-5、5.3）：只在顶层框架，由后台注入。
// 接小窗相关指令与页面读取（page/read）；定位高亮、截图框选（4.2）这轮不做。不发网络请求，不持有对话内容。
import { browser } from 'wxt/browser';
import { backgroundToContent } from '@/core/domain/messages';
import { createFloatHost } from './float-host';
import { createPageReader } from './page-read';

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

  // 点网页别处或在网页里按 Esc 收起小窗（6.1：隐藏，不销毁）。小窗内部的事件发生在 iframe 自己的文档里，
  // 不会传到网页文档，所以这里收到的都是「别处」。焦点在小窗里时按 Esc 收不到，留给小窗私有端口（5.3）
  document.addEventListener('pointerdown', (e) => e.isTrusted && floatHost.hide(), {
    capture: true,
    passive: true,
  });
  document.addEventListener('keydown', (e) => e.isTrusted && e.key === 'Escape' && floatHost.hide(), {
    capture: true,
  });

  const pageReader = createPageReader((msg) => browser.runtime.sendMessage(msg));

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
      case 'page/read':
        // 页面读取（5.6）：抽取在时间片里做，结果经 page/docPart / page/docUnchanged 回传
        void pageReader.read(r.value.readId, r.value.knownContentVersion).catch(() => undefined);
        break;
      default:
        // page/locate、capture/* 这轮不实现
        break;
    }
  });
}
