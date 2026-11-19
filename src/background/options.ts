// 设置页 / 欢迎页通道（runtime.sendMessage，5.12）：只有 options 角色能发这些消息，身份只取自
// sender（规则 7），每条消息先过 parseFrom，拒绝时无副作用。本模块不碰 Store，只读设置、按需发
// 一次最小探测请求（规则 1：只有后台发模型请求；规则 6：目标限定在用户登记的连接地址）。
import {
  type ConnectionTestResult,
  type EnsureLockedResult,
  type ListModelsResult,
  type OptionsToBackground,
  optionsToBackground,
  parseFrom,
  type RejectReason,
} from '@/core/domain/messages';
import type { Connection, HttpRequest, ModelAdapter, ModelError, StreamEvent } from '@/core/llm/adapter';
import type { BackgroundDeps, SenderLike } from './deps';
import { senderRole } from './roles';

export type OptionsResponse =
  | { ok: false; reason: RejectReason }
  | EnsureLockedResult
  | ConnectionTestResult
  | ListModelsResult;

const TEST_TIMEOUT_MS = 30_000;
const LIST_MODELS_TIMEOUT_MS = 15_000;
/** 非 200 的错误正文最多读这么多来分类（避免下载巨大的错误页） */
const ERROR_BODY_CHARS = 16 * 1024;
const REPLY_PREVIEW_CHARS = 200;
/** 测试连接用的最小对话：不设 max_tokens、不发思考字段——开思考时思考内容会把 max_tokens
 * 吃光，正文为空（网络诊断包实测），所以这里两者都不发 */
const PROBE_QUESTION = '请只回复 OK';

/** 只取错误名，不带消息里可能出现的地址（规则 6） */
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'Error');

const trimTrailingSlash = (s: string): string => (s.endsWith('/') ? s.slice(0, -1) : s);

type Read = () => Promise<string | undefined>;

function bodyReader(res: Response): Read {
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  return async () => {
    if (!reader) return undefined;
    const r = await reader.read();
    return r.done ? undefined : decoder.decode(r.value, { stream: true });
  };
}

/** 正文第一个网络块；!res.ok 时续读到 ERROR_BODY_CHARS 凑够分类用的错误信息（同 jobs.ts 的处理） */
async function readHead(res: Response, read: Read): Promise<string> {
  let head = (await read()) ?? '';
  if (!res.ok) {
    for (let more = await read(); more !== undefined && head.length < ERROR_BODY_CHARS; more = await read())
      head += more;
  }
  return head;
}

/** 续读剩余正文直到结束；只在 res.ok 且需要完整正文（解析模型列表、非流式整段）时才调用 */
async function readRest(read: Read, head: string): Promise<string> {
  let body = head;
  for (let more = await read(); more !== undefined; more = await read()) body += more;
  return body;
}

/** 发请求并按 controller 的超时中止；AbortError 按是否已超时区分 timeout / network */
async function fetchWithTimeout(
  deps: BackgroundDeps,
  http: HttpRequest,
  controller: AbortController,
): Promise<{ ok: true; res: Response } | { ok: false; error: ModelError }> {
  try {
    const res = await deps.fetch(http.url, {
      method: http.method,
      headers: { ...http.headers },
      body: http.body ?? null,
      redirect: http.redirect,
      signal: controller.signal,
    });
    return { ok: true, res };
  } catch (e) {
    if (controller.signal.aborted) return { ok: false, error: { kind: 'timeout' } };
    return { ok: false, error: { kind: 'network', serverMessage: errName(e) } };
  }
}

/**
 * htmlInsteadOfJson 时探测 baseUrl + '/v1'：只探测这一个地址，不做别的猜测（5.8 响应校验链）。
 * baseUrl 本就以 /v1 结尾，或探测失败、拿不到模型，一律返回 undefined（不否定已有的错误）。
 */
async function probeV1(
  deps: BackgroundDeps,
  conn: Connection,
  adapter: ModelAdapter,
): Promise<string | undefined> {
  const base = trimTrailingSlash(conn.baseUrl);
  if (base.endsWith('/v1')) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.listModelsTimeoutMs ?? LIST_MODELS_TIMEOUT_MS);
  try {
    const probeConn: Connection = { ...conn, baseUrl: `${base}/v1` };
    const got = await fetchWithTimeout(deps, adapter.buildListModels(probeConn), controller);
    if (!got.ok) return undefined;
    const read = bodyReader(got.res);
    const contentType = got.res.headers.get('content-type') ?? '';
    let body: string;
    try {
      const head = await readHead(got.res, read);
      if (adapter.classifyHead({ status: got.res.status, contentType, bodyHead: head }) || !got.res.ok)
        return undefined;
      body = await readRest(read, head);
    } catch {
      return undefined;
    }
    return adapter.parseModelList(body).length > 0 ? probeConn.baseUrl : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** 只支持 chatCompletions（这一轮）；连接不存在或接口类型不支持时返回对应的 badResponse */
function resolveConnection(
  settings: { connections: readonly Connection[] } | undefined,
  connectionId: string,
  deps: BackgroundDeps,
): { conn: Connection; adapter: ModelAdapter } | { error: ModelError } {
  const conn = settings?.connections.find((c) => c.id === connectionId);
  if (!conn) return { error: { kind: 'badResponse', serverMessage: '连接不存在，请先保存' } };
  const adapter = conn.interfaceType === 'chatCompletions' ? deps.adapters.chatCompletions : undefined;
  if (!adapter) return { error: { kind: 'badResponse', serverMessage: '暂不支持该接口类型' } };
  return { conn, adapter };
}

async function ensureLocked(deps: BackgroundDeps): Promise<EnsureLockedResult> {
  try {
    await deps.lockStorage();
    return { locked: true };
  } catch (e) {
    deps.log('settings/ensureLockedFailed', { error: errName(e) });
    return { locked: false };
  }
}

async function testConnection(
  deps: BackgroundDeps,
  msg: Extract<OptionsToBackground, { type: 'connection/test' }>,
): Promise<ConnectionTestResult> {
  const start = deps.now();
  const loaded = await deps.loadSettings();
  const resolved = resolveConnection(loaded.ok ? loaded.settings : undefined, msg.connectionId, deps);
  if ('error' in resolved) return { ok: false, error: resolved.error, elapsedMs: deps.now() - start };
  const { conn, adapter } = resolved;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.connectionTestTimeoutMs ?? TEST_TIMEOUT_MS);
  try {
    const http = adapter.buildChat(conn, {
      model: msg.model,
      messages: [{ role: 'user', content: [{ kind: 'text', text: PROBE_QUESTION }] }],
      stream: conn.stream,
      signal: controller.signal,
    });
    const got = await fetchWithTimeout(deps, http, controller);
    if (!got.ok) return { ok: false, error: got.error, elapsedMs: deps.now() - start };
    const res = got.res;
    const read = bodyReader(res);

    let head: string;
    try {
      head = await readHead(res, read);
    } catch (e) {
      const error: ModelError = controller.signal.aborted
        ? { kind: 'timeout' }
        : { kind: 'network', serverMessage: errName(e) };
      return { ok: false, error, elapsedMs: deps.now() - start };
    }
    // 先看响应头与正文开头，200 不等于成功
    const contentType = res.headers.get('content-type') ?? '';
    const headError = adapter.classifyHead({ status: res.status, contentType, bodyHead: head });
    if (headError) {
      const suggestedBaseUrl =
        headError.kind === 'htmlInsteadOfJson' ? await probeV1(deps, conn, adapter) : undefined;
      return {
        ok: false,
        error: headError,
        elapsedMs: deps.now() - start,
        ...(suggestedBaseUrl ? { suggestedBaseUrl } : {}),
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: { kind: res.status >= 500 ? 'server' : 'badResponse', status: res.status },
        elapsedMs: deps.now() - start,
      };
    }

    let replyText = '';
    let reasoningSeen = false;
    let streamError: ModelError | undefined;
    const consume = (events: readonly StreamEvent[]): void => {
      for (const ev of events) {
        if (ev.kind === 'reasoning') reasoningSeen = true;
        else if (ev.kind === 'text') replyText += ev.text;
        else if (ev.kind === 'error') streamError = ev.error;
      }
    };
    try {
      if (conn.stream && !/json/i.test(contentType)) {
        const parser = adapter.createStreamParser();
        consume(parser.push(head));
        // 收到首段正文（或流中错误）就不必再等，提前结束——不读到流结束
        while (replyText === '' && !streamError) {
          const chunk = await read();
          if (chunk === undefined) break;
          consume(parser.push(chunk));
        }
      } else {
        consume(adapter.parseWhole(await readRest(read, head)));
      }
    } catch (e) {
      const error: ModelError = controller.signal.aborted
        ? { kind: 'timeout' }
        : { kind: 'network', serverMessage: errName(e) };
      return { ok: false, error, elapsedMs: deps.now() - start };
    }
    if (streamError) return { ok: false, error: streamError, elapsedMs: deps.now() - start };
    if (replyText === '') return { ok: false, error: { kind: 'noContent' }, elapsedMs: deps.now() - start };
    return {
      ok: true,
      model: msg.model,
      reply: [...replyText].slice(0, REPLY_PREVIEW_CHARS).join(''),
      elapsedMs: deps.now() - start,
      reasoning: reasoningSeen,
    };
  } finally {
    clearTimeout(timer);
    // 收到首段正文（或已判定失败）就中止请求（5.8）；正常读完后中止没有效果
    controller.abort();
  }
}

async function listModels(
  deps: BackgroundDeps,
  msg: Extract<OptionsToBackground, { type: 'connection/listModels' }>,
): Promise<ListModelsResult> {
  const loaded = await deps.loadSettings();
  const resolved = resolveConnection(loaded.ok ? loaded.settings : undefined, msg.connectionId, deps);
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const { conn, adapter } = resolved;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.listModelsTimeoutMs ?? LIST_MODELS_TIMEOUT_MS);
  try {
    const got = await fetchWithTimeout(deps, adapter.buildListModels(conn), controller);
    if (!got.ok) return { ok: false, error: got.error };
    const res = got.res;
    const read = bodyReader(res);
    let head: string;
    try {
      head = await readHead(res, read);
    } catch (e) {
      return {
        ok: false,
        error: controller.signal.aborted
          ? { kind: 'timeout' }
          : { kind: 'network', serverMessage: errName(e) },
      };
    }
    const contentType = res.headers.get('content-type') ?? '';
    const headError = adapter.classifyHead({ status: res.status, contentType, bodyHead: head });
    if (headError) {
      const suggestedBaseUrl =
        headError.kind === 'htmlInsteadOfJson' ? await probeV1(deps, conn, adapter) : undefined;
      return { ok: false, error: headError, ...(suggestedBaseUrl ? { suggestedBaseUrl } : {}) };
    }
    if (!res.ok) {
      return { ok: false, error: { kind: res.status >= 500 ? 'server' : 'badResponse', status: res.status } };
    }
    let body: string;
    try {
      body = await readRest(read, head);
    } catch (e) {
      return {
        ok: false,
        error: controller.signal.aborted
          ? { kind: 'timeout' }
          : { kind: 'network', serverMessage: errName(e) },
      };
    }
    return { ok: true, models: adapter.parseModelList(body) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function createOptions(deps: BackgroundDeps) {
  return async function onMessage(raw: unknown, sender: SenderLike): Promise<OptionsResponse> {
    const role = senderRole(sender, deps.self);
    if (role !== 'options') {
      deps.log('options/rejected', { reason: 'notAllowed', role });
      return { ok: false, reason: 'notAllowed' };
    }
    const parsed = parseFrom(role, optionsToBackground, raw);
    if (!parsed.ok) {
      deps.log('options/rejected', {
        reason: parsed.reason,
        ...(parsed.detail ? { detail: parsed.detail } : {}),
      });
      return { ok: false, reason: parsed.reason };
    }
    switch (parsed.msg.type) {
      case 'settings/ensureLocked':
        return ensureLocked(deps);
      case 'connection/test':
        return testConnection(deps, parsed.msg);
      case 'connection/listModels':
        return listModels(deps, parsed.msg);
    }
  };
}
