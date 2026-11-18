import { describe, expect, it } from 'vitest';
import { TOKEN_PATTERN, TOKEN_TTL_MS } from '@/core/domain/float';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import {
  click,
  EXT_ID,
  FLOAT_DOC,
  fakeSession,
  makeHarness,
  readyFloat,
  SELECTED,
  selectionReady,
  TAB,
  TOP_DOC,
  until,
} from './harness';

const tokenKeys = (data: Map<string, unknown>) => [...data.keys()].filter((k) => k.startsWith('token:'));

describe('selection/ready：注入阅读器并预热小窗', () => {
  it('同一文档只注入一次、只预热一次；令牌内存与 storage.session 各一份', async () => {
    const h = makeHarness();
    const [a, b] = await Promise.all([h.message(selectionReady(1)), h.message(selectionReady(2))]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    await h.message(selectionReady(3), h.contentSender(2, 'doc-sub'));
    expect(h.injected).toEqual([TOP_DOC]);
    const prewarms = h.sent.filter((s) => s.msg.type === 'float/prewarm');
    expect(prewarms).toHaveLength(1);
    const p = prewarms[0];
    expect(p).toMatchObject({ tabId: TAB, frameId: 0, documentId: TOP_DOC });
    expect(p?.msg.token).toMatch(TOKEN_PATTERN);
    expect(h.session.data.get(SESSION_KEYS.token(p?.msg.token ?? ''))).toMatchObject({
      tabId: TAB,
      documentId: TOP_DOC,
    });
  });

  it('宿主导航后（顶层文档变了）重新注入并换新令牌预热', async () => {
    const h = makeHarness();
    await h.message(selectionReady());
    h.navigate('doc-top-2');
    await h.message(selectionReady(), h.contentSender(0, 'doc-top-2'));
    expect(h.injected).toEqual([TOP_DOC, 'doc-top-2']);
    const prewarms = h.sent.filter((s) => s.msg.type === 'float/prewarm');
    expect(prewarms.map((s) => s.documentId)).toEqual([TOP_DOC, 'doc-top-2']);
  });
});

describe('action/click', () => {
  it('只接「问」：其他动作拒绝，不存选区、不发指令', async () => {
    const h = makeHarness();
    const before = h.session.data.size;
    expect(await h.message(click(1, 'explain'))).toEqual({ ok: false, reason: 'notAllowed' });
    expect(h.session.data.size).toBe(before);
    expect(h.sent).toHaveLength(0);
  });

  it('未知字段、别的扩展、扩展页面发来的意图一律拒绝且无副作用', async () => {
    const h = makeHarness();
    await h.app.ready;
    const before = [...h.session.data.keys()];
    expect(await h.message({ ...click(), url: 'https://evil.test/' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await h.message(click(), { ...h.contentSender(), id: 'other-ext' })).toMatchObject({
      ok: false,
      reason: 'notAllowed',
    });
    expect(await h.message(click(), h.floatSender())).toMatchObject({ ok: false, reason: 'notAllowed' });
    expect([...h.session.data.keys()]).toEqual(before);
    expect(h.sent).toHaveLength(0);
    expect(h.deps.injectReader).not.toHaveBeenCalled();
  });

  it('按 sender 存选区；预热过的直接显示，不带令牌', async () => {
    const h = makeHarness();
    await h.message(selectionReady());
    expect(await h.message(click(), h.contentSender(2, 'doc-sub'))).toEqual({ ok: true });
    expect(h.session.data.get(SESSION_KEYS.selection(TAB))).toMatchObject({
      frameId: 2,
      documentId: 'doc-sub',
      selectionRevision: 1,
      text: SELECTED,
    });
    const show = h.sent.filter((s) => s.msg.type === 'float/show');
    expect(show).toHaveLength(1);
    expect(show[0]?.msg).toEqual({ type: 'float/show', focusInput: true });
  });

  it('没预热过（点得很快）：等注入完成，带新令牌现建', async () => {
    const h = makeHarness();
    expect(await h.message(click())).toEqual({ ok: true });
    expect(h.injected).toEqual([TOP_DOC]);
    const show = h.sent.find((s) => s.msg.type === 'float/show');
    expect(show?.msg.token).toMatch(TOKEN_PATTERN);
    expect(tokenKeys(h.session.data)).toEqual([SESSION_KEYS.token(show?.msg.token ?? '')]);
  });

  it('预热令牌过期且小窗没握手：显示时换新令牌', async () => {
    const h = makeHarness();
    await h.message(selectionReady());
    h.advance(TOKEN_TTL_MS + 1);
    await h.message(click());
    expect(h.sent.find((s) => s.msg.type === 'float/show')?.msg.token).toMatch(TOKEN_PATTERN);
  });

  it('小窗已订阅：推 conv/quote，预览最多 2000 字', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const long = '字'.repeat(2500);
    await h.message(click(5, 'ask', long));
    const q = c.ofType('conv/quote').at(-1);
    expect(q).toMatchObject({ selectionRevision: 5, truncated: true, originalLength: 2500 });
    expect([...String(q?.text)].length).toBe(2000);
  });
});

describe('对话端口握手', () => {
  it('握手前的其他消息回 notHandshaken；不合法消息回 invalid', async () => {
    const h = makeHarness();
    const c = h.connect();
    c.send({ type: 'conv/subscribe' });
    c.send({ type: 'conv/helloFloat', token: 'short' });
    await until(() => c.received.length === 2);
    expect(c.received).toEqual([
      { type: 'conv/rejected', reason: 'notHandshaken', refType: 'conv/subscribe' },
      { type: 'conv/rejected', reason: 'invalid', refType: 'conv/helloFloat' },
    ]);
  });

  it('网页（内容脚本）连对话端口：拒绝并断开', () => {
    const h = makeHarness();
    const c = h.connect(h.contentSender());
    expect(c.received).toEqual([{ type: 'conv/rejected', reason: 'notAllowed' }]);
  });

  it('helloFloat：令牌一次性，写绑定，回 conv/ready', async () => {
    const h = makeHarness();
    await h.message(selectionReady());
    const token = h.sent[0]?.msg.token;
    const a = h.connect();
    const b = h.connect(h.floatSender('doc-float-2'));
    a.send({ type: 'conv/helloFloat', token });
    b.send({ type: 'conv/helloFloat', token });
    await until(() => a.received.length === 1 && b.received.length === 1);
    expect(a.received[0]).toEqual({ type: 'conv/ready', role: 'float', protocolVersion: 1 });
    expect(b.received[0]).toMatchObject({ type: 'conv/rejected', reason: 'badToken' });
    expect(h.session.data.get(SESSION_KEYS.floatBinding(TAB))).toMatchObject({
      tabId: TAB,
      frameId: 3,
      floatDocumentId: FLOAT_DOC,
      hostDocumentId: TOP_DOC,
    });
    expect(tokenKeys(h.session.data)).toEqual([]);
    // V-05 诊断：记下 sender 的地址与来源，但不含令牌
    const seen = h.logs.find((l) => l.event === 'float/sender');
    expect(seen?.detail).toMatchObject({ url: 'chrome-extension://0f1e2d3c-dynamic-id/float.html' });
    expect(JSON.stringify(h.logs)).not.toContain(String(token));
  });

  it('令牌绑定的标签页不对、已过期：badToken，不写绑定', async () => {
    const h = makeHarness();
    await h.message(selectionReady());
    const token = h.sent[0]?.msg.token;
    const other = h.connect(h.floatSender(FLOAT_DOC, TAB + 1));
    other.send({ type: 'conv/helloFloat', token });
    await until(() => other.received.length === 1);
    expect(other.received[0]).toMatchObject({ reason: 'badToken' });

    // 预热的小窗令牌过期后，点击现建换新令牌；新令牌也过期后再握手
    h.advance(TOKEN_TTL_MS + 1);
    await h.message(click());
    const fresh = h.sent.find((s) => s.msg.type === 'float/show')?.msg.token;
    expect(fresh).toMatch(TOKEN_PATTERN);
    h.advance(TOKEN_TTL_MS + 1);
    const late = h.connect();
    late.send({ type: 'conv/helloFloat', token: fresh });
    await until(() => late.received.length === 1);
    expect(late.received[0]).toMatchObject({ reason: 'badToken' });
    expect(h.session.data.has(SESSION_KEYS.floatBinding(TAB))).toBe(false);
  });

  it('后台重启后：内存为空时 helloFloat 回退 storage.session；resumeFloat 按绑定恢复', async () => {
    const session = fakeSession();
    const h1 = makeHarness({ session });
    await h1.message(selectionReady());
    const token = h1.sent[0]?.msg.token;

    const h2 = makeHarness({ session });
    const c = h2.connect();
    c.send({ type: 'conv/helloFloat', token });
    await until(() => c.received.length === 1);
    expect(c.received[0]).toMatchObject({ type: 'conv/ready' });

    const h3 = makeHarness({ session });
    const again = h3.connect();
    again.send({ type: 'conv/resumeFloat' });
    const wrong = h3.connect(h3.floatSender('doc-float-reloaded'));
    wrong.send({ type: 'conv/resumeFloat' });
    await until(() => again.received.length === 1 && wrong.received.length === 1);
    expect(again.received[0]).toEqual({ type: 'conv/ready', role: 'float', protocolVersion: 1 });
    expect(wrong.received[0]).toMatchObject({ type: 'conv/rejected', reason: 'badToken' });
  });

  it('subscribe：先推当前选区，最后回快照（snapshot 是初始推送推完的标志）', async () => {
    const h = makeHarness();
    await h.message(selectionReady());
    await h.message(click());
    const token = h.sent[0]?.msg.token;
    const c = h.connect();
    c.send({ type: 'conv/helloFloat', token });
    c.send({ type: 'conv/subscribe', tabId: TAB + 1 });
    c.send({ type: 'conv/subscribe' });
    await until(() => c.received.length === 4);
    expect(c.received.slice(1)).toEqual([
      { type: 'conv/rejected', reason: 'notOwner', refType: 'conv/subscribe' },
      { type: 'conv/quote', selectionRevision: 1, text: SELECTED, truncated: false, originalLength: 13 },
      { type: 'conv/snapshot', messages: [], done: true, conversationRevision: 0 },
    ]);
  });

  it('身份只取 sender：令牌与 sender.id 都要对', async () => {
    const h = makeHarness();
    await h.message(selectionReady());
    const c = h.connect({ ...h.floatSender(), id: `${EXT_ID}x` });
    expect(c.received).toEqual([{ type: 'conv/rejected', reason: 'notAllowed' }]);
  });
});
