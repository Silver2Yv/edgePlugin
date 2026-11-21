// 后台单测的假依赖：内存 storage.session、可控的流式响应、假适配器、假端口。
import { vi } from 'vitest';
import { createBackground } from '@/background/app';
import type { BackgroundDeps, ConvPort, SenderLike, SessionArea } from '@/background/deps';
import { CONV_PORT } from '@/core/domain/messages';
import { DEFAULT_SETTINGS, type Settings } from '@/core/domain/settings';
import type { Connection, ModelAdapter, StreamEvent } from '@/core/llm/adapter';

export const EXT_ID = 'pkahgpgifechjgdpecaebajnocgcnnnd';
export const TAB = 7;
/** TAB 所在的窗口；侧边栏默认在这个窗口 */
export const WIN = 1;
export const TOP_DOC = 'doc-top-1';
export const FLOAT_DOC = 'doc-float-1';
export const SECRET_KEY = 'test-secret-key-123';

export const CONN: Connection = {
  id: 'conn-test-0001',
  name: '测试连接',
  preset: 'custom',
  baseUrl: 'https://relay.test/v1',
  apiKey: SECRET_KEY,
  headers: {},
  interfaceType: 'chatCompletions',
  stream: true,
  extraParams: {},
  configVersion: 1,
};
export const MODEL = { connectionId: CONN.id, model: 'mock-flash' };

export const SETTINGS: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  connections: [CONN],
  defaultModel: MODEL,
};

export function fakeSession(): SessionArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    data,
    async get(keys) {
      const out: Record<string, unknown> = {};
      const list = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      for (const k of list) if (data.has(k)) out[k] = clone(data.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, clone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

/** 可控的响应体：测试逐段 push，最后 close；请求被中止时以 AbortError 结束 */
export interface FakeResponse {
  push(s: string): void;
  close(): void;
  fail(): void;
}

export interface FetchCall {
  url: string;
  init: RequestInit;
  /** 调用 fetch 那一刻 storage.session 里的任务记录 */
  jobsAtCall: unknown[];
  res: FakeResponse;
}

/** 假适配器：每行一个事件。T:正文 R:思考 E:错误 F 结束 */
export const fakeAdapter: ModelAdapter = {
  interfaceType: 'chatCompletions',
  buildChat: (conn, req) => ({
    url: `${conn.baseUrl}/chat/completions`,
    method: 'POST',
    headers: { authorization: `Bearer ${conn.apiKey}` },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: req.stream,
      thinking: req.thinking,
    }),
    redirect: 'manual',
  }),
  buildListModels: (conn) => ({
    url: `${conn.baseUrl}/models`,
    method: 'GET',
    headers: {},
    redirect: 'manual',
  }),
  classifyHead: ({ status, bodyHead }) =>
    status === 200 ? undefined : { kind: 'auth', status, serverMessage: bodyHead },
  createStreamParser() {
    let buf = '';
    const lineEvents = (line: string): StreamEvent[] => {
      if (line.startsWith('T:')) return [{ kind: 'text', text: line.slice(2) }];
      if (line.startsWith('R:')) return [{ kind: 'reasoning', text: line.slice(2) }];
      if (line.startsWith('E:'))
        return [{ kind: 'error', error: { kind: 'server', serverMessage: line.slice(2) } }];
      if (line === 'F') return [{ kind: 'finish', reason: 'stop' }];
      return [];
    };
    return {
      push(chunk) {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        return lines.flatMap(lineEvents);
      },
      end: () => (buf ? lineEvents(buf) : []),
    };
  },
  parseWhole: (body) => [{ kind: 'text', text: body }],
  parseModelList: () => [],
};

let instances = 0;

export function makeHarness(
  opts: {
    session?: ReturnType<typeof fakeSession>;
    status?: number;
    /** 让 lockStorage（收紧 storage.local）每次调用都失败，用于测 settings/ensureLocked 的失败分支 */
    lockStorageFails?: boolean;
    /** fetch 调用后永不 resolve（除非被 signal 中止），模拟 head35/head65 那样迟迟不来的响应头（V-01） */
    hangForever?: boolean;
    /** 覆盖发问等待响应头的超时（毫秒），配合 hangForever 测连接超时，不必真的等 28 秒 */
    askConnectTimeoutMs?: number;
  } = {},
) {
  const instance = ++instances;
  const session = opts.session ?? fakeSession();
  let clock = 1_000_000;
  let ids = 0;
  let tokens = 0;
  const fetches: FetchCall[] = [];
  const sent: {
    tabId: number;
    frameId: number;
    documentId: string;
    msg: { type: string; token?: string };
  }[] = [];
  const logs: { event: string; detail?: Record<string, unknown> }[] = [];
  let topDoc = TOP_DOC;
  let tabUrl: string | undefined = 'https://example.test/article';
  let settings: Settings = structuredClone(SETTINGS);
  const marked = new Set<string>();
  const injected: string[] = [];
  /** 标签页 → 窗口；侧边栏的窗口核对按它 */
  const tabWindows = new Map<number, number>([[TAB, WIN]]);
  const windows = new Set<number>([WIN]);
  /** sidePanel.open：有没有「手势」由测试控制；记下每次调用时是否还在发起它的同步段里 */
  const panel = { gesture: true, opens: [] as number[] };
  const pageMessages: unknown[] = [];

  const deps: BackgroundDeps = {
    self: { runtimeId: EXT_ID, protocol: 'chrome-extension:' },
    session,
    loadSettings: async () => ({ ok: true, settings: structuredClone(settings), migratedFrom: 1 }),
    injectReader: vi.fn(async () => {
      await Promise.resolve();
      // 模拟隔离环境里的标记：同一文档只注入一次
      if (!marked.has(topDoc)) {
        marked.add(topDoc);
        injected.push(topDoc);
      }
      return topDoc;
    }),
    getTabUrl: vi.fn(async () => tabUrl),
    sendToFrame: vi.fn(async (tabId, frameId, documentId, msg) => {
      if (documentId !== topDoc) throw new Error('No document');
      sent.push({ tabId, frameId, documentId, msg });
    }),
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      const all = await session.get(null);
      const jobsAtCall = Object.entries(all)
        .filter(([k]) => k.startsWith('job:'))
        .map(([, v]) => v);
      if (opts.hangForever) {
        // 模拟响应头迟迟不来（head35/head65）：fetch 本身不 resolve，只能被 signal 中止
        const res: FakeResponse = { push: () => undefined, close: () => undefined, fail: () => undefined };
        fetches.push({ url, init, jobsAtCall, res });
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          ctl = c;
        },
      });
      const res: FakeResponse = {
        push: (s) => ctl.enqueue(enc.encode(s)),
        close: () => ctl.close(),
        fail: () => ctl.error(new TypeError('network')),
      };
      init.signal?.addEventListener('abort', () => {
        try {
          ctl.error(new DOMException('aborted', 'AbortError'));
        } catch {
          // 已关闭
        }
      });
      fetches.push({ url, init, jobsAtCall, res });
      return new Response(body, {
        status: opts.status ?? 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
    adapters: { chatCompletions: fakeAdapter },
    now: () => clock,
    // 每个后台实例的编号前缀不同：同一份 storage.session 上先后起两个实例（模拟重启）时不撞号
    newId: () => `id-${instance}-${String(++ids).padStart(8, '0')}`,
    newToken: () => (instance * 1_000_000 + ++tokens).toString(16).padStart(32, '0'),
    log: (event, detail) => logs.push({ event, ...(detail ? { detail } : {}) }),
    lockStorage: vi.fn(async () => {
      if (opts.lockStorageFails) throw new Error('锁定失败');
    }),
    openSidePanel: vi.fn((windowId: number) => {
      panel.opens.push(windowId);
      return panel.gesture
        ? Promise.resolve()
        : Promise.reject(new Error('`sidePanel.open()` may only be called in response to a user gesture.'));
    }),
    tabWindow: vi.fn(async (tabId: number) => tabWindows.get(tabId)),
    windowExists: vi.fn(async (w: number) => windows.has(w)),
    panelWindowOf: vi.fn(async () => undefined),
    notifyPages: vi.fn(async (msg: unknown) => {
      pageMessages.push(msg);
    }),
    ...(opts.askConnectTimeoutMs !== undefined ? { askConnectTimeoutMs: opts.askConnectTimeoutMs } : {}),
  };
  const app = createBackground(deps);

  const contentSender = (frameId = 0, documentId = TOP_DOC): SenderLike => ({
    id: EXT_ID,
    url: 'https://example.test/article',
    origin: 'https://example.test',
    tab: { id: TAB },
    frameId,
    documentId,
  });
  const floatSender = (documentId = FLOAT_DOC, tabId = TAB): SenderLike => ({
    id: EXT_ID,
    url: 'chrome-extension://0f1e2d3c-dynamic-id/float.html',
    origin: 'chrome-extension://0f1e2d3c-dynamic-id',
    tab: { id: tabId },
    frameId: 3,
    documentId,
  });
  /** 侧边栏：不在标签页里；Chrome 159 / Edge 157 实测端口 sender 不带 documentId */
  const panelSender = (documentId?: string): SenderLike => ({
    id: EXT_ID,
    url: `chrome-extension://${EXT_ID}/sidepanel.html`,
    origin: `chrome-extension://${EXT_ID}`,
    ...(documentId === undefined ? {} : { documentId }),
  });
  /** 设置页 / 欢迎页：按路径判定，不要求在标签页里 */
  const optionsSender = (path: '/options.html' | '/welcome.html' = '/options.html'): SenderLike => ({
    id: EXT_ID,
    url: `chrome-extension://${EXT_ID}${path}`,
    origin: `chrome-extension://${EXT_ID}`,
  });

  function connect(sender: SenderLike = floatSender()) {
    const received: Record<string, unknown>[] = [];
    let onMsg: (m: unknown) => void = () => undefined;
    let onDisc: () => void = () => undefined;
    const port: ConvPort = {
      name: CONV_PORT,
      sender,
      postMessage: (m) => received.push(structuredClone(m) as Record<string, unknown>),
      disconnect: () => undefined,
      onMessage: {
        addListener: (cb) => {
          onMsg = cb;
        },
      },
      onDisconnect: {
        addListener: (cb) => {
          onDisc = cb;
        },
      },
    };
    app.onConnect(port);
    return {
      port,
      received,
      send: (m: unknown) => onMsg(m),
      close: () => onDisc(),
      ofType: (type: string) => received.filter((m) => m.type === type),
      last: () => received.at(-1),
    };
  }

  return {
    app,
    deps,
    session,
    fetches,
    sent,
    logs,
    injected,
    contentSender,
    floatSender,
    panelSender,
    optionsSender,
    connect,
    panel,
    pageMessages,
    /** 把标签页挪到某个窗口（不存在的窗口一并建上） */
    moveTab: (tabId: number, windowId: number) => {
      tabWindows.set(tabId, windowId);
      windows.add(windowId);
    },
    addWindow: (windowId: number) => windows.add(windowId),
    message: (raw: unknown, sender: SenderLike = contentSender()) => app.onMessage(raw, sender),
    advance: (ms: number) => {
      clock += ms;
    },
    navigate: (doc: string) => {
      topDoc = doc;
    },
    setTabUrl: (url: string | undefined) => {
      tabUrl = url;
    },
    setSettings: (next: Settings) => {
      settings = structuredClone(next);
    },
  };
}

export type Harness = ReturnType<typeof makeHarness>;

export const selectionReady = (rev = 1) => ({
  type: 'selection/ready',
  selectionRevision: rev,
  textLength: 12,
  inCode: false,
});

export const SELECTED = '光合作用把光能转成化学能。';

export const click = (rev = 1, actionId = 'ask', text = SELECTED) => ({
  type: 'action/click',
  actionId,
  selectionRevision: rev,
  text,
  truncated: false,
  originalLength: [...text].length,
  inCode: false,
});

export const askMsg = (extra: Record<string, unknown> = {}) => ({
  type: 'conv/ask',
  clientRequestId: 'req-00000001',
  actionId: 'ask',
  text: '这句话什么意思？',
  selectionRevision: 1,
  contextTier: 'selection',
  lengthTier: 'normal',
  thinking: 'off',
  model: MODEL,
  ...extra,
});

/** 预热 → 小窗握手 → 订阅，返回已就绪的端口 */
export async function readyFloat(h: Harness) {
  await h.message(selectionReady());
  const token = h.sent.find((s) => s.msg.type === 'float/prewarm')?.msg.token;
  const c = h.connect();
  c.send({ type: 'conv/helloFloat', token });
  await vi.waitFor(() => {
    if (!c.ofType('conv/ready').length) throw new Error('未就绪');
  });
  c.send({ type: 'conv/subscribe' });
  await vi.waitFor(() => {
    if (!c.ofType('conv/snapshot').length) throw new Error('未订阅');
  });
  return c;
}

export const until = (cond: () => boolean, what = '条件') =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error(`等待${what}`);
    },
    { timeout: 2000, interval: 5 },
  );
