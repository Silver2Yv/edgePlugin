// 模拟中转站（VALIDATION_MATRIX V-01）：OpenAI 兼容的 /v1/chat/completions 与 /v1/models。
// 模式放在路径里：http://127.0.0.1:8787/m/<模式>/v1/chat/completions；不带 /m/<模式> 等于 ok。
// 时间可缩放：MOCK_RELAY_SCALE=0.01 时 65 秒变 0.65 秒（单元测试用）。
// GET /__log 返回收到的请求（不记录 Key，只记是否带鉴权），POST /__reset 清空。
//
// | 模式 | 行为 |
// | ok | 立即返回头，先思考后正文，[DONE] 结束 |
// | head35 / head65 | 35 / 65 秒后才返回响应头 |
// | silent65 | 立即返回头，65 秒没有正文增量，然后正常输出 |
// | long | 持续输出 330 秒（超过 5 分钟）；?sec=N 可改时长 |
// | slowJson | 等 65 秒后返回非流式 JSON（忽略 stream） |
// | heartbeat | 事件间夹 SSE 注释心跳（: ping） |
// | crlf / cr | 用 \r\n / \r 换行 |
// | split | 一个事件拆进多个网络块（逐字节写出） |
// | streamError | 输出几段后在流里给出 error 对象 |
// | disconnect | 输出几段后直接断开连接 |
// | failOnce | 第一次请求像 disconnect 一样中途断开，第二次起正常走完（V-03 测重试能恢复） |
// | html200 | 200 加网页（漏写 /v1 的真实表现） |
// | markdown | 分约 20 段流式输出一份含标题/列表/代码/表格/公式/链接/原始 HTML 的 Markdown（V-10） |
// | 401 / 403 / 404 / 405 | 对应错误（401 用 new_api_error，其他用 invalid_request_error） |
// | param400 | 400，报某个参数不支持 |
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const MODES = [
  'ok',
  'head35',
  'head65',
  'silent65',
  'long',
  'slowJson',
  'heartbeat',
  'crlf',
  'cr',
  'split',
  'streamError',
  'disconnect',
  'failOnce',
  'html200',
  'markdown',
  '401',
  '403',
  '404',
  '405',
  'param400',
] as const;
export type Mode = (typeof MODES)[number];

export interface LogEntry {
  at: number;
  mode: Mode;
  path: string;
  model?: string;
  stream?: boolean;
  hasAuth: boolean;
}

const ANSWER = ['这是', '模拟中转站', '的回答。', '它分多段', '流式返回。'];
const REASONING = ['先想', '一想。'];

/**
 * V-10 markdown 模式的完整正文：标题、有序/无序列表、ts 代码围栏、表格、行内/块级公式、
 * http 链接、javascript: 链接（协议不在白名单内）、外链图片（不应被抓取显示）、
 * 原始 <script>/<img onerror> HTML（html:false 下应被当纯文本转义）。
 * 按大致相等的字符数切成约 20 段，交给调用方逐段流式写出。
 */
const MARKDOWN_DOC = `# 流式渲染测试文档

## 列表

### 无序

- 无序项一
- 无序项二
  - 嵌套项

### 有序

1. 有序项一
2. 有序项二

## 代码

\`\`\`ts
function greet(name: string): string {
  return \`你好，\${name}\`;
}
\`\`\`

## 表格

| 姓名 | 分数 |
| --- | --- |
| 张三 | 90 |
| 李四 | 85 |

## 公式

行内公式 $E = mc^2$，块级公式：

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

## 链接与图片

安全链接：[示例网站](http://example.com)

危险链接：[点我](javascript:alert(1))

外链图片：![示例图片](https://example.com/pic.png)

## 原始 HTML（应被转义，不执行）

<script>window.__pwned = 1;</script>
<img src="x" onerror="window.__pwned = 2">

正文结束。
`;

/** 把一段文本按近似等长切成 n 段（不在多字节字符中间切开） */
function splitEvenly(text: string, n: number): string[] {
  const chars = Array.from(text);
  const per = Math.ceil(chars.length / n);
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += per) parts.push(chars.slice(i, i + per).join(''));
  return parts;
}
const MARKDOWN_CHUNKS = splitEvenly(MARKDOWN_DOC, 20);

const ERRORS: Partial<Record<Mode, { status: number; type: string; message: string; param?: string }>> = {
  '401': { status: 401, type: 'new_api_error', message: '无效的令牌' },
  '403': { status: 403, type: 'invalid_request_error', message: 'forbidden' },
  '404': { status: 404, type: 'invalid_request_error', message: 'model not found' },
  '405': { status: 405, type: 'invalid_request_error', message: 'method not allowed' },
  param400: {
    status: 400,
    type: 'invalid_request_error',
    message: 'Unrecognized request argument supplied: thinking',
    param: 'thinking',
  },
};

const HTML =
  '<!doctype html><html><head><title>Relay</title></head><body><div id="root"></div></body></html>';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

export interface MockRelay {
  server: Server;
  url: string;
  log: LogEntry[];
  close(): Promise<void>;
}

export async function startMockRelay(
  opts: { port?: number; host?: string; scale?: number } = {},
): Promise<MockRelay> {
  const scale = opts.scale ?? Number(process.env.MOCK_RELAY_SCALE ?? 1);
  const log: LogEntry[] = [];
  /** failOnce 模式用：第几次请求到达，从 1 起 */
  let failOnceAttempts = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * scale));

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
    if (url.pathname === '/__log') return json(res, 200, log);
    if (url.pathname === '/__reset') {
      log.length = 0;
      failOnceAttempts = 0;
      return json(res, 200, { ok: true });
    }
    const m = /^(?:\/m\/([^/]+))?(\/.*)$/.exec(url.pathname);
    const mode = (m?.[1] ?? 'ok') as Mode;
    const rest = m?.[2] ?? '/';
    if (!MODES.includes(mode)) return json(res, 400, { error: { message: `未知模式 ${mode}` } });

    if (rest === '/v1/models' && req.method === 'GET') {
      const err = ERRORS[mode];
      if (err) return json(res, err.status, { error: err });
      return json(res, 200, { object: 'list', data: [{ id: 'mock-flash', object: 'model' }] });
    }
    // 中转站对未知路径（含漏写 /v1）返回 200 加网页
    if (rest !== '/v1/chat/completions' || req.method !== 'POST' || mode === 'html200') {
      return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...CORS }).end(HTML);
    }

    const body = JSON.parse((await readBody(req)) || '{}') as { model?: string; stream?: boolean };
    log.push({
      at: Date.now(),
      mode,
      path: url.pathname,
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(body.stream === undefined ? {} : { stream: body.stream }),
      hasAuth: typeof req.headers.authorization === 'string',
    });
    const model = body.model ?? 'mock-flash';
    if (mode === 'failOnce') failOnceAttempts++;

    const err = ERRORS[mode];
    if (err) return json(res, err.status, { error: err });
    if (mode === 'head35') await sleep(35_000);
    if (mode === 'head65' || mode === 'slowJson') await sleep(65_000);
    if (mode === 'slowJson' || !body.stream) {
      return json(res, 200, {
        id: 'mock',
        object: 'chat.completion',
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: ANSWER.join('') }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    }

    const nl = mode === 'crlf' ? '\r\n' : mode === 'cr' ? '\r' : '\n';
    const ev = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}${nl}${nl}`;
    const chunk = (delta: Record<string, string>, finish: string | null = null, usage?: object) =>
      ev({
        id: 'mock',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      });
    const write = async (s: string) => {
      if (res.destroyed) return;
      if (mode !== 'split') return void res.write(s);
      // 逐 7 字节写出，故意切在多字节字符中间，且块间留间隔避免被合并
      const buf = Buffer.from(s);
      for (let i = 0; i < buf.length && !res.destroyed; i += 7) {
        res.write(buf.subarray(i, i + 7));
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      ...CORS,
    });
    res.flushHeaders();
    if (mode === 'silent65') await sleep(65_000);

    // 两段思考放进同一次写入：一个网络块含多个事件
    await write(REASONING.map((r) => chunk({ reasoning_content: r })).join(''));
    if (mode === 'long') {
      const sec = Number(url.searchParams.get('sec') ?? 330);
      const until = Date.now() + sec * 1000 * scale;
      for (let i = 1; Date.now() < until && !res.destroyed; i++) {
        await write(chunk({ content: `第 ${i} 段。` }));
        await sleep(1000);
      }
    } else if (mode === 'markdown') {
      for (const piece of MARKDOWN_CHUNKS) {
        if (res.destroyed) break;
        await write(chunk({ content: piece }));
        await sleep(100);
      }
    } else {
      for (const [i, piece] of ANSWER.entries()) {
        if (i === 2 && mode === 'streamError') {
          await write(ev({ error: { message: 'upstream overloaded', type: 'server_error' } }));
          return void res.end();
        }
        if (i === 2 && mode === 'disconnect') return void res.socket?.destroy();
        if (i === 2 && mode === 'failOnce' && failOnceAttempts === 1) return void res.socket?.destroy();
        if (mode === 'heartbeat') await write(`: ping${nl}${nl}`);
        await write(chunk({ content: piece }));
        await sleep(50);
      }
    }
    await write(chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }));
    await write(ev('[DONE]'));
    res.end();
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    log,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS }).end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

if (import.meta.main) {
  const relay = await startMockRelay({ port: Number(process.env.MOCK_RELAY_PORT ?? 8787) });
  console.log(`模拟中转站已启动：${relay.url}/m/<模式>/v1  模式：${MODES.join(' ')}`);
}
