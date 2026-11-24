import { describe, expect, it } from 'vitest';
import type { JobRecord } from '@/core/domain/job';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import {
  askMsg,
  click,
  FLOAT_DOC,
  fakeSession,
  MODEL,
  makeHarness,
  readyFloat,
  SECRET_KEY,
  SELECTED,
  TAB,
  until,
} from './harness';

const states = (c: { ofType: (t: string) => Record<string, unknown>[] }) =>
  c.ofType('conv/jobState').map((m) => m.state);

async function asked(h: ReturnType<typeof makeHarness>) {
  const c = await readyFloat(h);
  await h.message(click());
  c.send(askMsg());
  await until(() => h.fetches.length === 1, 'fetch');
  return { c, call: h.fetches[0] as (typeof h.fetches)[number] };
}

describe('conv/ask', () => {
  it('选区修订号对不上：拒绝，不发请求、不写任务', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click(2));
    c.send(askMsg({ selectionRevision: 1 }));
    await until(() => c.ofType('conv/rejected').length === 1);
    expect(c.ofType('conv/rejected')[0]).toEqual({
      type: 'conv/rejected',
      reason: 'invalid',
      refType: 'conv/ask',
      refId: 'req-00000001',
    });
    expect(h.fetches).toHaveLength(0);
    expect([...h.session.data.keys()].some((k) => k.startsWith('job:'))).toBe(false);
  });

  it('model 指向的连接已不存在（被删了）：拒绝 modelGone，不再静默退回默认模型（J10、V-07）', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ model: { connectionId: 'conn-deleted', model: 'ghost-model' } }));
    await until(() => c.ofType('conv/rejected').length === 1);
    expect(c.ofType('conv/rejected')[0]).toEqual({
      type: 'conv/rejected',
      reason: 'modelGone',
      refType: 'conv/ask',
      refId: 'req-00000001',
    });
    expect(h.fetches).toHaveLength(0);
  });

  it('没有选区也没有问题：「问」拒绝；不需要输入的动作（总结本页）照常接单', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    c.send(askMsg({ selectionRevision: undefined, text: '' }));
    await until(() => c.ofType('conv/rejected').length === 1);
    expect(c.ofType('conv/rejected')[0]).toMatchObject({ reason: 'invalid' });
    expect(h.fetches).toHaveLength(0);
    c.send(
      askMsg({
        clientRequestId: 'req-00000002',
        selectionRevision: undefined,
        text: '',
        actionId: 'summarizePage',
      }),
    );
    await until(() => h.fetches.length === 1, 'fetch');
    expect(c.ofType('conv/accepted')).toHaveLength(1);
  });

  it('先写 storage.session 再发请求；接单、计划、增量（seq 递增）、完成', async () => {
    const h = makeHarness();
    const { c, call } = await asked(h);
    // fetch 发出时热副本已在
    expect(call.jobsAtCall).toEqual([
      expect.objectContaining({ state: expect.stringMatching(/accepted|streaming/) }),
    ]);
    const accepted = c.ofType('conv/accepted')[0];
    expect(accepted).toMatchObject({ clientRequestId: 'req-00000001' });
    const plan = c.ofType('conv/plan')[0];
    expect(plan).toMatchObject({
      jobId: accepted?.jobId,
      plan: { pageRead: false, sentBlockIds: [], selectionTruncated: false, model: { model: 'mock-flash' } },
    });
    // 请求里带着选中的文字与问题，模型名正确，地址来自登记的连接
    expect(call.url).toBe('https://relay.test/v1/chat/completions');
    const body = JSON.parse(String(call.init.body));
    expect(body.model).toBe('mock-flash');
    expect(body.thinking).toBe('off');
    expect(JSON.stringify(body.messages)).toContain(SELECTED);
    expect(JSON.stringify(body.messages)).toContain('这句话什么意思？');

    call.res.push('R:先想\nT:这是\n');
    await until(() => c.ofType('conv/delta').length >= 1, '第一批增量');
    call.res.push('T:回答。\nF\n');
    call.res.close();
    await until(() => states(c).includes('completed'), '完成');
    const deltas = c.ofType('conv/delta');
    const seqs = deltas.map((d) => d.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(deltas.map((d) => d.text ?? '').join('')).toBe('这是回答。');
    expect(deltas.map((d) => d.reasoning ?? '').join('')).toBe('先想');
    expect(states(c)).toEqual(['streaming', 'completed']);
    // 终态写进热副本，且晚于所有增量推送
    const rec = h.session.data.get(SESSION_KEYS.job(String(accepted?.jobId))) as JobRecord;
    expect(rec).toMatchObject({ state: 'completed', requestSent: true, workerEpoch: h.app.epoch });
    const lastDelta = c.received.lastIndexOf(deltas.at(-1) as Record<string, unknown>);
    expect(c.received.findIndex((m) => m.state === 'completed')).toBeGreaterThan(lastDelta);
  });

  it('思考强度发送前按模型支持的档位就近取档：计划、消息记录与请求体是同一个值（决策 100、规则 8）', async () => {
    const cases = [
      // 旧设置里的「中」/ 不经界面的入口：DeepSeek 没有「中」，取「高」
      { model: 'deepseek-flash', asked: 'medium', sent: { effort: 'high' } },
      // 「最高」在支持它的模型上原样发出
      { model: 'deepseek-flash', asked: 'max', sent: { effort: 'max' } },
      // 其他模型没有「最高」：取「高」
      { model: 'mock-flash', asked: 'max', sent: { effort: 'high' } },
      // 不支持思考的模型：强制关
      { model: 'deepseek-chat', asked: 'high', sent: 'off' },
    ] as const;
    for (const t of cases) {
      const h = makeHarness();
      const c = await readyFloat(h);
      await h.message(click());
      c.send(askMsg({ model: { connectionId: MODEL.connectionId, model: t.model }, thinking: t.asked }));
      await until(() => h.fetches.length === 1, 'fetch');
      const body = JSON.parse(String((h.fetches[0] as { init: RequestInit }).init.body));
      expect(body.thinking, `${t.model} ${t.asked}`).toEqual(t.sent);
      const planThinking = (c.ofType('conv/plan')[0] as unknown as { plan: { thinking: string } }).plan
        .thinking;
      expect(planThinking, `${t.model} ${t.asked} 计划`).toBe(
        typeof t.sent === 'string' ? t.sent : t.sent.effort,
      );
    }
  });

  it('同一个 clientRequestId 只接单一次', async () => {
    const h = makeHarness();
    const { c } = await asked(h);
    c.send(askMsg());
    await until(() => c.ofType('conv/accepted').length === 2);
    const [a, b] = c.ofType('conv/accepted');
    expect(b?.jobId).toBe(a?.jobId);
    expect(h.fetches).toHaveLength(1);
  });

  it('停止：先落定 stopped 再中止请求，之后到达的内容被忽略', async () => {
    const h = makeHarness();
    const { c, call } = await asked(h);
    call.res.push('T:一半\n');
    await until(() => c.ofType('conv/delta').length === 1);
    const jobId = c.ofType('conv/accepted')[0]?.jobId;
    c.send({ type: 'conv/stop', jobId });
    await until(() => states(c).includes('stopped'));
    expect(call.init.signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(states(c)).toEqual(['streaming', 'stopped']);
    expect(h.session.data.get(SESSION_KEYS.job(String(jobId)))).toMatchObject({
      state: 'stopped',
      stopReason: 'user',
    });
  });

  it('响应头错误：failed，错误信息脱敏（不含 Key）', async () => {
    const h = makeHarness({ status: 401 });
    const { c, call } = await asked(h);
    call.res.push(`{"error":{"message":"bad key ${SECRET_KEY} Bearer abc.def"}}`);
    call.res.close();
    await until(() => states(c).includes('failed'));
    const st = c.ofType('conv/jobState').at(-1);
    expect(st).toMatchObject({ state: 'failed', error: { kind: 'auth' } });
    const message = String((st?.error as { message?: string } | undefined)?.message);
    expect(message).not.toContain(SECRET_KEY);
    expect(message).not.toContain('abc.def');
    expect(message).toContain('401');
  });

  it('流中错误：保留已推送内容，任务 failed；网络中断：streamBroken', async () => {
    const h = makeHarness();
    const { c, call } = await asked(h);
    call.res.push('T:前半\nE:upstream overloaded\nT:不该出现\n');
    await until(() => states(c).includes('failed'));
    expect(
      c
        .ofType('conv/delta')
        .map((d) => d.text)
        .join(''),
    ).toBe('前半');
    expect(c.ofType('conv/jobState').at(-1)).toMatchObject({ error: { kind: 'server' } });

    const h2 = makeHarness();
    const r2 = await asked(h2);
    r2.call.res.push('T:前半\n');
    await until(() => r2.c.ofType('conv/delta').length === 1);
    r2.call.res.fail();
    await until(() => states(r2.c).includes('failed'));
    expect(r2.c.ofType('conv/jobState').at(-1)).toMatchObject({ error: { kind: 'streamBroken' } });
  });

  it('正常结束但没有正文：failed（noContent）', async () => {
    const h = makeHarness();
    const { c, call } = await asked(h);
    call.res.push('R:只想不说\nF\n');
    call.res.close();
    await until(() => states(c).includes('failed'));
    expect(c.ofType('conv/jobState').at(-1)).toMatchObject({ error: { kind: 'noContent' } });
  });

  it('断线重连：subscribe 带 resume 补发 seq > lastSeq 的增量与当前状态', async () => {
    const h = makeHarness();
    const { c, call } = await asked(h);
    call.res.push('T:一\n');
    await until(() => c.ofType('conv/delta').length === 1);
    call.res.push('T:二\nF\n');
    call.res.close();
    await until(() => states(c).includes('completed'));
    const jobId = c.ofType('conv/accepted')[0]?.jobId;
    const first = c.ofType('conv/delta')[0]?.seq as number;

    c.close();
    const again = h.connect();
    again.send({ type: 'conv/resumeFloat' });
    again.send({ type: 'conv/subscribe', resume: { jobId, lastSeq: first } });
    await until(() => again.ofType('conv/jobState').length === 1);
    expect(again.ofType('conv/delta').map((d) => d.text)).toEqual(['二']);
    expect(again.ofType('conv/delta').every((d) => (d.seq as number) > first)).toBe(true);
    expect(again.ofType('conv/jobState')[0]).toMatchObject({ jobId, state: 'completed' });
  });

  it('启动扫描：上个后台进程留下的未终结任务标 interrupted；去重表随之恢复', async () => {
    const session = fakeSession();
    const old: JobRecord = {
      jobId: 'job-old-0001',
      clientRequestId: 'req-old-0001',
      conversationId: 'conv-old-0001',
      messageId: 'msg-old-0001',
      attemptId: 'att-old-0001',
      attempt: 1,
      workerEpoch: 'epoch-previous',
      revision: 0,
      state: 'streaming',
      requestSent: true,
      acceptedAt: 1,
      updatedAt: 1,
    };
    await session.set({ [SESSION_KEYS.job(old.jobId)]: old });
    const h = makeHarness({ session });
    await h.app.ready;
    expect(session.data.get(SESSION_KEYS.job(old.jobId))).toMatchObject({
      state: 'interrupted',
      interruptReason: 'workerRestarted',
    });
    expect(session.data.get(SESSION_KEYS.workerEpoch)).toBe(h.app.epoch);

    // 重连后用旧任务编号订阅：报 interrupted；同一个 clientRequestId 再来不重发请求
    await session.set({
      [SESSION_KEYS.floatBinding(TAB)]: {
        tabId: TAB,
        frameId: 3,
        floatDocumentId: 'doc-float-1',
        hostDocumentId: 'doc-top-1',
        boundAt: 1,
      },
    });
    const c = h.connect();
    c.send({ type: 'conv/resumeFloat' });
    c.send({ type: 'conv/subscribe', resume: { jobId: old.jobId, lastSeq: 3 } });
    c.send(askMsg({ clientRequestId: old.clientRequestId, selectionRevision: undefined }));
    await until(() => c.ofType('conv/accepted').length === 1);
    expect(c.ofType('conv/jobState')[0]).toMatchObject({ jobId: old.jobId, state: 'interrupted' });
    expect(c.ofType('conv/accepted')[0]).toMatchObject({ jobId: old.jobId });
    expect(h.fetches).toHaveLength(0);
  });

  it('后台重启后接着问：选区从 storage.session 取，对话从库里重建，请求带上上一轮', async () => {
    const session = fakeSession();
    const h1 = makeHarness({ session });
    const { c, call } = await asked(h1);
    call.res.push('T:答\nF\n');
    call.res.close();
    await until(() => states(c).includes('completed'));
    const conversationId = c.ofType('conv/accepted')[0]?.conversationId;

    const h2 = makeHarness({ session, db: h1.db });
    const again = h2.connect();
    again.send({ type: 'conv/resumeFloat' });
    again.send(askMsg({ clientRequestId: 'req-00000002', conversationId }));
    await until(() => h2.fetches.length === 1, '第二次请求');
    expect(again.ofType('conv/accepted')[0]).toMatchObject({ conversationId });
    const messages = JSON.parse(String(h2.fetches[0]?.init.body)).messages as { role: string }[];
    // 系统、上一轮（问、答）、本轮
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.stringify(messages[2])).toContain('答');
    expect(JSON.stringify(messages[1])).toContain(SELECTED);
  });

  it('等响应头超时（V-01）：failed(timeout)，没有收到任何内容', async () => {
    const h = makeHarness({ hangForever: true, askConnectTimeoutMs: 20 });
    const { c, call } = await asked(h);
    await until(() => states(c).includes('failed'));
    expect(c.ofType('conv/jobState').at(-1)).toMatchObject({ state: 'failed', error: { kind: 'timeout' } });
    expect(call.init.signal?.aborted).toBe(true);
  });

  it('响应头已到达后不再受连接超时限制：body 迟迟不来不算超时', async () => {
    const h = makeHarness({ askConnectTimeoutMs: 20 });
    const { c } = await asked(h); // 默认的假 fetch 立即给响应头，之后迟迟不推正文
    await new Promise((r) => setTimeout(r, 60));
    expect(states(c)).toEqual(['streaming']); // 没有被连接超时打成 failed
  });

  it('两个界面同一对话几乎同时发问：只接一单，不会两边都发出网络请求（V-03）', async () => {
    const h = makeHarness();
    const c1 = await readyFloat(h);
    // c1 先问一轮并让它完成，拿到 conversationId
    c1.send(askMsg({ clientRequestId: 'req-first', selectionRevision: undefined, text: '第一问' }));
    await until(() => h.fetches.length === 1);
    h.fetches[0]?.res.push('T:答一\nF\n');
    h.fetches[0]?.res.close();
    await until(() => c1.ofType('conv/jobState').some((s) => s.state === 'completed'));
    const conversationId = c1.ofType('conv/accepted')[0]?.conversationId as string;

    // 同一标签页的第二个连接：resumeFloat 不消费令牌，复用 c1 已经建好的绑定即可握手，
    // 模拟「本版本虽只有小窗，但协议层已经有两个并发连接」的情形（产品层的双 UI 待侧边栏接入）
    const c2 = h.connect(h.floatSender());
    c2.send({ type: 'conv/resumeFloat' });
    await until(() => c2.ofType('conv/ready').length === 1);
    c2.send({ type: 'conv/subscribe' });
    await until(() => c2.ofType('conv/snapshot').length === 1);

    // 几乎同时各发一条到同一个对话：中间除了 `await ready`（已 resolve）外不该再有能插队的 await
    c1.send(
      askMsg({
        clientRequestId: 'req-bbbbbbbb',
        conversationId,
        selectionRevision: undefined,
        text: 'c1 问',
      }),
    );
    c2.send(
      askMsg({
        clientRequestId: 'req-cccccccc',
        conversationId,
        selectionRevision: undefined,
        text: 'c2 问',
      }),
    );

    const settled = (c: typeof c1, id: string) =>
      c.ofType('conv/accepted').some((a) => a.clientRequestId === id) ||
      c.ofType('conv/rejected').some((r) => r.refId === id);
    await until(() => settled(c1, 'req-bbbbbbbb') && settled(c2, 'req-cccccccc'));

    // 只接了一单：加上第一问，总共只应该发出 2 次网络请求，不是 3 次
    expect(h.fetches).toHaveLength(2);
    const rejected = [...c1.ofType('conv/rejected'), ...c2.ofType('conv/rejected')];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: 'busy' });
  });
});

describe('conv/retry（V-03）', () => {
  it('失败后重试：新 attemptId，不发新 clientRequestId，旧内容不与新内容拼接', async () => {
    const h = makeHarness();
    const { c, call } = await asked(h);
    call.res.fail();
    await until(() => states(c).includes('failed'));
    const jobId = c.ofType('conv/accepted')[0]?.jobId as string;
    const attemptBefore = c.ofType('conv/jobState').at(-1)?.attemptId;

    c.send({ type: 'conv/retry', jobId });
    await until(() => h.fetches.length === 2, '重试发出新请求');
    const retryState = c.ofType('conv/jobState').find((s) => s.jobId === jobId && s.state === 'accepted');
    expect(retryState?.attemptId).not.toBe(attemptBefore);
    expect(c.ofType('conv/accepted')).toHaveLength(1); // 不是新发问，没有新的 conv/accepted

    h.fetches[1]?.res.push('T:重试后的答案\nF\n');
    h.fetches[1]?.res.close();
    await until(() => states(c).filter((s) => s === 'completed').length === 1);
    // 第二次请求同样带着选中的文字（重试不重新装配，原样重发）
    expect(JSON.stringify(JSON.parse(String(h.fetches[1]?.init.body)).messages)).toContain(SELECTED);
  });

  it('新选区不改变在途请求：失败后产生了新选区，重试仍发送原始选区（V-03）', async () => {
    const h = makeHarness();
    const { c, call } = await asked(h);
    call.res.fail();
    await until(() => states(c).includes('failed'));
    const jobId = c.ofType('conv/accepted')[0]?.jobId as string;

    // 在重试之前，页面上出现了一次新的划词（新 selectionRevision，不同的文字）
    const NEW_SELECTED = '这是另一段完全不同的新选区文字。';
    await h.message(click(2, 'ask', NEW_SELECTED));

    c.send({ type: 'conv/retry', jobId });
    await until(() => h.fetches.length === 2, '重试发出新请求');
    const retryBody = JSON.stringify(JSON.parse(String(h.fetches[1]?.init.body)).messages);
    expect(retryBody).toContain(SELECTED); // 仍是原来那次发问时的选区
    expect(retryBody).not.toContain(NEW_SELECTED); // 不是新选区
  });

  it('停止后也能重试；还在生成中时重试被拒绝（notAllowed）', async () => {
    const h = makeHarness();
    const { c, call } = await asked(h);
    call.res.push('T:一半\n');
    await until(() => c.ofType('conv/delta').length === 1);
    const jobId = c.ofType('conv/accepted')[0]?.jobId as string;

    c.send({ type: 'conv/retry', jobId }); // 还在 streaming，不可重试
    await until(() => c.ofType('conv/rejected').length === 1);
    expect(c.ofType('conv/rejected')[0]).toMatchObject({ reason: 'notAllowed', refId: jobId });

    c.send({ type: 'conv/stop', jobId });
    await until(() => states(c).includes('stopped'));
    c.send({ type: 'conv/retry', jobId });
    await until(() => h.fetches.length === 2);
    expect(c.ofType('conv/rejected')).toHaveLength(1); // 还是只有刚才那一次拒绝，重试这次没被拒
  });

  it('不是任务所属标签页：拒绝（notOwner）', async () => {
    const h = makeHarness();
    const { c, call } = await asked(h);
    call.res.fail();
    await until(() => states(c).includes('failed'));
    const jobId = c.ofType('conv/accepted')[0]?.jobId as string;

    // 另一个标签页的小窗（直接灌绑定做 resumeFloat 握手，不必走一遍选区/预热）
    await h.session.set({
      [SESSION_KEYS.floatBinding(TAB + 1)]: {
        tabId: TAB + 1,
        frameId: 3,
        floatDocumentId: FLOAT_DOC,
        hostDocumentId: 'doc-top-other',
        boundAt: 1,
      },
    });
    const other = h.connect(h.floatSender(FLOAT_DOC, TAB + 1));
    other.send({ type: 'conv/resumeFloat' });
    await until(() => other.ofType('conv/ready').length === 1);

    other.send({ type: 'conv/retry', jobId });
    await until(() => other.ofType('conv/rejected').length === 1);
    expect(other.ofType('conv/rejected')[0]).toMatchObject({ reason: 'notOwner' });
  });
});
