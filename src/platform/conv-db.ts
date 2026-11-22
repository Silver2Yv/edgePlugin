// 对话数据库（5.11）：IndexedDB 的打开、升级与读写。后台是对话数据的唯一写入者（5.11「写入口径」）；
// 表结构只在 core/domain/records.ts 的 DB_STORES 定义，这里按它建表与索引。
//
// 升级（5.11「schema 升级」）：版本号 + 事务迁移。每一步迁移在同一个 versionchange 事务里执行，任何一步抛错整个
// 事务回滚，库停在旧版本、旧数据原样保留，打开失败并报错（onError），不删库、不静默降级；之后每次调用都会重试打开。
// 库的版本比代码新（扩展回退到旧版本）同样打开失败并报错，不覆盖。
//
// 这里只提供按表、按索引的基本读写与必须在一个事务里完成的级联；续接规则、历史搜索、快照分批等在 background/ 与 core/。
import { type IDBPDatabase, type IDBPTransaction, openDB } from 'idb';
import {
  DB_NAME,
  DB_STORES,
  DB_VERSION,
  type DbRecords,
  type MessageRecord,
  type StoreName,
} from '@/core/domain/records';

type Db = IDBPDatabase<unknown>;
type UpgradeTx = IDBPTransaction<unknown, ArrayLike<string>, 'versionchange'>;
export type Migration = (db: Db, tx: UpgradeTx) => void;

/** 一次写入：各表要 put 的记录；同一次 write 在一个事务里提交 */
export type DbWrites = { [K in StoreName]?: readonly DbRecords[K][] };
/** 一次删除：各表要删的主键 */
export type DbDeletes = { [K in StoreName]?: readonly string[] };

export interface ListConversationsQuery {
  /** 只看这个页面的对话 */
  pageKey?: string;
  /** 只看 updatedAt 小于它的（分页游标，不含） */
  before?: number;
  limit: number;
}

/** 后台用的对话数据库接口；真实实现见 createIdbConvDb，单测换成内存实现 */
export interface ConvDb {
  getConversation(id: string): Promise<DbRecords['conversations'] | undefined>;
  /** 某页面最近更新的对话 */
  latestConversation(pageKey: string): Promise<DbRecords['conversations'] | undefined>;
  /** 按 updatedAt 降序 */
  listConversations(q: ListConversationsQuery): Promise<DbRecords['conversations'][]>;
  /** 某对话的全部消息，按 ordinal 升序 */
  getMessages(conversationId: string): Promise<MessageRecord[]>;
  getMessage(id: string): Promise<MessageRecord | undefined>;
  /** 处于这些状态的消息（启动扫描找 accepted / streaming） */
  messagesWithStatus(statuses: readonly MessageRecord['status'][]): Promise<MessageRecord[]>;
  getPage(pageKey: string): Promise<DbRecords['pages'] | undefined>;
  getSnapshot(id: string): Promise<DbRecords['snapshots'] | undefined>;
  /** 图片（截图，5.13）；没有返回 undefined */
  getBlob(id: string): Promise<DbRecords['blobs'] | undefined>;
  /** 一个事务写入；事务提交后才 resolve（5.11 写入确认） */
  write(w: DbWrites): Promise<void>;
  /** 一个事务删除 */
  remove(d: DbDeletes): Promise<void>;
  /**
   * 删对话：它的消息、无人引用（refCount 为 0）的快照一并删除；消息引用的图片解引用，减到 0 的删除。一个事务（5.11 级联）
   */
  deleteConversation(id: string): Promise<void>;
  /** 删到期（expiresAt ≤ now）且无人引用的快照，返回删了几条 */
  purgeExpiredSnapshots(now: number): Promise<number>;
  /** 删满足条件的快照（不论引用），返回删了几条；用于站点改为「不读取页面内容」后清掉该站的快照 */
  deleteSnapshotsWhere(pred: (s: DbRecords['snapshots']) => boolean): Promise<number>;
}

/** 按 DB_STORES 补建缺的表与索引（已有的不动）；新版本加表、加索引时同样适用 */
export function ensureStores(db: Db, tx: UpgradeTx): void {
  for (const [name, def] of Object.entries(DB_STORES)) {
    const store = db.objectStoreNames.contains(name)
      ? tx.objectStore(name)
      : db.createObjectStore(name, { keyPath: def.keyPath });
    for (const [index, spec] of Object.entries(def.indexes)) {
      if (store.indexNames.contains(index)) continue;
      const keyPath = typeof spec === 'object' && 'keyPath' in spec ? spec.keyPath : spec;
      const unique = typeof spec === 'object' && 'unique' in spec ? spec.unique : false;
      store.createIndex(index, typeof keyPath === 'string' ? keyPath : [...keyPath], { unique });
    }
  }
}

/** 升级到第 N 版要做的事。加版本时在这里加一步，并在单测里放一份旧版本的数据样本做回归 */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: ensureStores,
};

export interface IdbConvDbOptions {
  name?: string;
  version?: number;
  migrations?: Readonly<Record<number, Migration>>;
  /** 打开或升级失败时报告（不含内容） */
  onError?: (what: string, error: unknown) => void;
}

const LOW = Number.NEGATIVE_INFINITY;
const HIGH = Number.POSITIVE_INFINITY;

export function createIdbConvDb(opts: IdbConvDbOptions = {}): ConvDb {
  const name = opts.name ?? DB_NAME;
  const version = opts.version ?? DB_VERSION;
  const migrations = opts.migrations ?? MIGRATIONS;
  let opening: Promise<Db> | undefined;

  function db(): Promise<Db> {
    if (opening) return opening;
    const p = openDB(name, version, {
      upgrade(d, oldVersion, newVersion, tx) {
        try {
          for (let v = oldVersion + 1; v <= (newVersion ?? version); v++) {
            const step = migrations[v];
            if (!step) throw new Error(`缺少第 ${v} 版的迁移`);
            step(d, tx);
          }
        } catch (e) {
          // 整个升级事务回滚：库停在旧版本，旧数据不动（中止后 done 会被拒，这里接住，错误由打开失败报告）
          tx.done.catch(() => undefined);
          try {
            tx.abort();
          } catch {
            // 已中止
          }
          throw e;
        }
      },
      // 有更新版本的代码要升级（扩展更新）：让出连接，下次调用重新打开
      blocking() {
        void p.then((d) => d.close()).catch(() => undefined);
        if (opening === p) opening = undefined;
      },
      terminated() {
        if (opening === p) opening = undefined;
      },
    });
    opening = p;
    p.catch((e: unknown) => {
      if (opening === p) opening = undefined;
      opts.onError?.('open', e);
    });
    return p;
  }

  async function collect<T>(
    cursorP: Promise<{ value: unknown; continue(): Promise<unknown> } | null>,
    limit: number,
  ): Promise<T[]> {
    const out: T[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: idb 游标类型随表与索引变化，这里只读 value
    let c: any = await cursorP;
    while (c && out.length < limit) {
      out.push(c.value as T);
      c = await c.continue();
    }
    return out;
  }

  return {
    async getConversation(id) {
      return (await (await db()).get('conversations', id)) as DbRecords['conversations'] | undefined;
    },

    async latestConversation(pageKey) {
      const d = await db();
      const range = IDBKeyRange.bound([pageKey, LOW], [pageKey, HIGH]);
      const c = await d.transaction('conversations').store.index('byPageUpdated').openCursor(range, 'prev');
      return (c?.value ?? undefined) as DbRecords['conversations'] | undefined;
    },

    async listConversations(q) {
      const d = await db();
      const store = d.transaction('conversations').store;
      if (q.pageKey !== undefined) {
        const range = IDBKeyRange.bound(
          [q.pageKey, LOW],
          [q.pageKey, q.before ?? HIGH],
          false,
          q.before !== undefined,
        );
        return collect(store.index('byPageUpdated').openCursor(range, 'prev'), q.limit);
      }
      const range = q.before === undefined ? null : IDBKeyRange.upperBound(q.before, true);
      return collect(store.index('byUpdatedAt').openCursor(range, 'prev'), q.limit);
    },

    async getMessages(conversationId) {
      const d = await db();
      const range = IDBKeyRange.bound([conversationId, LOW], [conversationId, HIGH]);
      return (await d.getAllFromIndex('messages', 'byConversationOrdinal', range)) as MessageRecord[];
    },

    async getMessage(id) {
      return (await (await db()).get('messages', id)) as MessageRecord | undefined;
    },

    async messagesWithStatus(statuses) {
      const d = await db();
      const out: MessageRecord[] = [];
      for (const s of statuses)
        out.push(...((await d.getAllFromIndex('messages', 'byStatus', s)) as MessageRecord[]));
      return out;
    },

    async getPage(pageKey) {
      return (await (await db()).get('pages', pageKey)) as DbRecords['pages'] | undefined;
    },

    async getSnapshot(id) {
      return (await (await db()).get('snapshots', id)) as DbRecords['snapshots'] | undefined;
    },

    async getBlob(id) {
      return (await (await db()).get('blobs', id)) as DbRecords['blobs'] | undefined;
    },

    async write(w) {
      const names = (Object.keys(w) as StoreName[]).filter((k) => (w[k]?.length ?? 0) > 0);
      if (names.length === 0) return;
      const tx = (await db()).transaction(names, 'readwrite');
      const puts: Promise<unknown>[] = [];
      for (const n of names) for (const r of w[n] ?? []) puts.push(tx.objectStore(n).put(r));
      await Promise.all([...puts, tx.done]);
    },

    async remove(del) {
      const names = (Object.keys(del) as StoreName[]).filter((k) => (del[k]?.length ?? 0) > 0);
      if (names.length === 0) return;
      const tx = (await db()).transaction(names, 'readwrite');
      const ops: Promise<unknown>[] = [];
      for (const n of names) for (const k of del[n] ?? []) ops.push(tx.objectStore(n).delete(k));
      await Promise.all([...ops, tx.done]);
    },

    async deleteConversation(id) {
      const tx = (await db()).transaction(['conversations', 'messages', 'snapshots', 'blobs'], 'readwrite');
      const work = (async () => {
        await tx.objectStore('conversations').delete(id);
        const range = IDBKeyRange.bound([id, LOW], [id, HIGH]);
        const blobRefs: string[] = [];
        let m = await tx.objectStore('messages').index('byConversationOrdinal').openCursor(range);
        while (m) {
          for (const img of (m.value as MessageRecord).images ?? []) blobRefs.push(img.blobId);
          await m.delete();
          m = await m.continue();
        }
        let s = await tx.objectStore('snapshots').index('byConversation').openCursor(id);
        while (s) {
          if ((s.value as DbRecords['snapshots']).refCount === 0) await s.delete();
          s = await s.continue();
        }
        // 图片解引用（截图，5.13）：同一张图被引用几次就减几次，减到 0 删除
        const blobs = tx.objectStore('blobs');
        for (const blobId of blobRefs) {
          const b = (await blobs.get(blobId)) as DbRecords['blobs'] | undefined;
          if (!b) continue;
          if (b.refCount <= 1) await blobs.delete(blobId);
          else await blobs.put({ ...b, refCount: b.refCount - 1 });
        }
      })();
      await Promise.all([work, tx.done]);
    },

    async purgeExpiredSnapshots(now) {
      const tx = (await db()).transaction('snapshots', 'readwrite');
      let n = 0;
      const work = (async () => {
        let c = await tx.store.index('byExpiresAt').openCursor(IDBKeyRange.upperBound(now));
        while (c) {
          if ((c.value as DbRecords['snapshots']).refCount === 0) {
            await c.delete();
            n++;
          }
          c = await c.continue();
        }
      })();
      await Promise.all([work, tx.done]);
      return n;
    },

    async deleteSnapshotsWhere(pred) {
      const tx = (await db()).transaction('snapshots', 'readwrite');
      let n = 0;
      const work = (async () => {
        let c = await tx.store.openCursor();
        while (c) {
          if (pred(c.value as DbRecords['snapshots'])) {
            await c.delete();
            n++;
          }
          c = await c.continue();
        }
      })();
      await Promise.all([work, tx.done]);
      return n;
    },
  };
}
