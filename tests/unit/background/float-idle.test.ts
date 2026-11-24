// 小窗空闲销毁（决策 078/101，contract-v1.6 增量 float/destroyed）：后台收到「iframe 已销毁」的通知后，
// 作废这个文档的小窗绑定与令牌，之后所有显示入口按「没有小窗」走（带新令牌现建），对话从后台恢复；
// 生成中的任务不受影响（规则 2）。身份取自 sender（规则 7）。计时本身在页面侧，见 tests/unit/page/float-idle.test.ts。
import { describe, expect, it } from 'vitest';
import { TOKEN_PATTERN } from '@/core/domain/float';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import {
  askMsg,
  click,
  FLOAT_DOC,
  type Harness,
  makeHarness,
  readyFloat,
  selectionReady,
  TAB,
  TOP_DOC,
  until,
} from './harness';

const destroyed = { type: 'float/destroyed' };
const NEW_FLOAT_DOC = 'doc-float-2';

const shows = (h: Harness) => h.sent.filter((s) => s.msg.type === 'float/show');
const prewarms = (h: Harness) => h.sent.filter((s) => s.msg.type === 'float/prewarm');
const tokenKeys = (h: Harness) => [...h.session.data.keys()].filter((k) => k.startsWith('token:'));
const bindingOf = (h: Harness) => h.session.data.get(SESSION_KEYS.floatBinding(TAB));

/** 新建的小窗用新令牌握手并订阅，返回已订阅的端口 */
async function reopenFloat(h: Harness, token: string) {
  const c = h.connect(h.floatSender(NEW_FLOAT_DOC));
  c.send({ type: 'conv/helloFloat', token });
  await until(() => c.ofType('conv/ready').length === 1, '新小窗握手');
  c.send({ type: 'conv/subscribe' });
  await until(() => c.ofType('conv/snapshot').length >= 1, '新小窗订阅');
  return c;
}

describe('float/destroyed：作废绑定与令牌', () => {
  it('握手过的小窗销毁：绑定删除、就绪状态回到 unknown；旧小窗文档再 resumeFloat 被拒', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    expect(bindingOf(h)).toMatchObject({ tabId: TAB, hostDocumentId: TOP_DOC, floatDocumentId: FLOAT_DOC });
    await h.message({ type: 'float/loadResult', result: 'ready' });
    expect(h.session.data.get(SESSION_KEYS.float(TAB))).toBe('ready');

    c.close();
    expect(await h.message(destroyed)).toEqual({ ok: true });
    expect(bindingOf(h)).toBeUndefined();
    expect(h.session.data.get(SESSION_KEYS.float(TAB))).toBe('unknown');

    const stale = h.connect(h.floatSender());
    stale.send({ type: 'conv/resumeFloat' });
    await until(() => stale.ofType('conv/rejected').length === 1);
    expect(stale.ofType('conv/rejected')[0]).toMatchObject({ reason: 'badToken' });
  });

  it('预热后从未显示就销毁：没消费的令牌作废，之后拿它握手被拒', async () => {
    const h = makeHarness();
    await h.message(selectionReady());
    const old = prewarms(h)[0]?.msg.token as string;
    expect(tokenKeys(h)).toEqual([SESSION_KEYS.token(old)]);

    expect(await h.message(destroyed)).toEqual({ ok: true });
    expect(tokenKeys(h)).toEqual([]);

    const c = h.connect(h.floatSender());
    c.send({ type: 'conv/helloFloat', token: old });
    await until(() => c.ofType('conv/rejected').length === 1);
    expect(c.ofType('conv/rejected')[0]).toMatchObject({ reason: 'badToken' });
    expect(bindingOf(h)).toBeUndefined();
  });

  it('只作废这个标签页、这个文档的令牌，别的标签页的不动', async () => {
    const h = makeHarness();
    await h.message(selectionReady());
    const other = {
      token: 'e'.repeat(32),
      tabId: TAB + 1,
      documentId: TOP_DOC,
      expiresAt: 9_999_999_999,
    };
    await h.session.set({ [SESSION_KEYS.token(other.token)]: other });
    await h.message(destroyed);
    expect(tokenKeys(h)).toEqual([SESSION_KEYS.token(other.token)]);
  });

  it('后台重启后（内存是空的）：令牌与绑定只在 storage.session 里，照样作废', async () => {
    const h1 = makeHarness();
    await readyFloat(h1);
    await h1.message(click()); // 让 h1 的 storage.session 里有选区等其他状态
    const h2 = makeHarness({ session: h1.session, db: h1.db });
    await h2.app.ready;
    // 预热令牌（未消费）也留着：模拟另一个文档状态之前已被消费，这里单独放一个
    const leftover = { token: 'c'.repeat(32), tabId: TAB, documentId: TOP_DOC, expiresAt: 9_999_999_999 };
    await h2.session.set({ [SESSION_KEYS.token(leftover.token)]: leftover });

    expect(await h2.message(destroyed)).toEqual({ ok: true });
    expect(bindingOf(h2)).toBeUndefined();
    expect(tokenKeys(h2)).toEqual([]);
  });
});

describe('销毁之后的显示：按「没有小窗」走', () => {
  it('点「问」：带新令牌现建，新小窗握手并订阅成功', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    expect(shows(h)).toHaveLength(1);
    expect(shows(h)[0]?.msg.token).toBeUndefined(); // 已有小窗：不带令牌

    c.close();
    h.advance(10 * 60_000); // 收起满 10 分钟，老令牌早已过期
    await h.message(destroyed);

    await h.message(click(2));
    expect(shows(h)).toHaveLength(2);
    const token = shows(h)[1]?.msg.token as string;
    expect(token).toMatch(TOKEN_PATTERN);
    const c2 = await reopenFloat(h, token);
    expect(c2.ofType('conv/ready')).toHaveLength(1);
    expect(bindingOf(h)).toMatchObject({ floatDocumentId: NEW_FLOAT_DOC });
    // 令牌一次性
    expect(tokenKeys(h)).toEqual([]);
  });

  it('快捷键、再次预热等别的入口也一样：不再以为有小窗', async () => {
    const h = makeHarness();
    await readyFloat(h);
    h.advance(10 * 60_000);
    await h.message(destroyed);
    // 工具栏再次出现 → 预热：带新令牌重新建隐藏小窗
    await h.message(selectionReady(2));
    expect(prewarms(h)).toHaveLength(2);
    expect(prewarms(h)[1]?.msg.token).toMatch(TOKEN_PATTERN);
    // 直接显示（快捷键走同一个 host.show）：已有刚预热的、令牌未过期的小窗，不再换令牌
    await h.message(click());
    expect(shows(h)[0]?.msg.token).toBeUndefined();
  });

  it('对话从后台恢复：销毁前已答完的对话，新小窗订阅就是同一个对话与完整消息', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg());
    await until(() => h.fetches.length === 1, 'fetch');
    h.fetches[0]?.res.push('T:光合作用\nF\n');
    h.fetches[0]?.res.close();
    await until(() => c.ofType('conv/jobState').some((m) => m.state === 'completed'), '完成');
    const conversationId = c.ofType('conv/accepted')[0]?.conversationId;

    c.close();
    h.advance(10 * 60_000);
    await h.message(destroyed);
    await h.message(click(2));
    const c2 = await reopenFloat(h, shows(h).at(-1)?.msg.token as string);
    expect(c2.ofType('conv/subscribed')[0]).toMatchObject({ conversationId });
    const snap = c2.ofType('conv/snapshot').at(-1) as { messages: { role: string; status: string }[] };
    expect(snap.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'completed'],
      ['assistant', 'completed'],
    ]);
  });

  it('生成中销毁：任务照常跑完（只发过一次请求），新小窗订阅看到完整回答', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg());
    await until(() => h.fetches.length === 1, 'fetch');
    h.fetches[0]?.res.push('T:前半段，\n');
    await until(() => c.ofType('conv/delta').length >= 1, '第一段');

    // 收起、到点销毁：iframe 没了，端口断开，后台收到通知
    c.close();
    h.advance(10 * 60_000);
    expect(await h.message(destroyed)).toEqual({ ok: true });
    expect(h.fetches[0]?.init.signal?.aborted).toBe(false);

    h.fetches[0]?.res.push('T:后半段。\nF\n');
    h.fetches[0]?.res.close();
    await until(
      () => [...h.session.data.values()].some((v) => (v as { state?: string }).state === 'completed'),
      '任务完成',
    );

    await h.message(click(2));
    const c2 = await reopenFloat(h, shows(h).at(-1)?.msg.token as string);
    const snap = c2.ofType('conv/snapshot').at(-1) as {
      messages: { role: string; status: string; text?: string }[];
      done: boolean;
    };
    const answer = snap.messages.find((m) => m.role === 'assistant');
    expect(answer?.status).toBe('completed');
    expect(JSON.stringify(answer)).toContain('前半段，后半段。');
    expect(h.fetches).toHaveLength(1);
  });

  it('生成中销毁后马上打开新小窗：新订阅接上还在流的任务，后面的增量照常收到', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg());
    await until(() => h.fetches.length === 1, 'fetch');
    h.fetches[0]?.res.push('T:前半段，\n');
    await until(() => c.ofType('conv/delta').length >= 1, '第一段');

    c.close();
    h.advance(10 * 60_000);
    await h.message(destroyed);
    await h.message(click(2));
    const c2 = await reopenFloat(h, shows(h).at(-1)?.msg.token as string);

    h.fetches[0]?.res.push('T:后半段。\nF\n');
    h.fetches[0]?.res.close();
    await until(() => c2.ofType('conv/jobState').some((m) => m.state === 'completed'), '新小窗看到完成');
    expect(h.fetches).toHaveLength(1);
  });
});

describe('撞上销毁：用户点「问」与到点销毁几乎同时', () => {
  const missed = { type: 'float/destroyed', missed: true };

  it('无令牌的显示落了空：先收到销毁通知、再收到 missed，补发一次带新令牌的显示', async () => {
    const h = makeHarness();
    await readyFloat(h);
    await h.message(click());
    expect(shows(h)).toHaveLength(1);
    expect(shows(h)[0]?.msg.token).toBeUndefined();

    // 页面销毁在先（后台发显示时还不知道），收到显示发现没有小窗，再报一次 missed
    await h.message(destroyed);
    expect(shows(h)).toHaveLength(1); // 销毁通知本身不补发
    expect(await h.message(missed)).toEqual({ ok: true });
    expect(shows(h)).toHaveLength(2);
    const token = shows(h)[1]?.msg.token as string;
    expect(token).toMatch(TOKEN_PATTERN);
    // 补发的令牌能让新小窗握手
    const c2 = await reopenFloat(h, token);
    expect(c2.ofType('conv/ready')).toHaveLength(1);
  });

  it('missed 到时后台已经有新小窗了（用户连点、别的入口已补发）：不再补发，也不清理新小窗的绑定与令牌', async () => {
    const h = makeHarness();
    await readyFloat(h);
    await h.message(click());
    await h.message(destroyed);
    await h.message(click(2)); // 另一次点击：已按没有小窗走，带新令牌
    expect(shows(h)).toHaveLength(2);
    const token = shows(h)[1]?.msg.token as string;

    await h.message(missed); // 前一次落空的显示迟到的报告
    expect(shows(h)).toHaveLength(2);
    expect(tokenKeys(h)).toEqual([SESSION_KEYS.token(token)]);
    await reopenFloat(h, token);
  });

  it('连报两次 missed：只补发一次', async () => {
    const h = makeHarness();
    await readyFloat(h);
    await h.message(click());
    await h.message(destroyed);
    await h.message(missed);
    await h.message(missed);
    expect(shows(h)).toHaveLength(2);
  });

  it('missed 也要过身份核对：子框架、对不上的文档拒绝，且不补发', async () => {
    const h = makeHarness();
    await readyFloat(h);
    await h.message(click());
    await h.message(destroyed);
    expect(await h.message(missed, h.contentSender(2, 'doc-sub'))).toMatchObject({ ok: false });
    expect(await h.message(missed, h.contentSender(0, 'doc-evil'))).toMatchObject({ ok: false });
    expect(shows(h)).toHaveLength(1);
  });
});

describe('float/destroyed：伪造的 sender 被拒，没有副作用', () => {
  async function armed() {
    const h = makeHarness();
    await readyFloat(h);
    const before = {
      keys: [...h.session.data.keys()].sort(),
      sent: h.sent.length,
      binding: structuredClone(bindingOf(h)),
    };
    const unchanged = () => {
      expect([...h.session.data.keys()].sort()).toEqual(before.keys);
      expect(bindingOf(h)).toEqual(before.binding);
      expect(h.sent).toHaveLength(before.sent);
    };
    return { h, unchanged };
  }

  it('子框架（frameId ≠ 0）发来：拒绝', async () => {
    const { h, unchanged } = await armed();
    expect(await h.message(destroyed, h.contentSender(2, 'doc-sub'))).toMatchObject({
      ok: false,
      reason: 'notOwner',
    });
    unchanged();
  });

  it('顶层框架但文档对不上已知的当前顶层文档：拒绝', async () => {
    const { h, unchanged } = await armed();
    expect(await h.message(destroyed, h.contentSender(0, 'doc-evil'))).toMatchObject({
      ok: false,
      reason: 'notOwner',
    });
    unchanged();
  });

  it('sender 没有 documentId：拒绝', async () => {
    const { h, unchanged } = await armed();
    const { documentId: _drop, ...noDoc } = h.contentSender();
    expect(await h.message(destroyed, noDoc)).toMatchObject({ ok: false, reason: 'notOwner' });
    unchanged();
  });

  it('小窗、侧边栏、设置页、别的扩展发来：拒绝', async () => {
    const { h, unchanged } = await armed();
    expect(await h.message(destroyed, h.floatSender())).toMatchObject({ ok: false, reason: 'notAllowed' });
    expect(await h.message(destroyed, h.panelSender())).toMatchObject({ ok: false, reason: 'notAllowed' });
    expect(await h.message(destroyed, h.optionsSender())).toMatchObject({ ok: false, reason: 'notAllowed' });
    expect(await h.message(destroyed, { ...h.contentSender(), id: 'other-ext' })).toMatchObject({
      ok: false,
      reason: 'notAllowed',
    });
    unchanged();
  });

  it('带多余字段（想塞别的标签页、文档）：拒绝，身份只取自 sender', async () => {
    const { h, unchanged } = await armed();
    expect(await h.message({ ...destroyed, tabId: 99, documentId: 'doc-evil' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    unchanged();
  });

  it('别的标签页发来只作用于它自己：不影响这个标签页的绑定', async () => {
    const { h, unchanged } = await armed();
    // 那个标签页没有已知文档、没有小窗与令牌：通知无事可做，这个标签页的状态原样
    expect(await h.message(destroyed, { ...h.contentSender(), tab: { id: TAB + 5 } })).toEqual({ ok: true });
    unchanged();
  });
});
