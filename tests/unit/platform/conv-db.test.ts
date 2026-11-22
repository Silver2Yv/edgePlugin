// 对话数据库：IndexedDB 实现（fake-indexeddb）与单测用的内存实现跑同一组用例，保证两者行为一致；
// 另测 IndexedDB 的建表、索引与升级失败时保留旧库。
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import {
  type ConversationRecord,
  DB_STORES,
  type MessageRecord,
  type SnapshotRecord,
} from '@/core/domain/records';
import { type ConvDb, createIdbConvDb, ensureStores, type Migration } from '@/platform/conv-db';
import { memoryConvDb } from '../background/memory-db';

let dbs = 0;
const freshName = () => `conv-db-test-${++dbs}`;

const conv = (id: string, pageKey: string | undefined, updatedAt: number): ConversationRecord => ({
  id,
  ...(pageKey === undefined ? {} : { pageKey }),
  title: `标题 ${id}`,
  model: { connectionId: 'conn-0001', model: 'm' },
  turns: 1,
  revision: 1,
  createdAt: updatedAt,
  updatedAt,
});

const msg = (
  id: string,
  conversationId: string,
  ordinal: number,
  status: MessageRecord['status'] = 'completed',
  extra: Partial<MessageRecord> = {},
): MessageRecord => ({
  id,
  conversationId,
  ordinal,
  role: ordinal % 2 === 0 ? 'user' : 'assistant',
  segments: [{ kind: 'text', text: `正文 ${id}` }],
  status,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const snap = (
  id: string,
  conversationId: string,
  pageKey: string,
  expiresAt: number,
  refCount = 0,
): SnapshotRecord => ({
  id,
  conversationId,
  pageKey,
  blocks: [{ id: 'b1', text: '块' }],
  refCount,
  expiresAt,
});

const impls: [string, () => ConvDb][] = [
  ['IndexedDB', () => createIdbConvDb({ name: freshName() })],
  ['内存', () => memoryConvDb()],
];

describe.each(impls)('对话数据库（%s）', (_name, make) => {
  it('对话：按页面取最近的；列表按更新时间降序、before 游标不含、limit', async () => {
    const db = make();
    await db.write({
      conversations: [
        conv('c-00000001', 'https://a.test/x', 100),
        conv('c-00000002', 'https://a.test/x', 300),
        conv('c-00000003', 'https://b.test/y', 200),
        conv('c-00000004', undefined, 400),
      ],
    });
    expect((await db.latestConversation('https://a.test/x'))?.id).toBe('c-00000002');
    expect(await db.latestConversation('https://none.test/')).toBeUndefined();
    expect((await db.listConversations({ limit: 10 })).map((c) => c.id)).toEqual([
      'c-00000004',
      'c-00000002',
      'c-00000003',
      'c-00000001',
    ]);
    expect((await db.listConversations({ limit: 2, before: 300 })).map((c) => c.id)).toEqual([
      'c-00000003',
      'c-00000001',
    ]);
    expect((await db.listConversations({ pageKey: 'https://a.test/x', limit: 10 })).map((c) => c.id)).toEqual(
      ['c-00000002', 'c-00000001'],
    );
    expect(
      (await db.listConversations({ pageKey: 'https://a.test/x', before: 300, limit: 10 })).map((c) => c.id),
    ).toEqual(['c-00000001']);
    expect((await db.getConversation('c-00000003'))?.pageKey).toBe('https://b.test/y');
  });

  it('消息：按 ordinal 升序；按状态查；同一对话同一序号只能有一条（整个写入失败）', async () => {
    const db = make();
    await db.write({
      conversations: [conv('c-00000001', 'https://a.test/x', 1)],
      messages: [msg('m-00000003', 'c-00000001', 1, 'streaming'), msg('m-00000001', 'c-00000001', 0)],
    });
    await db.write({ messages: [msg('m-00000009', 'c-00000009', 0, 'accepted')] });
    expect((await db.getMessages('c-00000001')).map((m) => m.id)).toEqual(['m-00000001', 'm-00000003']);
    expect((await db.getMessage('m-00000003'))?.status).toBe('streaming');
    expect(await db.getMessage('m-99999999')).toBeUndefined();
    const active = await db.messagesWithStatus(['accepted', 'streaming']);
    expect(active.map((m) => m.id).sort()).toEqual(['m-00000003', 'm-00000009']);
    await expect(
      db.write({
        conversations: [conv('c-00000001', 'https://a.test/x', 99)],
        messages: [msg('m-00000004', 'c-00000001', 1)],
      }),
    ).rejects.toThrow();
    // 事务回滚：同一次写入里的对话也没变
    expect((await db.getConversation('c-00000001'))?.updatedAt).toBe(1);
    // 同一条消息覆盖写不算冲突
    await db.write({ messages: [msg('m-00000003', 'c-00000001', 1, 'completed')] });
    expect((await db.getMessages('c-00000001'))[1]?.status).toBe('completed');
  });

  it('删除对话：级联删消息与无人引用的快照，被引用的快照与别的对话不动', async () => {
    const db = make();
    await db.write({
      conversations: [conv('c-00000001', 'https://a.test/x', 1), conv('c-00000002', 'https://a.test/x', 2)],
      messages: [
        msg('m-00000001', 'c-00000001', 0),
        msg('m-00000002', 'c-00000001', 1),
        msg('m-00000003', 'c-00000002', 0),
      ],
      snapshots: [
        snap('s-00000001', 'c-00000001', 'https://a.test/x', 10),
        snap('s-00000002', 'c-00000001', 'https://a.test/x', 10, 1),
        snap('s-00000003', 'c-00000002', 'https://a.test/x', 10),
      ],
    });
    await db.deleteConversation('c-00000001');
    expect(await db.getConversation('c-00000001')).toBeUndefined();
    expect(await db.getMessages('c-00000001')).toEqual([]);
    expect(await db.getSnapshot('s-00000001')).toBeUndefined();
    expect(await db.getSnapshot('s-00000002')).toBeDefined();
    expect(await db.getSnapshot('s-00000003')).toBeDefined();
    expect((await db.getMessages('c-00000002')).length).toBe(1);
  });

  it('删除对话：消息引用的图片解引用（capture 块），减到 0 的删除，别的对话还在用的留着', async () => {
    const db = make();
    const image = (blobId: string) => ({ blobId, mime: 'image/png', width: 2, height: 1 });
    const blob = (id: string, refCount: number) => ({
      id,
      mime: 'image/png',
      data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      refCount,
      createdAt: 1,
    });
    await db.write({
      conversations: [conv('c-00000001', 'https://a.test/x', 1), conv('c-00000002', 'https://a.test/x', 2)],
      messages: [
        msg('m-00000001', 'c-00000001', 0, 'completed', { images: [image('blob-0001'), image('blob-0002')] }),
        msg('m-00000002', 'c-00000002', 0, 'completed', { images: [image('blob-0002')] }),
      ],
      blobs: [blob('blob-0001', 1), blob('blob-0002', 2)],
    });
    expect((await db.getBlob('blob-0001'))?.mime).toBe('image/png');
    await db.deleteConversation('c-00000001');
    expect(await db.getBlob('blob-0001')).toBeUndefined();
    expect((await db.getBlob('blob-0002'))?.refCount).toBe(1);
    await db.deleteConversation('c-00000002');
    expect(await db.getBlob('blob-0002')).toBeUndefined();
  });

  it('快照清理：到期且无人引用的删掉；按条件删（不论引用）', async () => {
    const db = make();
    await db.write({
      snapshots: [
        snap('s-00000001', 'c-1-000000', 'https://a.test/x', 10),
        snap('s-00000002', 'c-1-000000', 'https://a.test/x', 10, 2),
        snap('s-00000003', 'c-1-000000', 'https://b.test/y', 50),
      ],
    });
    expect(await db.purgeExpiredSnapshots(20)).toBe(1);
    expect(await db.getSnapshot('s-00000002')).toBeDefined();
    expect(await db.deleteSnapshotsWhere((s) => s.pageKey?.startsWith('https://a.test/') === true)).toBe(1);
    expect(await db.getSnapshot('s-00000002')).toBeUndefined();
    expect(await db.getSnapshot('s-00000003')).toBeDefined();
  });

  it('页面记录读写；remove 按主键删', async () => {
    const db = make();
    await db.write({
      pages: [
        { pageKey: 'https://a.test/x', host: 'a.test', url: 'https://a.test/x', title: 'A', updatedAt: 1 },
      ],
      messages: [msg('m-00000001', 'c-00000001', 0)],
    });
    expect((await db.getPage('https://a.test/x'))?.title).toBe('A');
    await db.remove({ messages: ['m-00000001'], pages: ['https://a.test/x'] });
    expect(await db.getPage('https://a.test/x')).toBeUndefined();
    expect(await db.getMessages('c-00000001')).toEqual([]);
  });
});

describe('IndexedDB 打开与升级（5.11）', () => {
  it('按 DB_STORES 建表与索引（主键、唯一索引）', async () => {
    const name = freshName();
    const db = createIdbConvDb({ name });
    await db.getConversation('x-00000000');
    const raw = await openDB(name);
    expect([...raw.objectStoreNames].sort()).toEqual(Object.keys(DB_STORES).sort());
    const tx = raw.transaction('messages');
    expect(tx.store.keyPath).toBe('id');
    expect(tx.store.index('byConversationOrdinal').unique).toBe(true);
    expect(tx.store.index('byClientRequest').unique).toBe(true);
    expect(tx.store.index('byStatus').unique).toBe(false);
    raw.close();
  });

  it('升级失败：整个升级回滚，库停在旧版本、旧数据还在，打开报错；修好后再打开能升上去', async () => {
    const name = freshName();
    const v1 = createIdbConvDb({ name });
    await v1.write({ conversations: [conv('c-00000001', 'https://a.test/x', 1)] });
    // 让 v1 的连接让出（blocking），模拟扩展更新到 v2
    const errors: string[] = [];
    const broken: Migration = (d) => {
      d.createObjectStore('half-done');
      throw new Error('迁移出错');
    };
    const v2 = createIdbConvDb({
      name,
      version: 2,
      migrations: { 1: ensureStores, 2: broken },
      onError: (what) => errors.push(what),
    });
    await expect(v2.getConversation('c-00000001')).rejects.toThrow();
    expect(errors).toEqual(['open']);
    const raw = await openDB(name);
    expect(raw.version).toBe(1);
    expect(raw.objectStoreNames.contains('half-done')).toBe(false);
    expect((await raw.get('conversations', 'c-00000001'))?.id).toBe('c-00000001');
    raw.close();

    const fixed: Migration = (d, tx) => {
      ensureStores(d, tx);
      d.createObjectStore('extra', { keyPath: 'id' });
    };
    const v2ok = createIdbConvDb({ name, version: 2, migrations: { 1: ensureStores, 2: fixed } });
    expect((await v2ok.getConversation('c-00000001'))?.id).toBe('c-00000001');
  });

  it('库的版本比代码新（扩展回退）：打开失败并报错，不覆盖', async () => {
    const name = freshName();
    const newer = createIdbConvDb({
      name,
      version: 3,
      migrations: { 1: ensureStores, 2: () => {}, 3: () => {} },
    });
    await newer.write({ conversations: [conv('c-00000001', 'https://a.test/x', 1)] });
    const errors: string[] = [];
    const old = createIdbConvDb({ name, onError: (w) => errors.push(w) });
    await expect(old.getConversation('c-00000001')).rejects.toThrow();
    expect(errors).toEqual(['open']);
    expect((await newer.getConversation('c-00000001'))?.id).toBe('c-00000001');
  });
});
