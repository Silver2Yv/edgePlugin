// chatCompletions 适配器（5.8）。用模拟中转站拿真实响应：流式场景验证解析器（随机块边界、
// 正文拼接完整、无重复、finish/错误正确），非 2xx / HTML 场景验证响应头分类；另外单独验证
// buildChat/buildListModels 的地址拼接、受保护字段、思考映射、鉴权头。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatRequest, Connection, StreamEvent } from '@/core/llm/adapter';
import { chatCompletionsAdapter } from '@/core/llm/chat-completions';
import { type MockRelay, startMockRelay } from '../../mock-relay/server';

let relay: MockRelay;
beforeAll(async () => {
  relay = await startMockRelay({ scale: 0.001 });
});
afterAll(() => relay.close());

const ANSWER = ['这是', '模拟中转站', '的回答。', '它分多段', '流式返回。'];
const REASONING = ['先想', '一想。'];

const ask = (mode: string, stream = true) =>
  fetch(`${relay.url}/m/${mode}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify({ model: 'mock-flash', stream, messages: [{ role: 'user', content: 'hi' }] }),
  });

// 确定性的小随机数生成器，避免测试结果不可复现
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按随机长度（1~12 个 UTF-16 code unit）切块，模拟任意的网络块边界 */
function randomChunks(text: string, seed: number): string[] {
  const rng = mulberry32(seed);
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const len = 1 + Math.floor(rng() * 12);
    chunks.push(text.slice(i, i + len));
    i += len;
  }
  return chunks;
}

/** 读出响应体全部文本；disconnect 模式会中途抛错，吞掉异常，返回已读到的部分 */
async function readAvailableText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // disconnect：连接中途被断开，吞掉异常
  }
  return text;
}

/** 用若干个随机种子分别切块喂给一个新解析器，断言每次切法都得到同样的事件序列 */
function parseWithSeeds(text: string, seeds: readonly number[]): StreamEvent[][] {
  return seeds.map((seed) => {
    const parser = chatCompletionsAdapter.createStreamParser();
    const events: StreamEvent[] = [];
    for (const chunk of randomChunks(text, seed)) events.push(...parser.push(chunk));
    events.push(...parser.end());
    return events;
  });
}

function textOf(events: StreamEvent[]): string {
  return events
    .filter((e): e is { kind: 'text'; text: string } => e.kind === 'text')
    .map((e) => e.text)
    .join('');
}
function reasoningOf(events: StreamEvent[]): string {
  return events
    .filter((e): e is { kind: 'reasoning'; text: string } => e.kind === 'reasoning')
    .map((e) => e.text)
    .join('');
}

const SEEDS = [1, 2, 3];

describe('流式解析：正常与各种畸形换行', () => {
  for (const mode of ['ok', 'heartbeat', 'crlf', 'cr', 'split']) {
    it(`${mode}：正文与思考拼接完整，finish=stop，usage 正确，无错误`, async () => {
      const text = await readAvailableText(await ask(mode));
      for (const events of parseWithSeeds(text, SEEDS)) {
        expect(textOf(events)).toBe(ANSWER.join(''));
        expect(reasoningOf(events)).toBe(REASONING.join(''));
        expect(events.filter((e) => e.kind === 'error')).toHaveLength(0);
        const finishes = events.filter((e) => e.kind === 'finish');
        expect(finishes).toEqual([{ kind: 'finish', reason: 'stop' }]);
        const usages = events.filter((e) => e.kind === 'usage');
        expect(usages).toEqual([{ kind: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }]);
      }
    });
  }

  it('streamError：已收到的正文保留，只报流中的那一个错误，end() 不再补 streamBroken', async () => {
    const text = await readAvailableText(await ask('streamError'));
    for (const events of parseWithSeeds(text, SEEDS)) {
      expect(textOf(events)).toBe(ANSWER.slice(0, 2).join(''));
      expect(reasoningOf(events)).toBe(REASONING.join(''));
      const errors = events.filter((e): e is Extract<StreamEvent, { kind: 'error' }> => e.kind === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.error).toMatchObject({
        kind: 'server',
        serverMessage: expect.stringContaining('upstream'),
      });
      expect(events.filter((e) => e.kind === 'finish')).toHaveLength(0);
    }
  });

  it('disconnect：中途断开时已收到的正文保留，没有 finish，end() 给 streamBroken', async () => {
    const text = await readAvailableText(await ask('disconnect'));
    for (const events of parseWithSeeds(text, SEEDS)) {
      expect(textOf(events)).toBe(ANSWER.slice(0, 2).join(''));
      expect(reasoningOf(events)).toBe(REASONING.join(''));
      expect(events.filter((e) => e.kind === 'finish')).toHaveLength(0);
      const errors = events.filter((e) => e.kind === 'error');
      expect(errors).toEqual([{ kind: 'error', error: { kind: 'streamBroken' } }]);
    }
  });

  it('同一正文不管怎么切块，事件序列完全一致（不重复、不丢）', async () => {
    const text = await readAvailableText(await ask('split'));
    const [a, b, c] = parseWithSeeds(text, [11, 97, 4242]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });
});

describe('非流式整段响应', () => {
  it('parseWhole 得到与流式等价的事件（stream 被服务端忽略时）', async () => {
    const body = await (await ask('ok', false)).text();
    const events = chatCompletionsAdapter.parseWhole(body);
    expect(textOf(events)).toBe(ANSWER.join(''));
    expect(events.filter((e) => e.kind === 'finish')).toEqual([{ kind: 'finish', reason: 'stop' }]);
    expect(events.filter((e) => e.kind === 'usage')).toEqual([
      { kind: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
    ]);
  });

  it('不是合法 JSON 时给 badResponse', () => {
    expect(chatCompletionsAdapter.parseWhole('不是 JSON')).toEqual([
      { kind: 'error', error: { kind: 'badResponse' } },
    ]);
  });
});

describe('响应头分类', () => {
  it('html200：200 加网页 → htmlInsteadOfJson', async () => {
    const res = await ask('html200');
    const head = {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      bodyHead: await res.text(),
    };
    expect(chatCompletionsAdapter.classifyHead(head)).toEqual({ kind: 'htmlInsteadOfJson', status: 200 });
  });

  it('401 → auth，带脱敏后的服务端原话', async () => {
    const res = await ask('401');
    const head = {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      bodyHead: await res.text(),
    };
    expect(chatCompletionsAdapter.classifyHead(head)).toEqual({
      kind: 'auth',
      status: 401,
      serverMessage: '无效的令牌',
    });
  });

  it('404 → notFound', async () => {
    const res = await ask('404');
    const head = {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      bodyHead: await res.text(),
    };
    expect(chatCompletionsAdapter.classifyHead(head)).toEqual({
      kind: 'notFound',
      status: 404,
      serverMessage: 'model not found',
    });
  });

  it('param400 → paramRejected，认出可疑参数名', async () => {
    const res = await ask('param400');
    const head = {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      bodyHead: await res.text(),
    };
    expect(chatCompletionsAdapter.classifyHead(head)).toEqual({
      kind: 'paramRejected',
      status: 400,
      serverMessage: 'Unrecognized request argument supplied: thinking',
      suspectParam: 'thinking',
    });
  });

  it('400 且报文没有 param 字段时，从报错措辞里猜参数名；猜不出就不填', () => {
    const guessed = chatCompletionsAdapter.classifyHead({
      status: 400,
      contentType: 'application/json',
      bodyHead: JSON.stringify({ error: { message: "Unknown parameter: 'top_k'" } }),
    });
    expect(guessed).toEqual({
      kind: 'paramRejected',
      status: 400,
      serverMessage: "Unknown parameter: 'top_k'",
      suspectParam: 'top_k',
    });
    const unguessable = chatCompletionsAdapter.classifyHead({
      status: 400,
      contentType: 'application/json',
      bodyHead: JSON.stringify({ error: { message: '请求无法处理' } }),
    });
    expect(unguessable).toEqual({ kind: 'paramRejected', status: 400, serverMessage: '请求无法处理' });
  });

  it('服务端报错里出现 sk-/Bearer/长十六进制串时脱敏', () => {
    const headHtml = chatCompletionsAdapter.classifyHead({
      status: 500,
      contentType: 'application/json',
      bodyHead: JSON.stringify({
        error: { message: '令牌 sk-abcdEFGH1234 无效，Bearer xyz987 已过期，trace=0123456789abcdef0123' },
      }),
    });
    expect(headHtml?.serverMessage).not.toMatch(/sk-abcdEFGH1234|Bearer xyz987|0123456789abcdef0123/);
    expect(headHtml?.serverMessage).toContain('sk-…');
    expect(headHtml?.serverMessage).toContain('Bearer …');
  });

  it('300 与 opaqueredirect（status 0）→ redirected；5xx → server；其他非 2xx → badResponse', () => {
    expect(chatCompletionsAdapter.classifyHead({ status: 0, contentType: '', bodyHead: '' })).toEqual({
      kind: 'redirected',
      status: 0,
    });
    expect(chatCompletionsAdapter.classifyHead({ status: 302, contentType: '', bodyHead: '' })).toEqual({
      kind: 'redirected',
      status: 302,
    });
    expect(
      chatCompletionsAdapter.classifyHead({ status: 503, contentType: '', bodyHead: '{}' }),
    ).toMatchObject({
      kind: 'server',
      status: 503,
    });
    expect(
      chatCompletionsAdapter.classifyHead({ status: 429, contentType: '', bodyHead: '{}' }),
    ).toMatchObject({
      kind: 'rateLimited',
      status: 429,
    });
    expect(
      chatCompletionsAdapter.classifyHead({ status: 409, contentType: '', bodyHead: '{}' }),
    ).toMatchObject({
      kind: 'badResponse',
      status: 409,
    });
    expect(
      chatCompletionsAdapter.classifyHead({ status: 204, contentType: '', bodyHead: '' }),
    ).toBeUndefined();
  });
});

describe('parseModelList', () => {
  it('{ data: [{ id }] } → id 数组', async () => {
    const body = await (await fetch(`${relay.url}/v1/models`)).text();
    expect(chatCompletionsAdapter.parseModelList(body)).toEqual(['mock-flash']);
  });

  it('格式不对返回空数组', () => {
    expect(chatCompletionsAdapter.parseModelList('不是 JSON')).toEqual([]);
    expect(chatCompletionsAdapter.parseModelList('{}')).toEqual([]);
    expect(chatCompletionsAdapter.parseModelList(JSON.stringify({ data: 'x' }))).toEqual([]);
    expect(chatCompletionsAdapter.parseModelList(JSON.stringify({ data: [{ noId: 1 }] }))).toEqual([]);
  });
});

// ───────────── buildChat / buildListModels ─────────────

const conn = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'conn-0000000',
  name: '测试连接',
  preset: 'custom',
  baseUrl: 'https://relay.example/v1',
  apiKey: 'test-key',
  headers: {},
  interfaceType: 'chatCompletions',
  stream: true,
  extraParams: {},
  configVersion: 1,
  ...overrides,
});

const req = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'real-model',
  messages: [{ role: 'user', content: [{ kind: 'text', text: '你好' }] }],
  stream: true,
  ...overrides,
});

describe('buildChat：地址', () => {
  it('baseUrl 以 /v1 结尾：去尾斜杠后拼 /chat/completions', () => {
    expect(chatCompletionsAdapter.buildChat(conn({ baseUrl: 'https://x.example/v1' }), req()).url).toBe(
      'https://x.example/v1/chat/completions',
    );
    expect(chatCompletionsAdapter.buildChat(conn({ baseUrl: 'https://x.example/v1/' }), req()).url).toBe(
      'https://x.example/v1/chat/completions',
    );
  });

  it('baseUrl 已以 /chat/completions 结尾：原样使用', () => {
    const baseUrl = 'https://x.example/custom/chat/completions';
    expect(chatCompletionsAdapter.buildChat(conn({ baseUrl }), req()).url).toBe(baseUrl);
  });

  it('buildListModels 拼 /models', () => {
    expect(chatCompletionsAdapter.buildListModels(conn({ baseUrl: 'https://x.example/v1/' })).url).toBe(
      'https://x.example/v1/models',
    );
  });

  it('POST，redirect 固定为 manual', () => {
    const r = chatCompletionsAdapter.buildChat(conn(), req());
    expect(r.method).toBe('POST');
    expect(r.redirect).toBe('manual');
    expect(chatCompletionsAdapter.buildListModels(conn()).method).toBe('GET');
  });
});

describe('buildChat：请求头', () => {
  it('apiKey 非空时带 Bearer；为空时不带 Authorization', () => {
    const withKey = chatCompletionsAdapter.buildChat(conn({ apiKey: 'sk-abc' }), req());
    expect(withKey.headers.Authorization).toBe('Bearer sk-abc');
    const noKey = chatCompletionsAdapter.buildChat(conn({ apiKey: '' }), req());
    expect(noKey.headers.Authorization).toBeUndefined();
    expect(noKey.headers['Content-Type']).toBe('application/json');
  });

  it('conn.headers 在 Authorization 之后合并，可以覆盖', () => {
    const r = chatCompletionsAdapter.buildChat(
      conn({ apiKey: 'sk-abc', headers: { Authorization: 'Custom xyz', 'X-Trace': 't1' } }),
      req(),
    );
    expect(r.headers.Authorization).toBe('Custom xyz');
    expect(r.headers['X-Trace']).toBe('t1');
  });
});

describe('buildChat：正文', () => {
  it('受保护字段不被 extraParams 覆盖；可覆盖字段（如 temperature）会带上', () => {
    const r = chatCompletionsAdapter.buildChat(
      conn({
        extraParams: {
          model: 'evil-model',
          messages: [{ role: 'user', content: 'evil' }],
          stream: false,
          tool_choice: 'none',
          temperature: 0.3,
        },
      }),
      req({ model: 'real-model', stream: true }),
    );
    const body = JSON.parse(r.body ?? '{}');
    expect(body.model).toBe('real-model');
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }]);
    expect(body.tool_choice).toBeUndefined();
    expect(body.temperature).toBe(0.3);
  });

  it('纯文本消息合成字符串 content；含图片的消息用数组', () => {
    const r = chatCompletionsAdapter.buildChat(
      conn(),
      req({
        messages: [
          {
            role: 'user',
            content: [
              { kind: 'text', text: 'a' },
              { kind: 'text', text: 'b' },
            ],
          },
          {
            role: 'user',
            content: [
              { kind: 'text', text: '看图' },
              { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' },
            ],
          },
        ],
      }),
    );
    const body = JSON.parse(r.body ?? '{}');
    expect(body.messages[0]).toEqual({ role: 'user', content: 'ab' });
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
  });

  it('stream 为真时附加 stream_options；为假时不附加', () => {
    const on = JSON.parse(chatCompletionsAdapter.buildChat(conn(), req({ stream: true })).body ?? '{}');
    expect(on.stream_options).toEqual({ include_usage: true });
    const off = JSON.parse(chatCompletionsAdapter.buildChat(conn(), req({ stream: false })).body ?? '{}');
    expect(off.stream_options).toBeUndefined();
  });

  it('maxTokens 映射为 max_tokens，未提供时不发送', () => {
    const with_ = JSON.parse(chatCompletionsAdapter.buildChat(conn(), req({ maxTokens: 512 })).body ?? '{}');
    expect(with_.max_tokens).toBe(512);
    const without = JSON.parse(chatCompletionsAdapter.buildChat(conn(), req()).body ?? '{}');
    expect(without.max_tokens).toBeUndefined();
    // 采样参数可覆盖（5.8）：额外参数里的 max_tokens 优先
    const user = chatCompletionsAdapter.buildChat(
      conn({ extraParams: { max_tokens: 100 } }),
      req({ maxTokens: 512 }),
    );
    expect(JSON.parse(user.body ?? '{}').max_tokens).toBe(100);
  });

  it('思考映射：undefined 不发；off/on 走 thinking.type；{effort} 走 reasoning_effort', () => {
    const none = JSON.parse(chatCompletionsAdapter.buildChat(conn(), req()).body ?? '{}');
    expect(none.thinking).toBeUndefined();
    expect(none.reasoning_effort).toBeUndefined();

    const off = JSON.parse(chatCompletionsAdapter.buildChat(conn(), req({ thinking: 'off' })).body ?? '{}');
    expect(off.thinking).toEqual({ type: 'disabled' });

    const on = JSON.parse(chatCompletionsAdapter.buildChat(conn(), req({ thinking: 'on' })).body ?? '{}');
    expect(on.thinking).toEqual({ type: 'enabled' });

    const effort = JSON.parse(
      chatCompletionsAdapter.buildChat(conn(), req({ thinking: { effort: 'high' } })).body ?? '{}',
    );
    expect(effort.reasoning_effort).toBe('high');
    expect(effort.thinking).toBeUndefined();
  });
});
