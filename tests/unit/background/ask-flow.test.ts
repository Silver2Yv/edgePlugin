import { describe, expect, it } from 'vitest';
import type { JobRecord } from '@/core/domain/job';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import {
  askMsg,
  click,
  fakeSession,
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

  it('后台重启后接着问：选区从 storage.session 取，对话编号按新对话接手', async () => {
    const session = fakeSession();
    const h1 = makeHarness({ session });
    const { c, call } = await asked(h1);
    call.res.push('T:答\nF\n');
    call.res.close();
    await until(() => states(c).includes('completed'));
    const conversationId = c.ofType('conv/accepted')[0]?.conversationId;

    const h2 = makeHarness({ session });
    const again = h2.connect();
    again.send({ type: 'conv/resumeFloat' });
    again.send(askMsg({ clientRequestId: 'req-00000002', conversationId }));
    await until(() => h2.fetches.length === 1, '第二次请求');
    expect(again.ofType('conv/accepted')[0]).toMatchObject({ conversationId });
    expect(JSON.stringify(JSON.parse(String(h2.fetches[0]?.init.body)).messages)).toContain(SELECTED);
  });
});
