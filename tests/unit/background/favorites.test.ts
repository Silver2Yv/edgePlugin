// 收藏（5.11、G1–G3）：工具栏「存」落库、「不读取页面内容」站点降级、回答上的「存」（快照 refCount 加一）、
// 编辑与删除（refCount 解引用）、小窗也能发 favorite/add（contract-v1.5）。数据库用内存实现。
import { describe, expect, it } from 'vitest';
import { askMsg, click, type Harness, makeHarness, readyFloat, SELECTED, SETTINGS, until } from './harness';

type Conn = ReturnType<Harness['connect']>;
const PAGE = 'https://example.test/article';

const ANCHOR = {
  exact: SELECTED,
  prefix: '前文',
  suffix: '后文',
  blockDigest: 'abc',
  headingPath: [],
  scrollRatio: 0.5,
  offsetInBlock: 0,
};

const states = (c: Conn) => c.ofType('conv/jobState').map((m) => m.state);
const accepted = (c: Conn) => c.ofType('conv/accepted') as { conversationId: string; messageId: string }[];

/** 带选区发问并答完，返回这一轮的 conversationId / messageId（助手消息） */
async function askAndAnswer(h: Harness, c: Conn, answer = '答案正文') {
  await h.message(click());
  await h.message({ type: 'selection/anchored', selectionRevision: 1, anchor: ANCHOR, blockIds: ['b1'] });
  const n = h.fetches.length;
  c.send(askMsg());
  await until(() => h.fetches.length === n + 1, '发问');
  h.fetches[n]?.res.push(`T:${answer}\nF\n`);
  h.fetches[n]?.res.close();
  await until(() => states(c).at(-1) === 'completed', '完成');
  await h.app.history.search({ limit: 1 }); // 等排队的终态写库完成（saveTerminal 是异步的）
  const a = accepted(c).at(-1) as { conversationId: string; messageId: string };
  return a;
}

describe('工具栏「存」（addFromSelection）', () => {
  it('落库的收藏带锚点、原文快照是锚点前后文，来源页面与 pageKey 正确', async () => {
    const h = makeHarness();
    await h.message({ type: 'selection/anchored', selectionRevision: 1, anchor: ANCHOR, blockIds: ['b1'] });
    const res = await h.message(click(1, 'save'));
    expect(res).toMatchObject({ ok: true });
    const favs = await h.db.listFavorites({ limit: 10 });
    expect(favs).toHaveLength(1);
    expect(favs[0]).toMatchObject({
      pageKey: PAGE,
      url: PAGE,
      selection: SELECTED,
      sourceText: `前文${SELECTED}后文`,
      anchor: { exact: SELECTED },
      blobIds: [],
    });
    expect(favs[0]?.answer).toBeUndefined();
    expect(favs[0]?.source).toBeUndefined();
  });

  it('「不读取页面内容」站点：不取锚点，原文快照就是选中文字本身', async () => {
    const h = makeHarness();
    h.setSettings({ ...SETTINGS, sites: [{ host: 'example.test', level: 'noRead' }] });
    await h.message({ type: 'selection/anchored', selectionRevision: 1, anchor: ANCHOR, blockIds: ['b1'] });
    const res = await h.message(click(1, 'save'));
    expect(res).toMatchObject({ ok: true });
    const favs = await h.db.listFavorites({ limit: 10 });
    expect(favs[0]).toMatchObject({ selection: SELECTED, sourceText: SELECTED });
    expect(favs[0]?.anchor).toBeUndefined();
    // 站点不读取：也不为取锚点去读页面
    expect(h.sent.filter((s) => s.msg.type === 'page/read')).toHaveLength(0);
  });

  it('没读过页面就存：先读一次页面取锚点（selection/anchored 随读取到达），带锚点落库；读不到锚点也照常保存', async () => {
    const h = makeHarness({ anchorWaitMs: 150 });
    const saved = h.message(click(1, 'save'));
    await until(() => h.sent.some((s) => s.msg.type === 'page/read'), '为取锚点读页面');
    await h.message({ type: 'selection/anchored', selectionRevision: 1, anchor: ANCHOR, blockIds: ['b1'] });
    expect(await saved).toMatchObject({ ok: true });
    const favs = await h.db.listFavorites({ limit: 10 });
    expect(favs[0]).toMatchObject({ sourceText: `前文${SELECTED}后文`, anchor: { exact: SELECTED } });
    expect(h.sent.filter((s) => s.msg.type === 'page/read')).toHaveLength(1);

    // 页面没读成（没人应答）：等一会儿就不带锚点存
    const h2 = makeHarness({ anchorWaitMs: 20 });
    expect(await h2.message(click(1, 'save'))).toMatchObject({ ok: true });
    const f2 = await h2.db.listFavorites({ limit: 10 });
    expect(f2[0]).toMatchObject({ selection: SELECTED, sourceText: SELECTED });
    expect(f2[0]?.anchor).toBeUndefined();
  });

  it('写库失败时回 ok:false，不广播 favorite/changed', async () => {
    const h = makeHarness();
    h.db.failWrites = true;
    const res = await h.message(click(1, 'save'));
    expect(res).toEqual({ ok: false, reason: 'storageFailed' });
    expect(h.pageMessages).toHaveLength(0);
  });

  it('成功后广播 favorite/changed（已打开的收藏视图据此刷新）', async () => {
    const h = makeHarness();
    await h.message(click(1, 'save'));
    expect(h.pageMessages).toContainEqual({ type: 'favorite/changed' });
  });
});

describe('回答上的「存」（favorite/add）', () => {
  it('小窗也能发（contract-v1.5：CONV_COMMON 放行），快照 refCount 加一', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const { conversationId, messageId } = await askAndAnswer(h, c);
    // 手动挂一份快照（完整的「带全文发问」流程另有 persist-flow.test.ts 覆盖，这里只测 refCount 维护）
    const asst = h.db.tables.messages.get(messageId);
    if (!asst) throw new Error('assistant message missing');
    h.db.tables.messages.set(messageId, { ...asst, contextSnapshotId: 'snap-fav-0001' });
    h.db.tables.snapshots.set('snap-fav-0001', {
      id: 'snap-fav-0001',
      conversationId,
      blocks: [],
      refCount: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    c.send({ type: 'favorite/add', conversationId, messageId });
    await until(() => c.ofType('favorite/saved').length > 0, 'favorite/saved');
    const saved = c.ofType('favorite/saved')[0] as { favoriteId: string; messageId: string };
    expect(saved.messageId).toBe(messageId);
    const fav = await h.db.getFavorite(saved.favoriteId);
    expect(fav).toMatchObject({
      pageKey: PAGE,
      selection: SELECTED,
      answer: '答案正文',
      source: { conversationId, messageId },
      anchor: { exact: SELECTED },
    });
    expect((await h.db.getSnapshot('snap-fav-0001'))?.refCount).toBe(1);
  });

  it('对话 / 消息对不上、未完成的助手消息都拒绝（invalid）', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const { messageId } = await askAndAnswer(h, c);
    c.send({ type: 'favorite/add', conversationId: 'conv-other-00', messageId });
    await until(() => c.ofType('conv/rejected').length > 0, 'rejected');
    expect(c.last()).toMatchObject({ type: 'conv/rejected', reason: 'invalid' });
  });
});

describe('收藏管理：编辑与删除（G2）', () => {
  it('favorite/update 改标题与笔记', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click(1, 'save'));
    const [fav] = await h.db.listFavorites({ limit: 1 });
    c.send({
      type: 'favorite/update',
      requestId: 'req-update-01',
      favoriteId: fav?.id,
      title: '我的标题',
      note: '笔记',
    });
    await until(() => c.ofType('favorite/updated').length > 0, 'updated');
    const after = await h.db.getFavorite(fav?.id ?? '');
    expect(after).toMatchObject({ title: '我的标题', note: '笔记' });
  });

  it('favorite/remove 删除后解引用快照、blob；再删不存在的收藏回 invalid', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const { conversationId, messageId } = await askAndAnswer(h, c);
    const asst = h.db.tables.messages.get(messageId);
    if (!asst) throw new Error('assistant message missing');
    h.db.tables.messages.set(messageId, { ...asst, contextSnapshotId: 'snap-fav-0002' });
    h.db.tables.snapshots.set('snap-fav-0002', {
      id: 'snap-fav-0002',
      conversationId,
      blocks: [],
      refCount: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    c.send({ type: 'favorite/add', conversationId, messageId });
    await until(() => c.ofType('favorite/saved').length > 0, 'saved');
    const { favoriteId } = c.ofType('favorite/saved')[0] as { favoriteId: string };
    expect((await h.db.getSnapshot('snap-fav-0002'))?.refCount).toBe(1);
    c.send({ type: 'favorite/remove', requestId: 'req-remove-01', favoriteId });
    await until(() => c.ofType('favorite/removed').length > 0, 'removed');
    expect(await h.db.getFavorite(favoriteId)).toBeUndefined();
    expect((await h.db.getSnapshot('snap-fav-0002'))?.refCount).toBe(0);
    c.send({ type: 'favorite/remove', requestId: 'req-remove-02', favoriteId });
    await until(() => c.ofType('conv/rejected').length > 0, 'rejected');
    expect(c.last()).toMatchObject({ type: 'conv/rejected', reason: 'invalid', refId: 'req-remove-02' });
  });
});
