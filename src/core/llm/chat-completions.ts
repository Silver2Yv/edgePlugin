// OpenAI 兼容的 chatCompletions 适配器（5.8 模型网关）。纯逻辑：只把 Connection/ChatRequest
// 变成 HttpRequest，把已解码的字符串变成 StreamEvent；真正的 fetch 与解码由后台做。
import {
  type ChatMessage,
  type ChatPart,
  type ChatRequest,
  type Connection,
  type FinishReason,
  type HttpRequest,
  type HttpResponseHead,
  MODEL_FETCH_REDIRECT,
  type ModelAdapter,
  type ModelError,
  type ModelErrorKind,
  PROTECTED_PARAMS,
  type StreamEvent,
  type StreamParser,
  type Usage,
} from './adapter';
import { declaresThinkingEffort } from './capabilities';
import { createSseLineParser } from './sse';
import { buildThinkingBody, thinkingLevelOf } from './thinking';

// ───────────── 地址与请求头 ─────────────

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function chatUrl(baseUrl: string): string {
  return baseUrl.endsWith('/chat/completions') ? baseUrl : `${trimTrailingSlash(baseUrl)}/chat/completions`;
}

function modelsUrl(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/models`;
}

/** buildChat 与 buildListModels 共用：Content-Type、Key（非空时）、再合并连接自带的请求头（可覆盖前两者） */
function buildHeaders(conn: Connection): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (conn.apiKey !== '') headers.Authorization = `Bearer ${conn.apiKey}`;
  return { ...headers, ...conn.headers };
}

// ───────────── 请求正文 ─────────────

type OpenAiContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** 纯文本消息合成字符串 content；含图片的消息用数组形式（文本与图片按原顺序排列） */
function toOpenAiMessage(m: ChatMessage): {
  role: ChatMessage['role'];
  content: string | OpenAiContentPart[];
} {
  const hasImage = m.content.some((p) => p.kind === 'image');
  if (!hasImage) {
    return { role: m.role, content: m.content.map((p) => (p as { text: string }).text).join('') };
  }
  const content: OpenAiContentPart[] = m.content.map((p: ChatPart) =>
    p.kind === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } },
  );
  return { role: m.role, content };
}

/** 思考字段的厂商映射见 thinking.ts（H6）：DeepSeek/Qwen/OpenAI/Claude/Gemini 各自的参数名与取值，
 * 认不出的连接预设默认按「关」处理（不发任何思考相关字段） */

function buildChatBody(
  conn: Connection,
  req: ChatRequest,
  excludeParams: readonly string[] = [],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const protectedFields = new Set<string>(PROTECTED_PARAMS.chatCompletions);
  // 先放额外参数里未受保护的字段，后面的赋值可以覆盖同名的语义字段（如 thinking）
  for (const [k, v] of Object.entries(conn.extraParams)) {
    if (!protectedFields.has(k)) body[k] = v;
  }
  body.model = req.model;
  body.messages = req.messages.map(toOpenAiMessage);
  body.stream = req.stream;
  if (req.stream) body.stream_options = { include_usage: true };
  // max_tokens 属可覆盖的采样参数（5.8）：额外参数里填了就以用户的为准
  if (req.maxTokens !== undefined && !('max_tokens' in body)) body.max_tokens = req.maxTokens;
  Object.assign(
    body,
    buildThinkingBody(
      conn.preset,
      req.model,
      thinkingLevelOf(req.thinking),
      declaresThinkingEffort(conn, req.model),
    ),
  );
  for (const p of excludeParams) delete body[p];
  return body;
}

// ───────────── 响应头分类 ─────────────

/** 脱敏：sk- 开头的密钥、Bearer 后的令牌、16 位以上的十六进制串 */
function redact(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer …')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-…')
    .replace(/\b[0-9a-fA-F]{16,}\b/g, '…');
}

function parseErrorBody(bodyHead: string): { message?: string; param?: string } {
  try {
    const parsed = JSON.parse(bodyHead) as { error?: { message?: unknown; param?: unknown } };
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : undefined;
    const param = typeof parsed.error?.param === 'string' ? parsed.error.param : undefined;
    return { ...(message !== undefined ? { message } : {}), ...(param !== undefined ? { param } : {}) };
  } catch {
    return {};
  }
}

/** param 字段没给时，从常见的报错措辞里猜一个参数名；认不出就不填 */
function guessParamFromMessage(message: string): string | undefined {
  const patterns = [
    /unrecognized (?:request )?(?:argument|parameter)(?: supplied)?:\s*['"]?([\w.]+)['"]?/i,
    /unknown parameter:?\s*['"]?([\w.]+)['"]?/i,
    /invalid (?:parameter|argument|value for)[:\s]+['"]?([\w.]+)['"]?/i,
  ];
  for (const re of patterns) {
    const m = re.exec(message);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

function errorFromBody(kind: ModelErrorKind, status: number, bodyHead: string): ModelError {
  const { message } = parseErrorBody(bodyHead);
  return { kind, status, ...(message !== undefined ? { serverMessage: redact(message).slice(0, 300) } : {}) };
}

function paramRejectedError(status: number, bodyHead: string): ModelError {
  const { message, param } = parseErrorBody(bodyHead);
  const suspectParam = param ?? (message !== undefined ? guessParamFromMessage(message) : undefined);
  return {
    kind: 'paramRejected',
    status,
    ...(message !== undefined ? { serverMessage: redact(message).slice(0, 300) } : {}),
    ...(suspectParam !== undefined ? { suspectParam } : {}),
  };
}

function classifyHead(head: HttpResponseHead): ModelError | undefined {
  const { status, contentType, bodyHead } = head;
  const looksHtml = contentType.toLowerCase().includes('text/html') || bodyHead.trimStart().startsWith('<');
  if (status === 200) return looksHtml ? { kind: 'htmlInsteadOfJson', status } : undefined;
  if (status === 0 || (status >= 300 && status < 400)) return { kind: 'redirected', status };
  if (status === 401 || status === 403) return errorFromBody('auth', status, bodyHead);
  if (status === 404 || status === 405) return errorFromBody('notFound', status, bodyHead);
  if (status === 400) return paramRejectedError(status, bodyHead);
  if (status === 429) return errorFromBody('rateLimited', status, bodyHead);
  if (status >= 500) return errorFromBody('server', status, bodyHead);
  if (status >= 200 && status < 300) return undefined;
  return errorFromBody('badResponse', status, bodyHead);
}

// ───────────── 流 / 整段响应 → 事件 ─────────────

const FINISH_MAP: Readonly<Record<string, FinishReason>> = {
  stop: 'stop',
  length: 'length',
  content_filter: 'contentFilter',
};

function finishEvent(raw: string): StreamEvent {
  const reason = FINISH_MAP[raw];
  return reason ? { kind: 'finish', reason } : { kind: 'finish', reason: 'other', rawReason: raw };
}

function usageFrom(u: Record<string, unknown>): Usage {
  const usage: Usage = {};
  if (typeof u.prompt_tokens === 'number') usage.inputTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') usage.outputTokens = u.completion_tokens;
  const details = u.completion_tokens_details as Record<string, unknown> | undefined;
  if (details && typeof details.reasoning_tokens === 'number')
    usage.reasoningTokens = details.reasoning_tokens;
  return usage;
}

/** 流中明确给出的 error 对象：按服务端报错处理，message 脱敏限长 */
function errorFromStreamObject(errObj: Record<string, unknown>): ModelError {
  const message = typeof errObj.message === 'string' ? errObj.message : undefined;
  return {
    kind: 'server',
    ...(message !== undefined ? { serverMessage: redact(message).slice(0, 300) } : {}),
  };
}

/** 一个 chat.completion(.chunk) 对象里能抽出的事件；field 流式用 delta，整段用 message */
function eventsFromChoiceBody(obj: Record<string, unknown>, field: 'delta' | 'message'): StreamEvent[] {
  if (obj.error && typeof obj.error === 'object') {
    return [{ kind: 'error', error: errorFromStreamObject(obj.error as Record<string, unknown>) }];
  }
  const events: StreamEvent[] = [];
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  if (choice) {
    const part = (choice[field] ?? {}) as Record<string, unknown>;
    const reasoning = part.reasoning_content ?? part.reasoning;
    if (typeof reasoning === 'string' && reasoning !== '')
      events.push({ kind: 'reasoning', text: reasoning });
    if (typeof part.content === 'string' && part.content !== '')
      events.push({ kind: 'text', text: part.content });
    if (typeof choice.finish_reason === 'string') events.push(finishEvent(choice.finish_reason));
  }
  if (obj.usage && typeof obj.usage === 'object') {
    events.push({ kind: 'usage', usage: usageFrom(obj.usage as Record<string, unknown>) });
  }
  return events;
}

function createStreamParser(): StreamParser {
  const sse = createSseLineParser();
  // 流已有结论：正常收尾（[DONE] 或 finish_reason），或流里已给出错误。有结论时 end() 不再补 streamBroken
  let settled = false;

  return {
    push(chunk) {
      const events: StreamEvent[] = [];
      for (const { data } of sse.push(chunk)) {
        if (data === '[DONE]') {
          settled = true;
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // 解析不了的单个事件忽略，不是致命错误
        }
        if (typeof parsed !== 'object' || parsed === null) continue;
        for (const e of eventsFromChoiceBody(parsed as Record<string, unknown>, 'delta')) {
          if (e.kind === 'finish' || e.kind === 'error') settled = true;
          events.push(e);
        }
      }
      return events;
    },
    end() {
      sse.end();
      return settled ? [] : [{ kind: 'error', error: { kind: 'streamBroken' } }];
    },
  };
}

function parseWhole(body: string): StreamEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [{ kind: 'error', error: { kind: 'badResponse' } }];
  }
  if (typeof parsed !== 'object' || parsed === null)
    return [{ kind: 'error', error: { kind: 'badResponse' } }];
  return eventsFromChoiceBody(parsed as Record<string, unknown>, 'message');
}

function parseModelList(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const data = (parsed as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    const id = item && typeof item === 'object' ? (item as Record<string, unknown>).id : undefined;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

// ───────────── 适配器 ─────────────

export const chatCompletionsAdapter: ModelAdapter = {
  interfaceType: 'chatCompletions',

  buildChat(conn, req, opts): HttpRequest {
    return {
      url: chatUrl(conn.baseUrl),
      method: 'POST',
      headers: buildHeaders(conn),
      body: JSON.stringify(buildChatBody(conn, req, opts?.excludeParams)),
      redirect: MODEL_FETCH_REDIRECT,
    };
  },

  buildListModels(conn): HttpRequest {
    return {
      url: modelsUrl(conn.baseUrl),
      method: 'GET',
      headers: buildHeaders(conn),
      redirect: MODEL_FETCH_REDIRECT,
    };
  },

  classifyHead,
  createStreamParser,
  parseWhole,
  parseModelList,
};
