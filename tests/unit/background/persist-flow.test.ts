// 对话落库（5.5、5.11）、后台重启后续接、续接规则（D12、D13）、归属与授权（5.12）、订阅快照、历史与删除、
// 启动扫描、页面记录与快照、上次总结。数据库用内存实现（memory-db.ts，与 IndexedDB 实现跑同一组契约用例）。
import { describe, expect, it } from 'vitest';
import { contentVersionOf } from '@/core/context/content-version';
import type { BlockReport, PageDocReport } from '@/core/context/page-doc';
import { splitByJsonBytes } from '@/core/domain/bytes';
import type { MessageRecord } from '@/core/domain/records';
import {
  askMsg,
  click,
  fakeSession,
  type Harness,
  MODEL,
  makeHarness,
  readyFloat,
  SELECTED,
  SETTINGS,
  TAB,
  TOP_DOC,
  until,
  WIN,
} from './harness';

type Conn = ReturnType<Harness['connect']>;
const MIN = 60_000;
const PAGE = 'https://example.test/article';
const OTHER_PAGE = 'https://other.test/page';

const states = (c: Conn) => c.ofType('conv/jobState').map((m) => m.state);
const accepted = (c: Conn) =>
  c.ofType('conv/accepted') as { conversationId: string; messageId: string; newConversation?: string }[];
const bodyMessages = (h: Harness, i: number) =>
  JSON.parse(String(h.fetches[i]?.init.body)).messages as { role: string; content: unknown }[];
const dbMessages = (h: Harness, conversationId: string) =>
  [...h.db.tables.messages.values()]
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => a.ordinal - b.ordinal);
const assistantIn = (h: Harness, conversationId: string) =>
  dbMessages(h, conversationId)
    .filter((m) => m.role === 'assistant')
    .at(-1) as MessageRecord;

let reqs = 0;
const rid = () => `req-p-${String(++reqs).padStart(6, '0')}`;

/** 发问并答完（不带选区），返回 conv/accepted */
async function answered(h: Harness, c: Conn, extra: Record<string, unknown> = {}, answer = '答') {
  const n = h.fetches.length;
  const k = accepted(c).length;
  const done = states(c).filter((s) => s === 'completed').length;
  c.send(askMsg({ clientRequestId: rid(), selectionRevision: undefined, text: `问${n}`, ...extra }));
  await until(() => h.fetches.length === n + 1 && accepted(c).length === k + 1, '发问');
  h.fetches[n]?.res.push(`T:${answer}\nF\n`);
  h.fetches[n]?.res.close();
  await until(() => states(c).filter((s) => s === 'completed').length === done + 1, '完成');
  await h.app.history.search({ limit: 1 }); // 等排队的写库完成
  return accepted(c)[k] as ReturnType<typeof accepted>[number];
}

async function readyPanel(h: Harness, tabId = TAB) {
  const c = h.connect(h.panelSender());
  c.send({ type: 'conv/helloSidepanel', windowId: WIN });
  await until(() => c.ofType('conv/ready').length > 0, '侧边栏握手');
  await subscribe(c, { tabId });
  return c;
}

async function subscribe(c: Conn, extra: Record<string, unknown> = {}) {
  const before = c.ofType('conv/snapshot').filter((m) => m.done).length + c.ofType('conv/rejected').length;
  c.send({ type: 'conv/subscribe', ...extra });
  await until(
    () => c.ofType('conv/snapshot').filter((m) => m.done).length + c.ofType('conv/rejected').length > before,
    '订阅',
  );
}

const ANCHOR = {
  exact: SELECTED,
  prefix: '',
  suffix: '',
  blockDigest: 'abc',
  headingPath: [],
  scrollRatio: 0.5,
  offsetInBlock: 0,
};

describe('落库（5.5、5.11）', () => {
  it('接单：一个事务写对话、用户消息（选区与锚点、档位）、占位助手消息；终态写正文、思考、计划、模型；用户消息补实际发送全文', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    await h.message({ type: 'selection/anchored', selectionRevision: 1, anchor: ANCHOR, blockIds: ['b1'] });
    c.send(askMsg());
    await until(() => h.fetches.length === 1);
    const first = h.db.writes[0];
    expect(first?.conversations?.[0]).toMatchObject({
      pageKey: PAGE,
      turns: 1,
      revision: 1,
      title: '这句话什么意思？',
    });
    const [user, asst] = first?.messages ?? [];
    expect(user).toMatchObject({
      role: 'user',
      ordinal: 0,
      status: 'completed',
      segments: [{ kind: 'text', text: '这句话什么意思？' }],
      request: { actionId: 'ask', contextTier: 'selection', lengthTier: 'normal', thinking: 'off' },
      selection: { text: SELECTED, truncated: false, anchor: { exact: SELECTED } },
    });
    expect(asst).toMatchObject({
      role: 'assistant',
      ordinal: 1,
      status: 'accepted',
      clientRequestId: 'req-00000001',
    });
    // 请求发出时 session 里已有任务记录（先持久化再发请求）
    expect(h.fetches[0]?.jobsAtCall).toHaveLength(1);

    h.fetches[0]?.res.push('R:先想想\nT:这是答案\nF\n');
    h.fetches[0]?.res.close();
    await until(() => states(c).includes('completed'));
    const conversationId = accepted(c)[0]?.conversationId as string;
    await until(() => assistantIn(h, conversationId).status === 'completed', '终态写库');
    const a = assistantIn(h, conversationId);
    expect(a).toMatchObject({
      segments: [{ kind: 'text', text: '这是答案' }],
      reasoning: '先想想',
      model: MODEL,
      plan: { contextTier: 'selection', pageRead: false },
    });
    expect(a.contextSnapshotId).toBe(a.plan?.contextSnapshotId);
    const u = dbMessages(h, conversationId)[0] as MessageRecord;
    expect(u.sentText).toContain(`<selected_text>\n${SELECTED}\n</selected_text>`);
    expect(h.db.tables.conversations.get(conversationId)?.revision).toBeGreaterThan(1);
  });

  it('接单写库失败：拒绝（storageFailed），不写 session、不发请求；库好了同一个 clientRequestId 能再发', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    h.db.failWrites = true;
    c.send(askMsg());
    await until(() => c.ofType('conv/rejected').length === 1);
    expect(c.ofType('conv/rejected')[0]).toMatchObject({ reason: 'storageFailed', refId: 'req-00000001' });
    expect(h.fetches).toHaveLength(0);
    expect([...h.session.data.keys()].some((k) => k.startsWith('job:'))).toBe(false);
    h.db.failWrites = false;
    c.send(askMsg());
    await until(() => h.fetches.length === 1);
  });

  it('终态写库重试一次仍失败：推 conv/saveFailed，界面不把回答当成已存', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    c.send(askMsg({ selectionRevision: undefined }));
    await until(() => h.fetches.length === 1);
    h.db.failWrites = true;
    h.fetches[0]?.res.push('T:答\nF\n');
    h.fetches[0]?.res.close();
    await until(() => c.ofType('conv/saveFailed').length === 1, 'saveFailed');
    expect(c.ofType('conv/saveFailed')[0]).toMatchObject({ messageId: accepted(c)[0]?.messageId });
    expect(states(c)).toContain('completed');
  });

  it('生成中按检查点把已生成的部分写进库（有新内容才写）', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    c.send(askMsg({ selectionRevision: undefined }));
    await until(() => h.fetches.length === 1);
    h.fetches[0]?.res.push('T:写到一半\n');
    const conversationId = accepted(c)[0]?.conversationId as string;
    await vi_wait(() => assistantIn(h, conversationId).segments.length > 0, 3000);
    expect(assistantIn(h, conversationId)).toMatchObject({
      status: 'streaming',
      segments: [{ kind: 'text', text: '写到一半' }],
    });
    h.fetches[0]?.res.close();
  });
});

/** 等待更久的条件（检查点间隔 1.5 秒） */
async function vi_wait(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('后台重启后（5.5）', () => {
  it('不指定对话接着问：按续接规则接上库里的对话，请求带上上一轮；订阅快照从库里来、不带 sentText', async () => {
    const h1 = makeHarness();
    const c1 = await readyFloat(h1);
    const first = await answered(h1, c1, {}, '第一轮的回答');
    const h2 = makeHarness({ session: h1.session, db: h1.db });
    const c2 = h2.connect();
    c2.send({ type: 'conv/resumeFloat' });
    await until(() => c2.ofType('conv/ready').length === 1);
    await subscribe(c2);
    expect(c2.ofType('conv/subscribed')[0]).toMatchObject({ conversationId: first.conversationId });
    const snap = c2.ofType('conv/snapshot').at(-1) as {
      conversation: { id: string };
      messages: MessageRecord[];
    };
    expect(snap.conversation.id).toBe(first.conversationId);
    expect(snap.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'completed'],
      ['assistant', 'completed'],
    ]);
    expect(snap.messages.some((m) => 'sentText' in m)).toBe(false);

    c2.send(askMsg({ clientRequestId: rid(), selectionRevision: undefined, text: '接着问' }));
    await until(() => h2.fetches.length === 1);
    expect(accepted(c2)[0]?.conversationId).toBe(first.conversationId);
    const body = bodyMessages(h2, 0);
    expect(body.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.stringify(body[2])).toContain('第一轮的回答');
    // 序号接着库里的
    expect(dbMessages(h2, first.conversationId).map((m) => m.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it('启动扫描：库里 accepted / streaming 的助手消息标 interrupted（有 session 记录：workerRestarted；没有：unknownOnStartup），保留检查点内容；到期无人引用的快照清掉', async () => {
    const h1 = makeHarness();
    const c1 = await readyFloat(h1);
    c1.send(askMsg({ selectionRevision: undefined }));
    await until(() => h1.fetches.length === 1);
    const conversationId = accepted(c1)[0]?.conversationId as string;
    h1.db.tables.snapshots.set('snap-old-0001', {
      id: 'snap-old-0001',
      conversationId,
      blocks: [],
      refCount: 0,
      expiresAt: 1,
    });
    h1.db.tables.snapshots.set('snap-ref-0001', {
      id: 'snap-ref-0001',
      conversationId,
      blocks: [],
      refCount: 1,
      expiresAt: 1,
    });
    const h2 = makeHarness({ session: h1.session, db: h1.db });
    await h2.app.ready;
    expect(assistantIn(h2, conversationId)).toMatchObject({
      status: 'interrupted',
      interruptReason: 'workerRestarted',
    });
    expect(h2.db.tables.snapshots.has('snap-old-0001')).toBe(false);
    expect(h2.db.tables.snapshots.has('snap-ref-0001')).toBe(true);

    // 浏览器重启过（session 清空）：结果未知
    const m = assistantIn(h2, conversationId);
    h2.db.tables.messages.set(m.id, { ...m, status: 'streaming' });
    const h3 = makeHarness({ session: fakeSession(), db: h2.db });
    await h3.app.ready;
    expect(assistantIn(h3, conversationId)).toMatchObject({
      status: 'interrupted',
      interruptReason: 'unknownOnStartup',
    });
  });
});

describe('续接规则（D12、D13）', () => {
  it('同一页不指定对话：距上次提问 30 分钟内续接；超过就新建并带上原因 idle', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const a = await answered(h, c);
    expect(a.newConversation).toBeUndefined();
    h.advance(30 * MIN);
    const b = await answered(h, c);
    expect(b.conversationId).toBe(a.conversationId);
    expect(bodyMessages(h, 1).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    h.advance(30 * MIN + 1);
    const d = await answered(h, c);
    expect(d.conversationId).not.toBe(a.conversationId);
    expect(d.newConversation).toBe('idle');
    expect(bodyMessages(h, 2).map((m) => m.role)).toEqual(['system', 'user']);
    // 订阅也按同一规则：最近的对话是刚新建的那个
    await subscribe(c);
    expect(c.ofType('conv/subscribed').at(-1)).toMatchObject({ conversationId: d.conversationId });
    // 时间过了，订阅显示空的新对话
    h.advance(30 * MIN + 1);
    await subscribe(c);
    expect(c.ofType('conv/subscribed').at(-1)?.conversationId).toBeUndefined();
    expect(c.ofType('conv/snapshot').at(-1)).toMatchObject({ messages: [], done: true });
  });

  it('第 20 轮还能续接，满 20 轮新建（turnLimit）', async () => {
    const h1 = makeHarness();
    const c1 = await readyFloat(h1);
    const a = await answered(h1, c1);
    const rec = h1.db.tables.conversations.get(a.conversationId);
    if (!rec) throw new Error('对话没落库');
    h1.db.tables.conversations.set(a.conversationId, { ...rec, turns: 19 });
    // 换一个后台实例，对话从库里读
    const h = makeHarness({ session: h1.session, db: h1.db });
    const c = h.connect();
    c.send({ type: 'conv/resumeFloat' });
    await until(() => c.ofType('conv/ready').length === 1);
    const b = await answered(h, c);
    expect(b.conversationId).toBe(a.conversationId);
    expect(h.db.tables.conversations.get(a.conversationId)?.turns).toBe(20);
    const d = await answered(h, c);
    expect(d.conversationId).not.toBe(a.conversationId);
    expect(d.newConversation).toBe('turnLimit');
  });

  it('fresh：明确新建，不续接、不带原因；与 conversationId 同时出现拒绝', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const a = await answered(h, c);
    const b = await answered(h, c, { fresh: true });
    expect(b.conversationId).not.toBe(a.conversationId);
    expect(b.newConversation).toBeUndefined();
    c.send(
      askMsg({
        clientRequestId: rid(),
        selectionRevision: undefined,
        fresh: true,
        conversationId: a.conversationId,
      }),
    );
    await until(() => c.ofType('conv/rejected').length === 1);
    expect(c.ofType('conv/rejected')[0]).toMatchObject({ reason: 'invalid' });
  });

  it('指定对话：用户明确选的，超过 30 分钟也直接续接', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const a = await answered(h, c);
    h.advance(120 * MIN);
    const b = await answered(h, c, { conversationId: a.conversationId });
    expect(b.conversationId).toBe(a.conversationId);
    expect(b.newConversation).toBeUndefined();
  });
});

describe('归属与授权（5.12）', () => {
  /** 在标签页 8（另一个页面）上，侧边栏问出一个对话 */
  async function otherPageConversation(h: Harness) {
    h.moveTab(8, WIN);
    h.setTabUrl(OTHER_PAGE, 8);
    const panel = await readyPanel(h, 8);
    const r = await answered(h, panel, {}, '别页的回答');
    return { panel, conversationId: r.conversationId };
  }

  it('小窗不能订阅别的页面的对话；侧边栏可以查看任意历史对话（快照带消息）', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    const { conversationId } = await otherPageConversation(h);
    await subscribe(float, { conversationId });
    expect(float.ofType('conv/rejected').at(-1)).toMatchObject({
      reason: 'notOwner',
      refType: 'conv/subscribe',
    });

    const panel = await readyPanel(h, TAB);
    await subscribe(panel, { tabId: TAB, conversationId });
    expect(panel.ofType('conv/subscribed').at(-1)).toMatchObject({ tabId: TAB, conversationId });
    const snap = panel.ofType('conv/snapshot').at(-1) as { messages: MessageRecord[] };
    expect(
      snap.messages.map((m) => m.segments.map((s) => (s.kind === 'text' ? s.text : '')).join('')),
    ).toContain('别页的回答');
  });

  it('续接发问：侧边栏指定别的页面的对话被拒（notOwner、不发请求）；小窗带着别页的对话按续接规则在本页问', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    const { conversationId } = await otherPageConversation(h);
    const panel = await readyPanel(h, TAB);
    const n = h.fetches.length;
    panel.send(askMsg({ clientRequestId: rid(), selectionRevision: undefined, conversationId }));
    await until(() => panel.ofType('conv/rejected').length === 1);
    expect(panel.ofType('conv/rejected')[0]).toMatchObject({ reason: 'notOwner', refType: 'conv/ask' });
    expect(h.fetches).toHaveLength(n);

    const r = await answered(h, float, { conversationId });
    expect(r.conversationId).not.toBe(conversationId);
    expect(h.db.tables.conversations.get(r.conversationId)?.pageKey).toBe(PAGE);
    expect(JSON.stringify(bodyMessages(h, n))).not.toContain('别页的回答');
  });

  it('同一页的两个标签页共用该页的对话（对话属于页面）', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    const a = await answered(h, float);
    h.moveTab(8, WIN);
    const panel = await readyPanel(h, 8);
    expect(panel.ofType('conv/subscribed').at(-1)).toMatchObject({
      tabId: 8,
      conversationId: a.conversationId,
    });
  });
});

describe('历史（C5、5.11）', () => {
  it('按更新时间降序分页（before 游标、nextBefore）；按页面筛；按文字搜标题与消息正文；小窗不能查', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      h.advance(MIN);
      ids.push(
        (await answered(h, float, { fresh: true, text: `标题${i}` }, i === 1 ? '独特的回答' : '答'))
          .conversationId,
      );
    }
    h.moveTab(8, WIN);
    h.setTabUrl(OTHER_PAGE, 8);
    const panel = await readyPanel(h, 8);
    const other = (await answered(h, panel, { text: '别页标题' })).conversationId;

    const query = async (q: Record<string, unknown>) => {
      const queryId = rid();
      panel.send({ type: 'history/query', queryId, limit: 2, ...q });
      await until(() => panel.ofType('history/page').some((m) => m.queryId === queryId && m.done), '历史');
      const pages = panel.ofType('history/page').filter((m) => m.queryId === queryId);
      return {
        ids: pages.flatMap((m) => (m.items as { id: string }[]).map((x) => x.id)),
        next: pages.at(-1)?.nextBefore as number | undefined,
      };
    };
    const p1 = await query({});
    expect(p1.ids).toEqual([other, ids[4]]);
    const p2 = await query({ before: p1.next });
    expect(p2.ids).toEqual([ids[3], ids[2]]);
    const p3 = await query({ before: p2.next, limit: 10 });
    expect(p3.ids).toEqual([ids[1], ids[0]]);
    expect(p3.next).toBeUndefined();
    expect((await query({ pageKey: PAGE, limit: 10 })).ids).toEqual([...ids].reverse());
    expect((await query({ text: '标题3' })).ids).toEqual([ids[3]]);
    expect((await query({ text: '独特', limit: 10 })).ids).toEqual([ids[1]]);
    expect((await query({ text: '没有这个词', limit: 10 })).ids).toEqual([]);

    float.send({ type: 'history/query', queryId: rid(), limit: 1 });
    await until(() => float.ofType('conv/rejected').length === 1);
    expect(float.ofType('conv/rejected')[0]).toMatchObject({ reason: 'notAllowed' });
  });

  it('删除对话：级联删消息与无人引用的快照，被引用的快照留着；生成中拒绝（busy）；之后不再续接它', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    const a = await answered(h, float);
    const snap = (id: string, refCount: number) => ({
      id,
      conversationId: a.conversationId,
      pageKey: PAGE,
      blocks: [{ id: 'b1', text: '正文' }],
      refCount,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    h.db.tables.snapshots.set('snap-free-001', snap('snap-free-001', 0));
    h.db.tables.snapshots.set('snap-kept-001', snap('snap-kept-001', 1));
    const panel = await readyPanel(h);

    // 生成中删除：拒绝
    float.send(
      askMsg({ clientRequestId: rid(), selectionRevision: undefined, conversationId: a.conversationId }),
    );
    await until(() => h.fetches.length === 2);
    panel.send({ type: 'history/delete', requestId: 'del-00000001', conversationId: a.conversationId });
    await until(() => panel.ofType('conv/rejected').length === 1);
    expect(panel.ofType('conv/rejected')[0]).toMatchObject({ reason: 'busy', refId: 'del-00000001' });
    h.fetches[1]?.res.push('T:答\nF\n');
    h.fetches[1]?.res.close();
    await until(() => states(float).filter((s) => s === 'completed').length === 2);

    panel.send({ type: 'history/delete', requestId: 'del-00000002', conversationId: a.conversationId });
    await until(() => panel.ofType('history/deleted').length === 1);
    expect(panel.ofType('history/deleted')[0]).toEqual({
      type: 'history/deleted',
      requestId: 'del-00000002',
      conversationId: a.conversationId,
    });
    expect(h.db.tables.conversations.has(a.conversationId)).toBe(false);
    expect(dbMessages(h, a.conversationId)).toEqual([]);
    expect(h.db.tables.snapshots.has('snap-free-001')).toBe(false);
    expect(h.db.tables.snapshots.has('snap-kept-001')).toBe(true);
    // 删掉后再问：开新对话
    const b = await answered(h, float);
    expect(b.conversationId).not.toBe(a.conversationId);
  });
});

// ── 页面读取（与 page-read.test.ts 同样的阅读器应答） ──

function report(texts: string[], title = '测试文章'): PageDocReport {
  const blocks: BlockReport[] = texts.map((text, i) => ({
    id: `b${i + 1}`,
    kind: i === 0 ? 'heading' : 'paragraph',
    ...(i === 0 ? { level: 1 } : {}),
    text,
    headingPath: i === 0 ? [] : [texts[0] as string],
  }));
  return {
    contentVersion: contentVersionOf(title, blocks),
    title,
    blocks,
    notes: [],
    textLength: texts.reduce((n, t) => n + [...t].length, 0),
    extractedAt: 1,
  };
}
const PARAS = ['测试文章', '第二段。', `第三段：${SELECTED}`, '第四段。'];

async function readPage(h: Harness, n: number, doc: PageDocReport) {
  await until(() => h.sent.filter((s) => s.msg.type === 'page/read').length >= n, 'page/read');
  const read = h.sent.filter((s) => s.msg.type === 'page/read')[n - 1];
  const readId = (read?.msg as unknown as { readId: string } | undefined)?.readId ?? '';
  const parts = splitByJsonBytes(JSON.stringify(doc), 4000);
  for (const [index, data] of parts.entries())
    await h.message(
      { type: 'page/docPart', readId, index, total: parts.length, data },
      h.contentSender(0, TOP_DOC),
    );
}

describe('页面记录与快照（5.11）', () => {
  it('带了页面块的请求写快照（实际发送的块与文本，7 天到期）与页面记录；站点改为「不读取」后该站快照删掉、发送全文去掉页面片段', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    const doc = report(PARAS);
    c.send(askMsg({ contextTier: 'fullPage' }));
    await readPage(h, 1, doc);
    await until(() => h.fetches.length === 1);
    const plan = c.ofType('conv/plan')[0] as { contextSnapshotId: string };
    await h.app.history.search({ limit: 1 });
    const snap = h.db.tables.snapshots.get(plan.contextSnapshotId);
    expect(snap).toMatchObject({
      conversationId: accepted(c)[0]?.conversationId,
      pageKey: PAGE,
      contentVersion: doc.contentVersion,
      refCount: 0,
      expiresAt: 1_000_000 + 7 * 24 * 3600 * 1000,
    });
    expect(snap?.blocks).toEqual(doc.blocks.map((b) => ({ id: b.id, text: b.text })));
    expect(h.db.tables.pages.get(PAGE)).toMatchObject({ host: 'example.test', url: PAGE, title: '测试文章' });

    // nearby：前后段落进了用户消息的实际发送全文
    h.fetches[0]?.res.push('T:答\nF\n');
    h.fetches[0]?.res.close();
    await until(() => states(c).includes('completed'));
    await h.message(click(2));
    c.send(askMsg({ clientRequestId: rid(), selectionRevision: 2, contextTier: 'nearby' }));
    await readPage(h, 2, doc);
    await until(() => h.fetches.length === 2);
    await h.app.history.search({ limit: 1 });
    const sentTexts = () =>
      [...h.db.tables.messages.values()].flatMap((m) => (m.sentText === undefined ? [] : [m.sentText]));
    expect(sentTexts().some((t) => t.includes('<page_content>'))).toBe(true);
    expect(h.db.tables.snapshots.size).toBe(2);

    h.setSettings({ ...SETTINGS, sites: [{ host: 'example.test', level: 'noRead' }] });
    h.app.onSettingsChanged(true);
    await until(() => h.db.tables.snapshots.size === 0, '快照删掉');
    await until(() => !sentTexts().some((t) => t.includes('<page_content>')), '旧正文去掉');
    // 显示用的问题与选区不动
    expect(sentTexts().every((t) => t.includes(SELECTED))).toBe(true);
  });

  it('「总结本页」完成：PageRecord.lastSummary 记下消息与内容版本，按 pageKey 读得到上次总结', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const doc = report(PARAS);
    c.send(
      askMsg({
        actionId: 'summarizePage',
        text: '总结本页',
        selectionRevision: undefined,
        contextTier: 'fullPage',
      }),
    );
    await readPage(h, 1, doc);
    await until(() => h.fetches.length === 1);
    expect(await h.app.history.lastSummary(PAGE)).toBeUndefined();
    h.fetches[0]?.res.push('T:这页讲了光合作用。\nF\n');
    h.fetches[0]?.res.close();
    await until(() => states(c).includes('completed'));
    const last = await h.app.history.lastSummary(PAGE);
    expect(last).toMatchObject({
      contentVersion: doc.contentVersion,
      message: {
        id: accepted(c)[0]?.messageId,
        status: 'completed',
        segments: [{ kind: 'text', text: '这页讲了光合作用。' }],
      },
    });
    expect(h.db.tables.pages.get(PAGE)?.lastSummary).toEqual({
      messageId: accepted(c)[0]?.messageId,
      contentVersion: doc.contentVersion,
    });
  });
});
