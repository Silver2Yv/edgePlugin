// 侧边栏（5.4、5.12）、转接（6.4）、降级路由（5.2）、快捷键与右键（5.1、6.2）的后台逻辑。
import { describe, expect, it } from 'vitest';
import { contentVersionOf } from '@/core/context/content-version';
import { HANDOFF_TTL_MS } from '@/core/domain/float';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import {
  askMsg,
  click,
  type Harness,
  makeHarness,
  readyFloat,
  SELECTED,
  SETTINGS,
  selectionReady,
  TAB,
  until,
  WIN,
} from './harness';

type Conn = ReturnType<Harness['connect']>;

const states = (c: Conn) => c.ofType('conv/jobState').map((m) => m.state);

/** 侧边栏握手（窗口 WIN），可选订阅某标签页 */
async function readyPanel(h: Harness, opts: { tabId?: number; windowId?: number } = {}) {
  const c = h.connect(h.panelSender());
  c.send({ type: 'conv/helloSidepanel', windowId: opts.windowId ?? WIN });
  await until(() => c.ofType('conv/ready').length + c.ofType('conv/rejected').length > 0, '侧边栏握手');
  if (opts.tabId !== undefined) await subscribe(c, opts.tabId);
  return c;
}

async function subscribe(c: Conn, tabId: number, extra: Record<string, unknown> = {}) {
  const before = c.ofType('conv/snapshot').length + c.ofType('conv/rejected').length;
  c.send({ type: 'conv/subscribe', tabId, ...extra });
  await until(() => c.ofType('conv/snapshot').length + c.ofType('conv/rejected').length > before, '订阅');
}

/** 小窗问一轮并答完，返回对话编号 */
async function floatAnswered(h: Harness, float: Conn, answer = '答一') {
  const n = h.fetches.length;
  float.send(askMsg({ clientRequestId: `req-${n}-aaaaaaaa`, selectionRevision: undefined, text: `问${n}` }));
  await until(() => h.fetches.length === n + 1, 'fetch');
  h.fetches[n]?.res.push(`T:${answer}\nF\n`);
  h.fetches[n]?.res.close();
  await until(() => states(float).filter((s) => s === 'completed').length > 0, '完成');
  return float.ofType('conv/accepted').at(-1)?.conversationId as string;
}

const tabSender = (h: Harness, windowId = WIN) => ({ ...h.contentSender(), tab: { id: TAB, windowId } });

describe('侧边栏握手与授权（5.12）', () => {
  it('没报窗口拒绝；窗口不存在拒绝；能反查且对不上拒绝；对上才就绪', async () => {
    const h = makeHarness();
    const a = h.connect(h.panelSender());
    a.send({ type: 'conv/helloSidepanel' });
    await until(() => a.received.length === 1);
    expect(a.received[0]).toMatchObject({ type: 'conv/rejected', reason: 'invalid' });

    const b = h.connect(h.panelSender());
    b.send({ type: 'conv/helloSidepanel', windowId: 99 });
    await until(() => b.received.length === 1);
    expect(b.received[0]).toMatchObject({ type: 'conv/rejected', reason: 'notOwner' });

    // 将来浏览器能按 documentId 反查窗口时以反查为准
    h.addWindow(2);
    h.deps.panelWindowOf = async () => 2;
    const c = h.connect(h.panelSender('doc-panel-1'));
    c.send({ type: 'conv/helloSidepanel', windowId: WIN });
    await until(() => c.received.length === 1);
    expect(c.received[0]).toMatchObject({ type: 'conv/rejected', reason: 'notOwner' });

    const d = await readyPanel(h);
    expect(d.ofType('conv/ready')[0]).toMatchObject({ role: 'sidepanel' });
    expect(h.logs.some((l) => l.event === 'sidepanel/hello' && l.detail?.windowFrom === 'hint')).toBe(true);
  });

  it('只能订阅本窗口的标签页；订阅不带标签页拒绝', async () => {
    const h = makeHarness();
    h.moveTab(8, 2);
    const c = await readyPanel(h);
    await subscribe(c, 8);
    expect(c.ofType('conv/rejected').at(-1)).toMatchObject({ reason: 'notOwner', refType: 'conv/subscribe' });
    c.send({ type: 'conv/subscribe' });
    await until(() => c.ofType('conv/rejected').length === 2);
    expect(c.ofType('conv/rejected').at(-1)).toMatchObject({ reason: 'invalid' });
    expect(c.ofType('conv/subscribed')).toHaveLength(0);
  });

  it('订阅：标记 → 引用 → 快照；发问用所订阅标签页存下的选区', async () => {
    const h = makeHarness();
    await h.message(selectionReady());
    await h.message(click());
    const c = await readyPanel(h, { tabId: TAB });
    expect(c.received.slice(1).map((m) => m.type)).toEqual([
      'conv/subscribed',
      'conv/quote',
      'conv/snapshot',
    ]);
    expect(c.ofType('conv/subscribed')[0]).toEqual({ type: 'conv/subscribed', tabId: TAB });
    c.send(askMsg());
    await until(() => h.fetches.length === 1, 'fetch');
    expect(JSON.stringify(JSON.parse(String(h.fetches[0]?.init.body)).messages)).toContain(SELECTED);
  });

  it('标签页被拖到别的窗口后：发问、停止、重试都拒绝，不发请求', async () => {
    const h = makeHarness();
    const c = await readyPanel(h, { tabId: TAB });
    c.send(askMsg({ selectionRevision: undefined }));
    await until(() => h.fetches.length === 1);
    const jobId = c.ofType('conv/accepted')[0]?.jobId as string;
    h.moveTab(TAB, 2);
    c.send(askMsg({ clientRequestId: 'req-00000002', selectionRevision: undefined }));
    c.send({ type: 'conv/stop', jobId });
    c.send({ type: 'conv/retry', jobId });
    await until(() => c.ofType('conv/rejected').length === 3);
    expect(c.ofType('conv/rejected').map((r) => r.reason)).toEqual(['notOwner', 'notOwner', 'notOwner']);
    expect(h.fetches).toHaveLength(1);
    expect(states(c)).not.toContain('stopped');
  });

  it('换订阅：旧标签页的推送随即停止', async () => {
    const h = makeHarness();
    h.moveTab(8, WIN);
    const float = await readyFloat(h);
    const c = await readyPanel(h, { tabId: TAB });
    await subscribe(c, 8);
    const n = c.received.length;
    float.send(askMsg({ selectionRevision: undefined }));
    await until(() => h.fetches.length === 1);
    h.fetches[0]?.res.push('T:答\nF\n');
    h.fetches[0]?.res.close();
    await until(() => states(float).includes('completed'));
    expect(c.received.slice(n)).toEqual([]);
  });
});

describe('两个界面显示同一个任务', () => {
  it('小窗发问：已订阅的侧边栏收到 conv/current，随后的增量两边都有', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    const panel = await readyPanel(h, { tabId: TAB });
    float.send(askMsg({ selectionRevision: undefined }));
    await until(() => h.fetches.length === 1);
    const acc = float.ofType('conv/accepted')[0];
    expect(panel.ofType('conv/current')[0]).toEqual({
      type: 'conv/current',
      conversationId: acc?.conversationId,
      jobId: acc?.jobId,
      messageId: acc?.messageId,
      // live（contract-v1.5）：带上这一轮的提问，供发问端口之外的订阅者显示
      userMessage: { id: expect.any(String), ordinal: expect.any(Number), text: '这句话什么意思？' },
    });
    h.fetches[0]?.res.push('T:一\nT:二\nF\n');
    h.fetches[0]?.res.close();
    await until(() => states(panel).includes('completed'));
    const text = (c: Conn) =>
      c
        .ofType('conv/delta')
        .map((d) => d.text ?? '')
        .join('');
    expect(text(panel)).toBe('一二');
    expect(text(float)).toBe('一二');
  });

  it('流式中途才订阅：从 0 补发，与之后的实时增量接上，不重不漏（6.4「无缝续上」）', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    float.send(askMsg({ selectionRevision: undefined }));
    await until(() => h.fetches.length === 1);
    const call = h.fetches[0] as (typeof h.fetches)[number];
    call.res.push('T:甲\n');
    await until(() => float.ofType('conv/delta').length === 1);
    call.res.push('T:乙\n');
    await until(() => float.ofType('conv/delta').length === 2);
    const panel = await readyPanel(h, { tabId: TAB });
    const sub = panel.ofType('conv/subscribed')[0];
    expect(sub?.job).toEqual({
      jobId: float.ofType('conv/accepted')[0]?.jobId,
      messageId: float.ofType('conv/accepted')[0]?.messageId,
    });
    // 补发：计划、两条增量、当前状态，都在快照之前
    const types = panel.received.map((m) => m.type);
    expect(types.indexOf('conv/plan')).toBeLessThan(types.indexOf('conv/delta'));
    expect(types.lastIndexOf('conv/delta')).toBeLessThan(types.indexOf('conv/snapshot'));
    call.res.push('T:丙\nF\n');
    call.res.close();
    await until(() => states(panel).includes('completed'));
    const seqs = panel.ofType('conv/delta').map((d) => d.seq as number);
    expect(seqs).toEqual([1, 2, 3]);
    expect(
      panel
        .ofType('conv/delta')
        .map((d) => d.text)
        .join(''),
    ).toBe('甲乙丙');
  });

  it('换了页面（pageKey 不同）：不指定对话的订阅不再接上旧页面的回答；指定对话的照常', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    const conversationId = await floatAnswered(h, float);
    h.setTabUrl('https://example.test/other');
    const panel = await readyPanel(h, { tabId: TAB });
    expect(panel.ofType('conv/subscribed')[0]).toEqual({ type: 'conv/subscribed', tabId: TAB });
    await subscribe(panel, TAB, { conversationId });
    expect(panel.ofType('conv/subscribed')[1]).toMatchObject({ conversationId, job: expect.any(Object) });
  });

  it('V-03：小窗与侧边栏同时向同一对话发问，只接一单', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    const conversationId = await floatAnswered(h, float);
    const panel = await readyPanel(h, { tabId: TAB });
    expect(panel.ofType('conv/subscribed')[0]).toMatchObject({ conversationId });
    float.send(askMsg({ clientRequestId: 'req-float-0002', conversationId, selectionRevision: undefined }));
    panel.send(askMsg({ clientRequestId: 'req-panel-0002', conversationId, selectionRevision: undefined }));
    const settled = (c: Conn, id: string) =>
      c.ofType('conv/accepted').some((a) => a.clientRequestId === id) ||
      c.ofType('conv/rejected').some((r) => r.refId === id);
    await until(() => settled(float, 'req-float-0002') && settled(panel, 'req-panel-0002'));
    const accepted = [...float.ofType('conv/accepted'), ...panel.ofType('conv/accepted')].filter((a) =>
      String(a.clientRequestId).endsWith('0002'),
    );
    const rejected = [...float.ofType('conv/rejected'), ...panel.ofType('conv/rejected')];
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: 'busy', refType: 'conv/ask' });
    await until(() => h.fetches.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.fetches).toHaveLength(2);
  });
});

describe('转到侧边栏（6.4、AR-19）', () => {
  it('转接全程：handoff/created → 侧边栏连上收到 pending → 带编号订阅 → 初始推送发完才通知小窗 done', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    const conversationId = await floatAnswered(h, float);
    float.send({ type: 'handoff/start', conversationId });
    await until(() => float.ofType('handoff/created').length === 1);
    const handoffId = float.ofType('handoff/created')[0]?.handoffId as string;
    expect(h.session.data.get(SESSION_KEYS.handoff(handoffId))).toMatchObject({
      windowId: WIN,
      tabId: TAB,
      conversationId,
    });
    const panel = await readyPanel(h);
    await until(() => panel.ofType('handoff/pending').length === 1);
    expect(panel.ofType('handoff/pending')[0]).toEqual({
      type: 'handoff/pending',
      handoffId,
      tabId: TAB,
      conversationId,
    });
    expect(float.ofType('handoff/done')).toHaveLength(0);
    await subscribe(panel, TAB, { conversationId, handoffId });
    await until(() => float.ofType('handoff/done').length === 1);
    // done 晚于侧边栏收到快照（订阅成功后才收起小窗）
    const panelSnapshotAt = panel.received.findIndex((m) => m.type === 'conv/snapshot');
    expect(panelSnapshotAt).toBeGreaterThan(-1);
    expect(panel.ofType('conv/delta').length).toBeGreaterThan(0);
    expect(h.session.data.has(SESSION_KEYS.handoff(handoffId))).toBe(false);
  });

  it('侧边栏先连上、转接后到：直接推 pending 给本窗口的侧边栏，别的窗口收不到', async () => {
    const h = makeHarness();
    h.addWindow(2);
    const float = await readyFloat(h);
    const mine = await readyPanel(h, { tabId: TAB });
    const other = await readyPanel(h, { windowId: 2 });
    float.send({ type: 'handoff/start' });
    await until(() => mine.ofType('handoff/pending').length === 1);
    expect(mine.ofType('handoff/pending')[0]).toMatchObject({ tabId: TAB });
    expect(mine.ofType('handoff/pending')[0]?.conversationId).toBeUndefined();
    expect(other.ofType('handoff/pending')).toHaveLength(0);
    // 同时广播叫醒本窗口断线闲着的侧边栏
    expect(h.pageMessages).toContainEqual({ type: 'sidepanel/wake', windowId: WIN });
  });

  it('过期、窗口不对、对话不对的转接：照常订阅，但不通知小窗收起', async () => {
    const h = makeHarness();
    h.moveTab(TAB, WIN);
    const float = await readyFloat(h);
    const conversationId = await floatAnswered(h, float);
    float.send({ type: 'handoff/start', conversationId });
    await until(() => float.ofType('handoff/created').length === 1);
    const handoffId = float.ofType('handoff/created')[0]?.handoffId as string;
    const panel = await readyPanel(h);
    await subscribe(panel, TAB, { handoffId, conversationId: 'conv-other-0001' });
    h.advance(HANDOFF_TTL_MS + 1);
    await subscribe(panel, TAB, { handoffId, conversationId });
    await new Promise((r) => setTimeout(r, 20));
    expect(float.ofType('handoff/done')).toHaveLength(0);
    expect(panel.ofType('conv/subscribed')).toHaveLength(2);
    expect(h.logs.filter((l) => l.event === 'handoff/invalid')).toHaveLength(2);
  });

  it('别的页面的对话不能转', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    // 另一个标签页上、另一个页面的对话
    h.moveTab(8, WIN);
    h.setTabUrl('https://other.test/page', 8);
    const panel = await readyPanel(h, { tabId: 8 });
    panel.send(askMsg({ clientRequestId: 'req-tab8-0001', selectionRevision: undefined }));
    await until(() => panel.ofType('conv/accepted').length === 1);
    const foreign = panel.ofType('conv/accepted')[0]?.conversationId as string;
    float.send({ type: 'handoff/start', conversationId: foreign });
    await until(() => float.ofType('conv/rejected').length === 1);
    expect(float.ofType('conv/rejected')[0]).toMatchObject({ reason: 'notOwner', refType: 'handoff/start' });
    expect([...h.session.data.keys()].some((k) => k.startsWith('handoff:'))).toBe(false);
  });

  it('后台重启后对话在库里：照常转，侧边栏的快照带上这段对话；对话被删了才不转（gone）', async () => {
    const h = makeHarness();
    const float = await readyFloat(h);
    const conversationId = await floatAnswered(h, float);
    const h2 = makeHarness({ session: h.session, db: h.db });
    const again = h2.connect(h2.floatSender());
    again.send({ type: 'conv/resumeFloat' });
    await until(() => again.ofType('conv/ready').length === 1);
    again.send({ type: 'conv/subscribe' });
    await until(() => again.ofType('conv/snapshot').length === 1, '小窗重新订阅');
    // 不指定对话的订阅按续接规则接上该页近期的对话（从库里来）
    expect(again.ofType('conv/subscribed')[0]).toMatchObject({ conversationId });
    again.send({ type: 'handoff/start', conversationId });
    await until(() => again.ofType('handoff/created').length === 1);
    const handoffId = again.ofType('handoff/created')[0]?.handoffId;
    const panel = await readyPanel(h2);
    await subscribe(panel, TAB, { handoffId, conversationId });
    await until(() => again.ofType('handoff/done').length === 1, '转接完成');
    const snap = panel.ofType('conv/snapshot').at(-1);
    expect(snap).toMatchObject({ done: true, conversation: { id: conversationId } });
    expect(((snap?.messages ?? []) as { role: string }[]).map((m) => m.role)).toEqual(['user', 'assistant']);

    // 侧边栏删掉这个对话后，小窗再转：gone，小窗留着回答
    panel.send({ type: 'history/delete', requestId: 'del-00000001', conversationId });
    await until(() => panel.ofType('history/deleted').length === 1, '删除');
    again.send({ type: 'handoff/start', conversationId });
    await until(() => again.ofType('conv/rejected').length === 1);
    expect(again.ofType('conv/rejected')[0]).toMatchObject({ reason: 'gone', refType: 'handoff/start' });
  });
});

describe('降级路由（5.2、6.3）', () => {
  it('小窗就绪或未知：走小窗，不开侧边栏', async () => {
    const h = makeHarness();
    await h.message(selectionReady(), tabSender(h));
    await h.message(click(), tabSender(h));
    expect(h.panel.opens).toEqual([]);
    expect(h.sent.some((s) => s.msg.type === 'float/show')).toBe(true);
  });

  it('偶发失败后点「问」：在同一个同步段里开侧边栏，选区存下，侧边栏订阅时带上引用与说明；下一次重新试小窗', async () => {
    const h = makeHarness();
    await h.message(selectionReady(), tabSender(h));
    await h.message({ type: 'float/loadResult', result: 'failedTransient' }, tabSender(h));
    const pending = h.message(click(), tabSender(h));
    // 还没 await 任何东西：open 已经发出（规则 10）
    expect(h.panel.opens).toEqual([WIN]);
    expect(await pending).toEqual({ ok: true });
    expect(h.sent.filter((s) => s.msg.type === 'float/show')).toHaveLength(0);
    expect(h.sent.filter((s) => s.msg.type === 'page/notice')).toHaveLength(0);
    expect(h.session.data.get(SESSION_KEYS.float(TAB))).toBe('unknown');
    const panel = await readyPanel(h, { tabId: TAB });
    expect(panel.received.slice(1).map((m) => m.type)).toEqual([
      'conv/subscribed',
      'conv/notice',
      'conv/quote',
      'conv/snapshot',
    ]);
    expect(panel.ofType('conv/notice')[0]).toEqual({ type: 'conv/notice', kind: 'floatTransient' });
    // 说明只给一次
    await subscribe(panel, TAB);
    expect(panel.ofType('conv/notice')).toHaveLength(1);
    // 用户关掉侧边栏后，下一次点「问」：重新试小窗（侧边栏开着时会留在侧边栏，见下一条）
    panel.close();
    await h.message(click(2), tabSender(h));
    expect(h.panel.opens).toEqual([WIN]);
    expect(h.sent.some((s) => s.msg.type === 'float/show')).toBe(true);
  });

  it('本窗口侧边栏开着时点「问」（工具栏、右键）：引用推给侧边栏，不开小窗、不提示原因、不用 open；别的窗口的侧边栏不算；「打开小窗」快捷键不跟', async () => {
    const h = makeHarness({ panelWakeMs: 50 });
    h.addWindow(2);
    await h.message(selectionReady(), tabSender(h));
    const other = await readyPanel(h, { windowId: 2 });
    h.panel.open = true;
    // 只有别的窗口开着侧边栏：叫醒本窗口的等不到，照常走小窗
    await h.message(click(1), tabSender(h));
    expect(h.sent.filter((s) => s.msg.type === 'float/show')).toHaveLength(1);
    other.close();

    const panel = await readyPanel(h, { tabId: TAB });
    expect(await h.message(click(2), tabSender(h))).toEqual({ ok: true });
    expect(h.panel.opens).toEqual([]);
    expect(h.sent.filter((s) => s.msg.type === 'float/show')).toHaveLength(1);
    expect(h.sent.filter((s) => s.msg.type === 'page/notice')).toHaveLength(0);
    expect(panel.ofType('conv/quote').at(-1)).toMatchObject({ selectionRevision: 2 });
    expect(panel.ofType('conv/notice')).toHaveLength(0);
    // 小窗的就绪状态不受影响
    expect(h.session.data.get(SESSION_KEYS.float(TAB))).toBeUndefined();

    // 右键「问」同样跟着侧边栏走
    h.app.onMenuClicked(
      { menuItemId: 'ask', selectionText: '右键选中的文字' },
      { id: TAB, windowId: WIN, url: 'https://example.test/article' },
    );
    await until(() => panel.ofType('conv/quote').some((m) => m.text === '右键选中的文字'));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.sent.filter((s) => s.msg.type === 'float/show')).toHaveLength(1);

    // 「打开小窗」快捷键不跟：明说了要小窗
    h.app.onCommand('open-float', { id: TAB, windowId: WIN, url: 'https://example.test/article' });
    await until(() => h.sent.filter((s) => s.msg.type === 'float/show').length === 2);
    expect(h.panel.opens).toEqual([]);
  });

  it('后台刚被唤醒、侧边栏开着但还没登记：划词时就叫醒它；点「问」等它握手后去侧边栏；一个侧边栏都没有时不广播、不等', async () => {
    const h = makeHarness();
    const wakes = () => h.pageMessages.filter((m) => (m as { type: string }).type === 'sidepanel/wake');
    await h.message(selectionReady(), tabSender(h));
    expect(wakes()).toHaveLength(0);
    await h.message(click(1), tabSender(h));
    expect(h.sent.filter((s) => s.msg.type === 'float/show')).toHaveLength(1);

    h.panel.open = true;
    await h.message(selectionReady(2), tabSender(h));
    await until(() => wakes().length === 1);
    expect(wakes()[0]).toEqual({ type: 'sidepanel/wake', windowId: WIN });
    // 点「问」先到、侧边栏后握手：等它
    const pending = h.message(click(2), tabSender(h));
    const panel = await readyPanel(h, { tabId: TAB });
    expect(await pending).toEqual({ ok: true });
    expect(h.sent.filter((s) => s.msg.type === 'float/show')).toHaveLength(1);
    expect(panel.ofType('conv/quote').at(-1)).toMatchObject({ selectionRevision: 2 });
    // 已登记：不再广播
    const n = wakes().length;
    await h.message(selectionReady(3), tabSender(h));
    await h.message(click(3), tabSender(h));
    expect(wakes()).toHaveLength(n);
  });

  it('浏览器没让打开侧边栏：在网页上提示（区分失败与不支持）', async () => {
    const h = makeHarness();
    h.panel.gesture = false;
    await h.message(selectionReady(), tabSender(h));
    await h.message({ type: 'float/loadResult', result: 'failedTransient' }, tabSender(h));
    await h.message(click(), tabSender(h));
    expect(h.sent.filter((s) => s.msg.type === 'page/notice').map((s) => s.msg)).toEqual([
      { type: 'page/notice', kind: 'floatFailed' },
    ]);
    await h.message({ type: 'float/loadResult', result: 'failedUnsupported' }, tabSender(h));
    await h.message(click(2), tabSender(h));
    expect(h.sent.filter((s) => s.msg.type === 'page/notice').at(-1)?.msg).toEqual({
      type: 'page/notice',
      kind: 'floatUnsupported',
    });
    // 结构性失败不因一次降级被清掉
    expect(h.session.data.get(SESSION_KEYS.float(TAB))).toBe('failedUnsupported');
  });

  it('页面侧配置的去向跟着就绪状态走', async () => {
    const h = makeHarness();
    expect(await h.message({ type: 'config/get' })).toMatchObject({ askRoute: 'float' });
    await h.message({ type: 'float/loadResult', result: 'failedTransient' });
    expect(await h.message({ type: 'config/get' })).toMatchObject({ askRoute: 'sidepanel' });
  });

  it('后台重启后：就绪状态从 storage.session 补回内存', async () => {
    const h = makeHarness();
    await h.message({ type: 'float/loadResult', result: 'failedUnsupported' });
    const h2 = makeHarness({ session: h.session });
    await h2.app.ready;
    await new Promise((r) => setTimeout(r, 0));
    expect(await h2.message({ type: 'config/get' })).toMatchObject({ askRoute: 'sidepanel' });
  });
});

describe('快捷键与右键（5.1、5.2、5.4、6.2）', () => {
  it('开关侧边栏：先同步 open，再记下命令时间并广播', async () => {
    const h = makeHarness();
    h.app.onCommand('toggle-sidepanel', { id: TAB, windowId: WIN });
    expect(h.panel.opens).toEqual([WIN]);
    await until(() => h.pageMessages.length === 1);
    expect(h.pageMessages[0]).toEqual({ type: 'sidepanel/toggle', windowId: WIN, at: 1_000_000 });
    expect(h.session.data.get(SESSION_KEYS.sidepanelToggle(WIN))).toBe(1_000_000);
  });

  it('没有手势时 open 失败也照常广播（已开着的面板据此关掉）', async () => {
    const h = makeHarness();
    h.panel.gesture = false;
    h.app.onCommand('toggle-sidepanel', { id: TAB, windowId: WIN });
    await until(() => h.pageMessages.length === 1);
    expect(h.logs.some((l) => l.event === 'sidepanel/openFailed')).toBe(true);
  });

  it('打开小窗（无选区）：网页上注入阅读器显示小窗；看不到地址的页面改开侧边栏，不提示小窗失败', async () => {
    const h = makeHarness();
    h.app.onCommand('open-float', { id: TAB, windowId: WIN, url: 'https://example.test/article' });
    await until(() => h.sent.some((s) => s.msg.type === 'float/show'));
    expect(h.panel.opens).toEqual([]);
    h.app.onCommand('open-float', { id: TAB, windowId: WIN });
    expect(h.panel.opens).toEqual([WIN]);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sent.filter((s) => s.msg.type === 'page/notice')).toHaveLength(0);
  });

  it('打开小窗：小窗失败过就同步开侧边栏', async () => {
    const h = makeHarness();
    await h.message({ type: 'float/loadResult', result: 'failedTransient' });
    h.app.onCommand('open-float', { id: TAB, windowId: WIN, url: 'https://example.test/article' });
    expect(h.panel.opens).toEqual([WIN]);
  });

  it('总结本页：同步开侧边栏，后台用固定问题发起整页请求；侧边栏订阅时接上这个任务', async () => {
    const h = makeHarness();
    h.app.onMenuClicked({ menuItemId: 'summarizePage' }, { id: TAB, windowId: WIN });
    expect(h.panel.opens).toEqual([WIN]);
    // 整页档位：后台让阅读器读页面；这里回一份正文
    await until(() => h.sent.some((s) => s.msg.type === 'page/read'), 'page/read');
    const read = h.sent.find((s) => s.msg.type === 'page/read')?.msg as unknown as { readId: string };
    const blocks = [{ id: 'b1', kind: 'paragraph' as const, text: '正文第一段。', headingPath: [] }];
    const doc = {
      contentVersion: contentVersionOf('测试文章', blocks),
      title: '测试文章',
      blocks,
      notes: [],
      textLength: 6,
      extractedAt: 1,
    };
    const data = JSON.stringify(doc);
    expect(await h.message({ type: 'page/docPart', readId: read.readId, index: 0, total: 1, data })).toEqual({
      ok: true,
    });
    await until(() => h.fetches.length === 1, '总结请求');
    const body = JSON.stringify(JSON.parse(String(h.fetches[0]?.init.body)).messages);
    expect(body).toContain('总结本页');
    expect(body).toContain('正文第一段。');
    expect(h.logs.find((l) => l.event === 'ask/plan')?.detail).toMatchObject({
      requestedTier: 'fullPage',
      pageRead: true,
    });
    h.fetches[0]?.res.push('T:要点\n');
    const panel = await readyPanel(h, { tabId: TAB });
    expect(panel.ofType('conv/subscribed')[0]?.job).toBeDefined();
    h.fetches[0]?.res.push('F\n');
    h.fetches[0]?.res.close();
    await until(() => states(panel).includes('completed'));
    expect(
      panel
        .ofType('conv/delta')
        .map((d) => d.text)
        .join(''),
    ).toBe('要点');
  });

  it('总结本页：没有连接时侧边栏顶部提示', async () => {
    const h = makeHarness();
    const { defaultModel: _unused, ...noModel } = SETTINGS;
    h.setSettings(noModel);
    const panel = await readyPanel(h, { tabId: TAB });
    h.app.onCommand('summarize-page', { id: TAB, windowId: WIN });
    await until(() => panel.ofType('conv/notice').length === 1);
    expect(panel.ofType('conv/notice')[0]).toEqual({ type: 'conv/notice', kind: 'noConnection' });
    expect(h.fetches).toHaveLength(0);
  });

  it('右键「问」：选中文字取自浏览器，存下并显示小窗；可编辑区域里的不读', async () => {
    const h = makeHarness();
    h.app.onMenuClicked(
      { menuItemId: 'ask', selectionText: '密码', editable: true },
      { id: TAB, windowId: WIN },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(h.session.data.has(SESSION_KEYS.selection(TAB))).toBe(false);
    h.app.onMenuClicked(
      { menuItemId: 'ask', selectionText: SELECTED, frameId: 0 },
      { id: TAB, windowId: WIN, url: 'https://example.test/article' },
    );
    await until(() => h.sent.some((s) => s.msg.type === 'float/show'));
    expect(h.session.data.get(SESSION_KEYS.selection(TAB))).toMatchObject({
      text: SELECTED,
      selectionRevision: 1_000_000,
      frameId: 0,
    });
    // 小窗（用 float/show 带来的令牌握手）发问，按这个修订号取选区
    const token = h.sent.find((s) => s.msg.type === 'float/show')?.msg.token;
    const float = h.connect();
    float.send({ type: 'conv/helloFloat', token });
    await until(() => float.ofType('conv/ready').length === 1, '小窗握手');
    float.send(askMsg({ selectionRevision: 1_000_000 }));
    await until(() => h.fetches.length === 1);
    expect(JSON.stringify(JSON.parse(String(h.fetches[0]?.init.body)).messages)).toContain(SELECTED);
  });
});
