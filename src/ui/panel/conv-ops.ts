// 对话流端口上「发一条等一条应答」的辅助（仅侧边栏用）：history/query（可能分批）、history/delete、
// favorite/update、favorite/remove 共用同一个已握手的 CONV_PORT，按 queryId / requestId 关联应答；
// 失败经 conv/rejected 回来，refId 对得上同样路由给对应的等待者。纯逻辑 + 一个小的订阅表，不碰扩展 API。

import { ID_PATTERN } from '@/core/domain/ids';
import type { BackgroundToClient, ClientToBackground, RejectReason } from '@/core/domain/messages';
import type { ConversationRecord } from '@/core/domain/records';

function newOpId(): string {
  // 32 个十六进制字符，满足 ID_PATTERN（8–64 位小写字母数字短横线）
  const id = crypto.randomUUID().replace(/-/g, '');
  return ID_PATTERN.test(id) ? id : id.padEnd(8, '0');
}

export type OpListener = (msg: BackgroundToClient) => void;

export interface OpRegistry {
  register(key: string, onMessage: OpListener): void;
  unregister(key: string): void;
  /** 收到一条 BackgroundToClient：是已知编号的应答就转发给等待者，并报告是否命中 */
  dispatch(msg: BackgroundToClient): boolean;
}

function opKeyOf(msg: BackgroundToClient): string | undefined {
  switch (msg.type) {
    case 'history/page':
      return msg.queryId;
    case 'history/deleted':
      return msg.requestId;
    case 'favorite/updated':
      return msg.requestId;
    case 'favorite/removed':
      return msg.requestId;
    case 'conv/rejected':
      return msg.refId;
    default:
      return undefined;
  }
}

export function createOpRegistry(): OpRegistry {
  const pending = new Map<string, OpListener>();
  return {
    register(key, onMessage) {
      pending.set(key, onMessage);
    },
    unregister(key) {
      pending.delete(key);
    },
    dispatch(msg) {
      const key = opKeyOf(msg);
      if (key === undefined) return false;
      const cb = pending.get(key);
      if (!cb) return false;
      cb(msg);
      return true;
    },
  };
}

export type OpResult<T> = { ok: true; value: T } | { ok: false; reason: RejectReason };

export interface OpDeps {
  post: (msg: ClientToBackground) => void;
  registry: OpRegistry;
}

export interface HistoryPage {
  items: readonly ConversationRecord[];
  nextBefore?: number;
}

/** history/query：按页面或全部、可带搜索文字、分页；分批到达的 history/page 在这里拼起来 */
export function queryHistory(
  deps: OpDeps,
  params: { pageKey?: string; text?: string; before?: number; limit: number },
): Promise<OpResult<HistoryPage>> {
  const queryId = newOpId();
  return new Promise((resolve) => {
    let items: ConversationRecord[] = [];
    deps.registry.register(queryId, (msg) => {
      if (msg.type === 'conv/rejected') {
        deps.registry.unregister(queryId);
        resolve({ ok: false, reason: msg.reason });
        return;
      }
      if (msg.type !== 'history/page') return;
      items = [...items, ...msg.items];
      if (msg.done) {
        deps.registry.unregister(queryId);
        resolve({
          ok: true,
          value: { items, ...(msg.nextBefore === undefined ? {} : { nextBefore: msg.nextBefore }) },
        });
      }
    });
    deps.post({
      type: 'history/query',
      queryId,
      limit: params.limit,
      ...(params.pageKey === undefined ? {} : { pageKey: params.pageKey }),
      ...(params.text === undefined ? {} : { text: params.text }),
      ...(params.before === undefined ? {} : { before: params.before }),
    });
  });
}

/** history/delete：事务提交后才算成功 */
export function deleteHistoryConversation(deps: OpDeps, conversationId: string): Promise<OpResult<void>> {
  const requestId = newOpId();
  return new Promise((resolve) => {
    deps.registry.register(requestId, (msg) => {
      deps.registry.unregister(requestId);
      if (msg.type === 'conv/rejected') resolve({ ok: false, reason: msg.reason });
      else resolve({ ok: true, value: undefined });
    });
    deps.post({ type: 'history/delete', requestId, conversationId });
  });
}

/** favorite/update：编辑标题 / 笔记（G2） */
export function updateFavorite(
  deps: OpDeps,
  favoriteId: string,
  patch: { title?: string; note?: string },
): Promise<OpResult<void>> {
  const requestId = newOpId();
  return new Promise((resolve) => {
    deps.registry.register(requestId, (msg) => {
      deps.registry.unregister(requestId);
      if (msg.type === 'conv/rejected') resolve({ ok: false, reason: msg.reason });
      else resolve({ ok: true, value: undefined });
    });
    deps.post({ type: 'favorite/update', requestId, favoriteId, ...patch });
  });
}

/** favorite/remove：删除一条收藏（G2），解引用由后台处理 */
export function removeFavorite(deps: OpDeps, favoriteId: string): Promise<OpResult<void>> {
  const requestId = newOpId();
  return new Promise((resolve) => {
    deps.registry.register(requestId, (msg) => {
      deps.registry.unregister(requestId);
      if (msg.type === 'conv/rejected') resolve({ ok: false, reason: msg.reason });
      else resolve({ ok: true, value: undefined });
    });
    deps.post({ type: 'favorite/remove', requestId, favoriteId });
  });
}
