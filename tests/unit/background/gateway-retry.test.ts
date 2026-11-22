// 参数自动重试（H7）+ 怪癖学习（AR-09，V-07 未执行项）+ 用量（J9）的端到端行为。
// fakeAdapter（harness.ts）本身不识别 paramRejected，所以这里包一层记录 excludeParams 的假适配器，
// 配合自定义 fetch 模拟「第一次因为 thinking 参数被拒、去掉后重试成功」。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ChatRequest, Connection } from '@/core/llm/adapter';
import { askMsg, click, fakeAdapter, makeHarness, readyFloat, until } from './harness';

/** 包一层 fakeAdapter：classifyHead 认得 400→paramRejected；buildChat 记录每次收到的 excludeParams */
function trackingAdapter(calls: Array<readonly string[]>) {
  return {
    ...fakeAdapter,
    buildChat: (conn: Connection, req: ChatRequest, opts?: { excludeParams?: readonly string[] }) => {
      calls.push(opts?.excludeParams ?? []);
      return fakeAdapter.buildChat(conn, req);
    },
    classifyHead: ({ status, bodyHead }: { status: number; bodyHead: string }) => {
      if (status === 200) return undefined;
      if (status === 400)
        return { kind: 'paramRejected' as const, status, suspectParam: 'thinking', serverMessage: bodyHead };
      return { kind: 'auth' as const, status };
    },
  };
}

/** 第一次调用返回 400（thinking 参数被拒）；之后一律成功 */
function rejectOnceFetch() {
  let n = 0;
  return vi.fn(async () => {
    n++;
    if (n === 1) {
      return new Response('{"error":{"message":"param not supported","param":"thinking"}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('T:好的\nF\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

/** 一律成功 */
function okFetch() {
  return vi.fn(
    async () =>
      new Response('T:好的\nF\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
}

const completedStates = (c: { ofType: (t: string) => Record<string, unknown>[] }) =>
  c.ofType('conv/jobState').filter((m) => m.state === 'completed');

describe('参数自动重试 + 怪癖学习', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('首次 400（认出参数）且未收到内容：去掉参数重试一次，成功后 completed 并带上去掉的参数', async () => {
    const h = makeHarness();
    const calls: Array<readonly string[]> = [];
    h.deps.adapters.chatCompletions = trackingAdapter(calls);
    const fetchMock = rejectOnceFetch();
    h.deps.fetch = fetchMock;

    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg());
    await until(() => fetchMock.mock.calls.length === 2, '重试发生');
    await until(() => completedStates(c).length === 1, '完成');

    expect(calls[0]).toEqual([]);
    expect(calls[1]).toEqual(['thinking']);
    expect(completedStates(c).at(-1)).toMatchObject({
      state: 'completed',
      droppedParam: { param: 'thinking', semantic: true },
    });
  });

  it('学到的怪癖对下一次同连接同模型请求生效：预先就不发了，不用再经历一次 400', async () => {
    const h = makeHarness();
    const calls: Array<readonly string[]> = [];
    h.deps.adapters.chatCompletions = trackingAdapter(calls);
    const fetchMock1 = rejectOnceFetch();
    h.deps.fetch = fetchMock1;

    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg());
    await until(() => fetchMock1.mock.calls.length === 2);
    await until(() => completedStates(c).length === 1);

    // 第二次发问（新 clientRequestId，同一个连接 + 模型）：怪癖已经学到
    const fetchMock2 = okFetch();
    h.deps.fetch = fetchMock2;
    c.send(askMsg({ clientRequestId: 'req-00000002' }));
    await until(() => completedStates(c).length === 2, '第二次完成');

    expect(fetchMock2.mock.calls.length).toBe(1); // 一次就成功，不再触发 400
    expect(calls.at(-1)).toEqual(['thinking']); // 第二轮从一开始就带着学到的怪癖
  });

  it('用量：流里带的 usage 挂到终态消息上；没给就没有这个字段', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg());
    await until(() => h.fetches.length === 1);
    const call = h.fetches[0] as { res: { push(s: string): void; close(): void } };
    call.res.push('T:回答\nF\n');
    call.res.close();
    await until(() => completedStates(c).length === 1);
    expect(completedStates(c).at(-1)?.usage).toBeUndefined(); // fakeAdapter 不产出 usage 事件，没给就没有
  });
});
