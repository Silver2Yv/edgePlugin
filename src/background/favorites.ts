// 收藏写入（5.11、G1、G3）：工具栏「存」（选区收藏）与回答上的「存」（favorite/add）共用的落库逻辑，
// 以及收藏管理的编辑、删除（G2）。后台是唯一写入者；列表与搜索由侧边栏直接只读查询 IndexedDB（5.4、platform/conv-db.ts）。
// 引用的快照 / blob 的 refCount 在这里维护（5.7「快照保留」）：加入时加一，删除收藏时解引用。
import type { Anchor } from '@/core/anchor/anchor';
import { segmentsText } from '@/core/domain/conversation';
import type { BackgroundToClient, ClientToBackground, RejectReason } from '@/core/domain/messages';
import type { FavoriteRecord } from '@/core/domain/records';
import type { BackgroundDeps } from './deps';

type AddFromMessageMsg = Extract<ClientToBackground, { type: 'favorite/add' }>;
type UpdateMsg = Extract<ClientToBackground, { type: 'favorite/update' }>;
type RemoveMsg = Extract<ClientToBackground, { type: 'favorite/remove' }>;
type Reply = (msg: BackgroundToClient) => void;
type Reject = (reason: RejectReason, raw: unknown) => void;

/** 工具栏「存」的输入：身份（pageKey、url）已由调用方按 sender 核实过，不信消息体（规则 7） */
export interface SaveSelectionInput {
  pageKey: string;
  url: string;
  text: string;
  anchor: Anchor | undefined;
}

const errName = (e: unknown) => (e instanceof Error ? e.name : 'unknown');

export type Favorites = ReturnType<typeof createFavorites>;

export function createFavorites(deps: BackgroundDeps) {
  const db = deps.db;

  /** 原文快照：有锚点时带上前后约 32 字的上下文，没有（如「不读取页面内容」站点）就是选中文字本身 */
  function sourceTextOf(text: string, anchor: Anchor | undefined): string {
    return anchor ? `${anchor.prefix}${anchor.exact}${anchor.suffix}` || text : text;
  }

  function changed(): void {
    void deps.notifyPages({ type: 'favorite/changed' }).catch(() => undefined);
  }

  return {
    /** 工具栏「存」：只存选中的文字 + 原文快照 + 锚点 + 来源页面，不经对话，不碰快照表/blob 表 */
    async addFromSelection(
      input: SaveSelectionInput,
    ): Promise<{ ok: true; favoriteId: string } | { ok: false }> {
      const id = deps.newId();
      const record: FavoriteRecord = {
        id,
        pageKey: input.pageKey,
        url: input.url,
        selection: input.text,
        sourceText: sourceTextOf(input.text, input.anchor),
        ...(input.anchor ? { anchor: input.anchor } : {}),
        blobIds: [],
        createdAt: deps.now(),
      };
      try {
        await db.write({ favorites: [record] });
      } catch (e) {
        deps.log('favorite/addFailed', { error: errName(e) });
        return { ok: false };
      }
      changed();
      return { ok: true, favoriteId: id };
    },

    /**
     * 回答上的「存」：收藏这条回答连同它的提问与引用（选中文字取自回答前面那条用户消息）。
     * 要求消息存在、属于这个对话、是已完成的助手消息；引用的快照 refCount 加一（blob 这版本还没有图片来源，留空）
     */
    async addFromMessage(msg: AddFromMessageMsg, post: Reply, reject: Reject): Promise<void> {
      const message = await db.getMessage(msg.messageId).catch(() => undefined);
      if (
        !message ||
        message.conversationId !== msg.conversationId ||
        message.role !== 'assistant' ||
        message.status !== 'completed'
      ) {
        return reject('invalid', msg);
      }
      let messages: Awaited<ReturnType<typeof db.getMessages>>;
      try {
        messages = await db.getMessages(msg.conversationId);
      } catch (e) {
        deps.log('favorite/addFailed', { error: errName(e) });
        return reject('storageFailed', msg);
      }
      const question = messages.filter((m) => m.role === 'user' && m.ordinal < message.ordinal).at(-1);
      const selectionText =
        question?.selection?.text ?? question?.sentText ?? segmentsText(question?.segments ?? []);
      const anchor = question?.selection?.anchor;
      const conversation = await db.getConversation(msg.conversationId).catch(() => undefined);
      const pageKey = conversation?.pageKey ?? '';
      const page = pageKey ? await db.getPage(pageKey).catch(() => undefined) : undefined;
      const id = deps.newId();
      const record: FavoriteRecord = {
        id,
        pageKey,
        url: page?.url ?? pageKey,
        selection: selectionText,
        sourceText: sourceTextOf(selectionText, anchor),
        ...(anchor ? { anchor } : {}),
        answer: segmentsText(message.segments),
        source: { conversationId: msg.conversationId, messageId: msg.messageId },
        blobIds: [],
        createdAt: deps.now(),
      };
      try {
        if (message.contextSnapshotId) {
          const snap = await db.getSnapshot(message.contextSnapshotId);
          if (snap) await db.write({ snapshots: [{ ...snap, refCount: snap.refCount + 1 }] });
        }
        await db.write({ favorites: [record] });
      } catch (e) {
        deps.log('favorite/addFailed', { error: errName(e) });
        return reject('storageFailed', msg);
      }
      post({ type: 'favorite/saved', favoriteId: id, messageId: msg.messageId });
      changed();
    },

    /** 编辑标题 / 笔记（G2）；不存在回 invalid，写库失败回 storageFailed */
    async update(msg: UpdateMsg, post: Reply, reject: Reject): Promise<void> {
      const fav = await db.getFavorite(msg.favoriteId).catch(() => undefined);
      if (!fav) return reject('invalid', msg);
      const next: FavoriteRecord = {
        ...fav,
        ...(msg.title !== undefined ? { title: msg.title } : {}),
        ...(msg.note !== undefined ? { note: msg.note } : {}),
      };
      try {
        await db.write({ favorites: [next] });
      } catch (e) {
        deps.log('favorite/updateFailed', { error: errName(e) });
        return reject('storageFailed', msg);
      }
      post({ type: 'favorite/updated', requestId: msg.requestId, favoriteId: msg.favoriteId });
      changed();
    },

    /** 删除收藏（G2）：解引用它关联的快照与 blob（floor 0），再删收藏记录 */
    async remove(msg: RemoveMsg, post: Reply, reject: Reject): Promise<void> {
      const fav = await db.getFavorite(msg.favoriteId).catch(() => undefined);
      if (!fav) return reject('invalid', msg);
      try {
        if (fav.source) {
          const message = await db.getMessage(fav.source.messageId).catch(() => undefined);
          if (message?.contextSnapshotId) {
            const snap = await db.getSnapshot(message.contextSnapshotId);
            if (snap) await db.write({ snapshots: [{ ...snap, refCount: Math.max(0, snap.refCount - 1) }] });
          }
        }
        for (const blobId of fav.blobIds) {
          const blob = await db.getBlob(blobId);
          if (blob) await db.write({ blobs: [{ ...blob, refCount: Math.max(0, blob.refCount - 1) }] });
        }
        await db.remove({ favorites: [msg.favoriteId] });
      } catch (e) {
        deps.log('favorite/removeFailed', { error: errName(e) });
        return reject('storageFailed', msg);
      }
      post({ type: 'favorite/removed', requestId: msg.requestId, favoriteId: msg.favoriteId });
      changed();
    },
  };
}
