// 子框架阅读器（D10，5.6）：后台在读取页面时按需注入到站点策略允许读的子框架里，不常驻。
// 只响应 page/read，复用顶层阅读器同一套抽取与分片回传（page-read.ts）；没有小窗、截图、定位这些顶层才有的能力。
// 回传的消息由后台按 sender 盖章（frameId、documentId），框架自报的归属不被采信（规则 7）。
// 不发网络请求，不持有对话内容。
import { browser } from 'wxt/browser';
import { backgroundToContent } from '@/core/domain/messages';
import { createPageReader } from './page-read';

const INJECTED = Symbol.for('readingAssistant.subframeReaderInjected');

export function startSubframeReader(): void {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (g[INJECTED]) return;
  g[INJECTED] = true;

  const pageReader = createPageReader((msg) => browser.runtime.sendMessage(msg));
  browser.runtime.onMessage.addListener((raw, sender) => {
    // 只认来自后台的指令（同 reader.ts）
    if (sender.id !== browser.runtime.id || sender.tab !== undefined) return;
    const r = backgroundToContent.parse(raw);
    if (!r.ok || r.value.type !== 'page/read') return;
    void pageReader.read(r.value.readId, r.value.knownContentVersion).catch(() => undefined);
  });
}
