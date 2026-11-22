// 历史消息里截图的缩略图（capture 块）：按需向后台要（image/get → image/thumb），在本页内存里缓存。
// 小窗与侧边栏各自是一个页面，各有一份；连接由所在页面（FloatApp / SidePanelApp）提供。
import { useEffect, useState } from 'preact/hooks';
import type { BackgroundToClient } from '@/core/domain/messages';

type Requester = (msg: { requestId: string; messageId: string; index: number }) => void;

let requester: Requester | null = null;
const cache = new Map<string, string>();
/** 已发出、还没回的请求：编号 → 缓存键 */
const pending = new Map<string, string>();
const listeners = new Set<() => void>();

const keyOf = (messageId: string, index: number) => `${messageId}#${index}`;

/** 所在页面登记怎么发 image/get（端口没连上时发不出去，等下次挂载再要） */
export function setImageRequester(fn: Requester | null): void {
  requester = fn;
}

/** 端口收到的消息先过一遍：image/thumb 进缓存，通知等着的缩略图 */
export function onImageMessage(raw: unknown): void {
  const m = raw as BackgroundToClient | undefined;
  if (m?.type !== 'image/thumb') return;
  const key = pending.get(m.requestId) ?? keyOf(m.messageId, m.index);
  pending.delete(m.requestId);
  cache.set(key, m.thumb);
  for (const l of listeners) l();
}

/** 某条消息第 index 张图的缩略图；还没有就去要，拿到后重新渲染 */
export function useImageThumb(messageId: string | undefined, index: number): string | undefined {
  const key = messageId === undefined ? undefined : keyOf(messageId, index);
  const [, bump] = useState(0);
  useEffect(() => {
    if (key === undefined || messageId === undefined) return;
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    if (!cache.has(key) && ![...pending.values()].includes(key) && requester) {
      const requestId = crypto.randomUUID();
      pending.set(requestId, key);
      try {
        requester({ requestId, messageId, index });
      } catch {
        pending.delete(requestId);
      }
    }
    return () => {
      listeners.delete(l);
    };
  }, [key]);
  return key === undefined ? undefined : cache.get(key);
}
