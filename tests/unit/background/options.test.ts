// 设置页通道（5.8 测试连接、5.11 收紧存储）。网络相关场景（成功、html200 探测、401/404、超时、
// listModels）用模拟中转站拿真实字节流与真实适配器；角色拒绝与 ensureLocked 用 harness 的假依赖。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackgroundDeps } from '@/background/deps';
import { createOptions } from '@/background/options';
import { DEFAULT_SETTINGS } from '@/core/domain/settings';
import type { Connection } from '@/core/llm/adapter';
import { chatCompletionsAdapter } from '@/core/llm/chat-completions';
import { type MockRelay, startMockRelay } from '../../mock-relay/server';
import { EXT_ID, fakeSession, makeHarness } from './harness';

const CONN_ID = 'conn-test-0001';
const MODEL = 'mock-flash';

const connFixture = (baseUrl: string, overrides: Partial<Connection> = {}): Connection => ({
  id: CONN_ID,
  name: '测试连接',
  preset: 'custom',
  baseUrl,
  apiKey: 'test-key',
  headers: {},
  interfaceType: 'chatCompletions',
  stream: true,
  extraParams: {},
  configVersion: 1,
  ...overrides,
});

function makeDeps(overrides: Partial<BackgroundDeps> = {}): BackgroundDeps {
  return {
    self: { runtimeId: EXT_ID, protocol: 'chrome-extension:' },
    session: fakeSession(),
    loadSettings: async () => ({ ok: true, settings: structuredClone(DEFAULT_SETTINGS), migratedFrom: 1 }),
    injectReader: async () => 'doc',
    sendToFrame: async () => undefined,
    fetch: (url, init) => fetch(url, init),
    adapters: { chatCompletions: chatCompletionsAdapter },
    now: () => Date.now(),
    newId: () => `id-${Math.random().toString(36).slice(2, 10)}`,
    newToken: () => 'token',
    log: () => undefined,
    lockStorage: async () => undefined,
    openSidePanel: async () => undefined,
    tabWindow: async () => undefined,
    windowExists: async () => false,
    panelWindowOf: async () => undefined,
    sidePanelOpen: async () => false,
    notifyPages: async () => undefined,
    ...overrides,
  };
}

/** 设置里只有这一个连接，其余用 withConn 的第二个参数覆盖 deps（如超时） */
function withConn(conn: Connection, overrides: Partial<BackgroundDeps> = {}): BackgroundDeps {
  return makeDeps({
    loadSettings: async () => ({
      ok: true,
      settings: { ...structuredClone(DEFAULT_SETTINGS), connections: [conn] },
      migratedFrom: 1,
    }),
    ...overrides,
  });
}

const optionsSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/options.html` };

describe('设置页通道：connection/test、connection/listModels（模拟中转站）', () => {
  let relay: MockRelay;
  beforeAll(async () => {
    relay = await startMockRelay({ scale: 0.01 });
  });
  afterAll(() => relay.close());

  it('成功：收到首段正文就返回，reasoning 表示收到过思考', async () => {
    const deps = withConn(connFixture(`${relay.url}/v1`));
    const result = await createOptions(deps)(
      { type: 'connection/test', connectionId: CONN_ID, model: MODEL },
      optionsSender,
    );
    expect(result).toMatchObject({ ok: true, model: MODEL, reasoning: true });
    expect((result as { reply: string }).reply.length).toBeGreaterThan(0);
  });

  it('漏写 /v1（html200）：探测 /v1 成功给出 suggestedBaseUrl', async () => {
    const deps = withConn(connFixture(relay.url));
    const result = await createOptions(deps)(
      { type: 'connection/test', connectionId: CONN_ID, model: MODEL },
      optionsSender,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'htmlInsteadOfJson', status: 200 },
      suggestedBaseUrl: `${relay.url}/v1`,
    });
  });

  it('401 → auth', async () => {
    const deps = withConn(connFixture(`${relay.url}/m/401/v1`));
    const result = await createOptions(deps)(
      { type: 'connection/test', connectionId: CONN_ID, model: MODEL },
      optionsSender,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } });
  });

  it('404 → notFound', async () => {
    const deps = withConn(connFixture(`${relay.url}/m/404/v1`));
    const result = await createOptions(deps)(
      { type: 'connection/test', connectionId: CONN_ID, model: MODEL },
      optionsSender,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'notFound', status: 404 } });
  });

  it('连接不存在：不发请求', async () => {
    const deps = makeDeps(); // DEFAULT_SETTINGS.connections 为空
    const result = await createOptions(deps)(
      { type: 'connection/test', connectionId: CONN_ID, model: MODEL },
      optionsSender,
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'badResponse', serverMessage: '连接不存在，请先保存' },
      elapsedMs: expect.any(Number),
    });
  });

  it('超时：head35 比超时时限慢，判定为 timeout', async () => {
    // 覆盖默认 30 秒；真实 head35 经 scale 缩放后约 350ms，远比这个时限慢
    const deps = withConn(connFixture(`${relay.url}/m/head35/v1`), { connectionTestTimeoutMs: 50 });
    const result = await createOptions(deps)(
      { type: 'connection/test', connectionId: CONN_ID, model: MODEL },
      optionsSender,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });

  it('listModels 成功', async () => {
    const deps = withConn(connFixture(`${relay.url}/v1`));
    const result = await createOptions(deps)(
      { type: 'connection/listModels', connectionId: CONN_ID },
      optionsSender,
    );
    expect(result).toEqual({ ok: true, models: [MODEL] });
  });

  it('listModels 失败：401', async () => {
    const deps = withConn(connFixture(`${relay.url}/m/401/v1`));
    const result = await createOptions(deps)(
      { type: 'connection/listModels', connectionId: CONN_ID },
      optionsSender,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } });
  });
});

describe('设置页通道：角色与 ensureLocked（假依赖）', () => {
  it('非 options 角色发来 connection/test：一律拒绝，不发请求', async () => {
    const h = makeHarness();
    const res = await h.message(
      { type: 'connection/test', connectionId: CONN_ID, model: MODEL },
      h.contentSender(),
    );
    expect(res).toEqual({ ok: false, reason: 'notAllowed' });
    expect(h.fetches).toHaveLength(0);
  });

  it('settings/ensureLocked 成功：收紧一次后回 locked true', async () => {
    const h = makeHarness();
    const res = await h.message({ type: 'settings/ensureLocked' }, h.optionsSender());
    expect(res).toEqual({ locked: true });
  });

  it('settings/ensureLocked 失败：收紧失败回 locked false，无副作用', async () => {
    const h = makeHarness({ lockStorageFails: true });
    const res = await h.message({ type: 'settings/ensureLocked' }, h.optionsSender());
    expect(res).toEqual({ locked: false });
  });
});
