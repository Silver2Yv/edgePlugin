// 对话数据库的内存实现（单测用，沿用 harness.ts 假依赖的做法）。行为与 platform/conv-db.ts 的 IndexedDB 实现一致，
// tests/unit/platform/conv-db.test.ts 用同一组用例核对两者。另可让写入失败，测「写库失败不能让界面以为成功」。

import { DB_STORES, type DbRecords, type MessageRecord, type StoreName } from '@/core/domain/records';
import type { ConvDb, DbDeletes, DbWrites } from '@/platform/conv-db';

type Tables = { [K in StoreName]: Map<string, DbRecords[K]> };

export interface MemoryConvDb extends ConvDb {
  tables: Tables;
  /** 之后的 write / remove / delete 都失败，直到改回 false */
  failWrites: boolean;
  /** 之后的读取都失败 */
  failReads: boolean;
  /** 写入次数（每次 write 调用一次） */
  writes: DbWrites[];
}

const clone = <T>(v: T): T => structuredClone(v);

function keyOf<K extends StoreName>(name: K, r: DbRecords[K]): string {
  return String((r as unknown as Record<string, unknown>)[DB_STORES[name].keyPath]);
}

export function memoryConvDb(): MemoryConvDb {
  const tables = {
    pages: new Map(),
    conversations: new Map(),
    messages: new Map(),
    snapshots: new Map(),
    favorites: new Map(),
    blobs: new Map(),
  } as Tables;

  const self: MemoryConvDb = {
    tables,
    failWrites: false,
    failReads: false,
    writes: [],

    async getConversation(id) {
      read();
      return clone(tables.conversations.get(id));
    },
    async latestConversation(pageKey) {
      read();
      return clone(
        [...tables.conversations.values()]
          .filter((c) => c.pageKey === pageKey)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0],
      );
    },
    async listConversations(q) {
      read();
      return clone(
        [...tables.conversations.values()]
          .filter(
            (c) =>
              (q.pageKey === undefined || c.pageKey === q.pageKey) &&
              (q.before === undefined || c.updatedAt < q.before),
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, q.limit),
      );
    },
    async getMessages(conversationId) {
      read();
      return clone(
        [...tables.messages.values()]
          .filter((m) => m.conversationId === conversationId)
          .sort((a, b) => a.ordinal - b.ordinal),
      );
    },
    async getMessage(id) {
      read();
      return clone(tables.messages.get(id));
    },
    async messagesWithStatus(statuses) {
      read();
      return clone([...tables.messages.values()].filter((m: MessageRecord) => statuses.includes(m.status)));
    },
    async getPage(pageKey) {
      read();
      return clone(tables.pages.get(pageKey));
    },
    async getSnapshot(id) {
      read();
      return clone(tables.snapshots.get(id));
    },
    async getBlob(id) {
      read();
      return clone(tables.blobs.get(id));
    },
    async write(w) {
      if (self.failWrites) throw new Error('写入失败（测试）');
      self.writes.push(clone(w));
      // 唯一索引：同一对话同一序号只能有一条消息（与 IndexedDB 一致，冲突时整个写入失败）
      for (const m of w.messages ?? []) {
        for (const x of tables.messages.values()) {
          if (x.id !== m.id && x.conversationId === m.conversationId && x.ordinal === m.ordinal)
            throw new Error('ConstraintError');
        }
      }
      for (const name of Object.keys(w) as StoreName[]) {
        const table = tables[name] as Map<string, unknown>;
        for (const r of w[name] ?? []) table.set(keyOf(name, r as never), clone(r));
      }
    },
    async remove(d: DbDeletes) {
      if (self.failWrites) throw new Error('写入失败（测试）');
      for (const name of Object.keys(d) as StoreName[]) for (const k of d[name] ?? []) tables[name].delete(k);
    },
    async deleteConversation(id) {
      if (self.failWrites) throw new Error('写入失败（测试）');
      tables.conversations.delete(id);
      const blobRefs: string[] = [];
      for (const [k, m] of tables.messages)
        if (m.conversationId === id) {
          for (const img of m.images ?? []) blobRefs.push(img.blobId);
          tables.messages.delete(k);
        }
      for (const [k, s] of tables.snapshots)
        if (s.conversationId === id && s.refCount === 0) tables.snapshots.delete(k);
      for (const blobId of blobRefs) {
        const b = tables.blobs.get(blobId);
        if (!b) continue;
        if (b.refCount <= 1) tables.blobs.delete(blobId);
        else tables.blobs.set(blobId, { ...b, refCount: b.refCount - 1 });
      }
    },
    async purgeExpiredSnapshots(now) {
      if (self.failWrites) throw new Error('写入失败（测试）');
      let n = 0;
      for (const [k, s] of tables.snapshots) {
        if (s.expiresAt <= now && s.refCount === 0) {
          tables.snapshots.delete(k);
          n++;
        }
      }
      return n;
    },
    async deleteSnapshotsWhere(pred) {
      if (self.failWrites) throw new Error('写入失败（测试）');
      let n = 0;
      for (const [k, s] of tables.snapshots) {
        if (pred(clone(s))) {
          tables.snapshots.delete(k);
          n++;
        }
      }
      return n;
    },
  };

  function read(): void {
    if (self.failReads) throw new Error('读取失败（测试）');
  }

  return self;
}

export type { DbWrites };
