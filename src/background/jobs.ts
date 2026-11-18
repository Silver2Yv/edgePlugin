// 任务执行（5.5）：接单先写 storage.session 再发网络请求；增量按 deltaCoalesceMs 合并后按 seq 推给订阅者；
// 终态不可覆盖（canTransition）；进行中每 checkpointMs 写一次 storage.session，这同时让后台不被空闲回收。
// 本版本不接 IndexedDB：对话历史只在内存，任务热副本只在 storage.session。
import { defaultBudget } from '@/core/context/plan';
import { splitByJsonBytes } from '@/core/domain/bytes';
import { canTransition, isTerminal, JOB_LIMITS, type JobRecord, type JobState } from '@/core/domain/job';
import type { BackgroundToClient, ClientToBackground, RejectReason } from '@/core/domain/messages';
import type { Settings } from '@/core/domain/settings';
import type {
  ChatRequest,
  Connection,
  ModelAdapter,
  ModelError,
  ModelErrorKind,
  ModelRef,
  StreamEvent,
} from '@/core/llm/adapter';
import { type AskTurn, assembleAsk } from '@/core/prompt/ask';
import type { BackgroundDeps } from './deps';
import type { Hub } from './hub';
import type { Store, StoredSelection } from './store';

type AskMsg = Extract<ClientToBackground, { type: 'conv/ask' }>;
type Delta = Extract<BackgroundToClient, { type: 'conv/delta' }>;
type Reply = (msg: BackgroundToClient) => void;
type ClientError = { kind: ModelErrorKind; message: string };

interface Job {
  record: JobRecord;
  tabId: number;
  seq: number;
  /** 已推送的增量，断线重连时按 lastSeq 补发 */
  log: Delta[];
  controller: AbortController;
  answer: string;
  reasoning: string;
  pendingText: string;
  pendingReasoning: string;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  error: ClientError | undefined;
  /** 本轮用户消息全文，完成后记入历史 */
  userText: string;
  hasPageText: boolean;
  secrets: string[];
}

interface Conversation {
  id: string;
  tabId: number;
  turns: AskTurn[];
  revision: number;
  activeJobId: string | undefined;
}

/** 内存里最多保留的任务（含增量日志）；超出时丢最早的已终结任务 */
const MAX_JOBS = 50;
/** 错误正文最多读这么多来分类 */
const ERROR_BODY_CHARS = 16 * 1024;
const ERROR_MESSAGE_MAX = 300;

const ERROR_TEXT: Readonly<Record<ModelErrorKind, string>> = {
  htmlInsteadOfJson: '接口返回的是网页而不是数据，地址可能缺少 /v1',
  auth: 'Key 无效或被网关拒绝',
  notFound: '接口地址或接口类型不对',
  paramRejected: '有参数不被支持',
  redirected: '接口发生了重定向，按错误处理',
  network: '请求没有到达服务器',
  streamBroken: '生成中断',
  server: '服务端出错',
  rateLimited: '请求太频繁，被限流',
  badResponse: '接口返回的数据无法识别',
  timeout: '连接或首字超时',
  noContent: '模型没有返回正文',
  contextOverflow: '内容超过模型上下文上限',
  aborted: '请求已中止',
};

/** 界面看到的错误：已脱敏（Key、Bearer、sk- 开头的串）、限长 */
export function toClientError(err: ModelError, secrets: readonly string[]): ClientError {
  let message = ERROR_TEXT[err.kind];
  if (err.status !== undefined) message += `（${err.status}）`;
  if (err.netError) message += ` ${err.netError}`;
  if (err.serverMessage) message += `：${err.serverMessage}`;
  for (const s of secrets) if (s.length >= 4) message = message.split(s).join('***');
  message = message.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer ***').replace(/\bsk-[\w-]{6,}/g, 'sk-***');
  return { kind: err.kind, message: [...message].slice(0, ERROR_MESSAGE_MAX).join('') };
}

/** 优先用界面发来的模型（界面显示的就是实际发送的，J10）；它指向的连接不存在时退回默认模型 */
function resolveModel(s: Settings, wanted: ModelRef): { conn: Connection; model: ModelRef } | undefined {
  const pick = (ref: ModelRef | undefined) => {
    const conn = ref && s.connections.find((c) => c.id === ref.connectionId);
    return conn && ref ? { conn, model: { connectionId: ref.connectionId, model: ref.model } } : undefined;
  };
  return pick(wanted) ?? pick(s.defaultModel);
}

const thinkingParam = (t: AskMsg['thinking']): NonNullable<ChatRequest['thinking']> =>
  t === 'off' ? 'off' : { effort: t };

export type Jobs = ReturnType<typeof createJobs>;

export function createJobs(deps: BackgroundDeps, store: Store, hub: Hub) {
  const epoch = deps.newId();
  const jobs = new Map<string, Job>();
  const byRequest = new Map<string, string>();
  const conversations = new Map<string, Conversation>();

  /** 启动扫描（5.5）：上一个后台进程留下的未终结任务标 interrupted；同时恢复去重表 */
  const ready = (async () => {
    await store.setEpoch(epoch);
    for (const r of await store.allJobs()) {
      byRequest.set(r.clientRequestId, r.jobId);
      if (r.workerEpoch === epoch || isTerminal(r.state) || !canTransition(r.state, 'interrupted')) continue;
      await store.putJob({
        ...r,
        state: 'interrupted',
        interruptReason: 'workerRestarted',
        updatedAt: deps.now(),
      });
    }
  })();

  const jobStateMsg = (job: Job): BackgroundToClient => ({
    type: 'conv/jobState',
    jobId: job.record.jobId,
    state: job.record.state,
    attemptId: job.record.attemptId,
    ...(job.error ? { error: job.error } : {}),
  });

  function flush(job: Job): void {
    if (job.flushTimer !== undefined) clearTimeout(job.flushTimer);
    job.flushTimer = undefined;
    const split = (s: string) => (s ? splitByJsonBytes(s, JOB_LIMITS.maxFieldBytes) : []);
    const pieces = [
      ...split(job.pendingReasoning).map((reasoning) => ({ reasoning })),
      ...split(job.pendingText).map((text) => ({ text })),
    ];
    job.pendingText = '';
    job.pendingReasoning = '';
    const { jobId, messageId, attemptId } = job.record;
    for (const p of pieces) {
      const d: Delta = { type: 'conv/delta', jobId, messageId, attemptId, seq: ++job.seq, ...p };
      job.log.push(d);
      hub.toTab(job.tabId, d);
    }
  }

  function queueFlush(job: Job): void {
    job.flushTimer ??= setTimeout(() => flush(job), JOB_LIMITS.deltaCoalesceMs);
  }

  /** 同一次尝试内的迁移；终态之后一律拒绝（第一个到达的终态落定） */
  function transition(job: Job, to: JobState, patch: Partial<JobRecord> = {}): boolean {
    if (!canTransition(job.record.state, to)) return false;
    if (isTerminal(to)) flush(job);
    job.record = { ...job.record, ...patch, state: to, updatedAt: deps.now() };
    void store.putJob(job.record);
    hub.toTab(job.tabId, jobStateMsg(job));
    if (isTerminal(to)) {
      const conv = conversations.get(job.record.conversationId);
      if (conv?.activeJobId === job.record.jobId) conv.activeJobId = undefined;
      if (conv && to === 'completed') {
        conv.turns.push({ user: job.userText, assistant: job.answer, hasPageText: job.hasPageText });
        conv.revision++;
      }
    }
    return true;
  }

  function fail(job: Job, err: ModelError): void {
    if (isTerminal(job.record.state)) return;
    job.error = toClientError(err, job.secrets);
    transition(job, 'failed');
  }

  /** 处理解析出的事件；遇到流中错误返回 false */
  function consume(job: Job, events: readonly StreamEvent[]): boolean {
    for (const ev of events) {
      if (isTerminal(job.record.state)) return false;
      if (ev.kind === 'text') {
        job.answer += ev.text;
        job.pendingText += ev.text;
        queueFlush(job);
      } else if (ev.kind === 'reasoning') {
        job.reasoning += ev.text;
        job.pendingReasoning += ev.text;
        queueFlush(job);
      } else if (ev.kind === 'error') {
        fail(job, ev.error);
        return false;
      }
    }
    return true;
  }

  async function run(job: Job, conn: Connection, adapter: ModelAdapter, req: ChatRequest): Promise<void> {
    const signal = job.controller.signal;
    const http = adapter.buildChat(conn, { ...req, signal });
    // 检查点：进行中每 checkpointMs 写一次热副本；扩展接口调用会重置后台的空闲计时
    const checkpoint = setInterval(() => {
      if (isTerminal(job.record.state)) return;
      job.record = { ...job.record, updatedAt: deps.now() };
      void store.putJob(job.record);
    }, JOB_LIMITS.checkpointMs);
    try {
      // accepted → streaming：请求发出的那一刻，不等首字节
      transition(job, 'streaming', { requestSent: true });
      const res = await deps.fetch(http.url, {
        method: http.method,
        headers: { ...http.headers },
        body: http.body ?? null,
        redirect: http.redirect,
        signal,
      });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        return fail(job, { kind: 'redirected', status: res.status });
      }
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      const read = async (): Promise<string | undefined> => {
        if (!reader) return undefined;
        const r = await reader.read();
        return r.done ? undefined : decoder.decode(r.value, { stream: true });
      };
      // 先看响应头与正文开头（200 不等于成功）；错误正文通常很短，读完再分类
      let head = (await read()) ?? '';
      if (!res.ok) {
        for (
          let more = await read();
          more !== undefined && head.length < ERROR_BODY_CHARS;
          more = await read()
        )
          head += more;
      }
      const contentType = res.headers.get('content-type') ?? '';
      const headError = adapter.classifyHead({ status: res.status, contentType, bodyHead: head });
      if (headError) return fail(job, headError);
      if (!res.ok)
        return fail(job, { kind: res.status >= 500 ? 'server' : 'badResponse', status: res.status });

      if (req.stream && !/json/i.test(contentType)) {
        const parser = adapter.createStreamParser();
        for (let chunk: string | undefined = head; chunk !== undefined; chunk = await read()) {
          if (!consume(job, parser.push(chunk))) return;
        }
        if (!consume(job, [...parser.push(decoder.decode()), ...parser.end()])) return;
      } else {
        // 服务端忽略流式（或连接关了逐字输出）：整段处理
        let body = head;
        for (let more = await read(); more !== undefined; more = await read()) body += more;
        if (!consume(job, adapter.parseWhole(body + decoder.decode()))) return;
      }
      if (isTerminal(job.record.state)) return;
      if (!job.answer) return fail(job, { kind: 'noContent' });
      transition(job, 'completed');
    } catch {
      // 停止后中止请求会抛 AbortError：任务已是终态，忽略
      if (isTerminal(job.record.state)) return;
      fail(job, { kind: job.answer || job.reasoning ? 'streamBroken' : 'network' });
    } finally {
      clearInterval(checkpoint);
      // 提前结束（流中错误、分类失败）时释放连接；正常读完后中止没有效果
      job.controller.abort();
    }
  }

  function evict(): void {
    if (jobs.size <= MAX_JOBS) return;
    for (const [id, j] of jobs) {
      if (jobs.size <= MAX_JOBS) break;
      if (isTerminal(j.record.state)) jobs.delete(id);
    }
  }

  return {
    ready,
    epoch,

    /** 对话属于哪个标签页；不在内存里返回 undefined */
    ownerOf: (conversationId: string): number | undefined => conversations.get(conversationId)?.tabId,

    async ask(tabId: number, msg: AskMsg, reply: Reply): Promise<void> {
      await ready;
      const reject = (reason: RejectReason) =>
        reply({ type: 'conv/rejected', reason, refType: msg.type, refId: msg.clientRequestId });
      // 去重：同一个 clientRequestId 只接单一次，重复到达回已有任务
      const existing = byRequest.get(msg.clientRequestId);
      if (existing !== undefined) {
        const r = jobs.get(existing)?.record ?? (await store.getJob(existing));
        if (r) {
          reply({
            type: 'conv/accepted',
            clientRequestId: r.clientRequestId,
            jobId: r.jobId,
            messageId: r.messageId,
            conversationId: r.conversationId,
          });
        }
        return;
      }
      const jobId = deps.newId();
      byRequest.set(msg.clientRequestId, jobId);
      const refuse = (reason: RejectReason) => {
        byRequest.delete(msg.clientRequestId);
        reject(reason);
      };

      const known = msg.conversationId === undefined ? undefined : conversations.get(msg.conversationId);
      if (known && known.tabId !== tabId) return refuse('notOwner');
      // 同一对话正在生成时不排队、不自动停止（决策 062）
      if (known?.activeJobId !== undefined) return refuse('invalid');

      let selection: StoredSelection | undefined;
      if (msg.selectionRevision !== undefined) {
        selection = await store.getSelection(tabId);
        if (selection?.selectionRevision !== msg.selectionRevision) return refuse('invalid');
      }
      if (!selection && msg.text.trim() === '') return refuse('invalid');

      const loaded = await deps.loadSettings();
      if (!loaded.ok) return refuse('invalid');
      const settings = loaded.settings;
      const target = resolveModel(settings, msg.model);
      const adapter = target && deps.adapters[target.conn.interfaceType];
      if (!target || !adapter) return refuse('invalid');

      // 内存里没有的对话编号（后台重启后内存已清空）按新对话接手，历史从空开始
      const conv: Conversation = known ?? {
        id: msg.conversationId ?? deps.newId(),
        tabId,
        turns: [],
        revision: 0,
        activeJobId: undefined,
      };
      conversations.set(conv.id, conv);

      const now = deps.now();
      const contextSnapshotId = deps.newId();
      const assembly = assembleAsk({
        question: msg.text,
        ...(selection
          ? {
              selection: {
                text: selection.text,
                truncated: selection.truncated,
                originalLength: selection.originalLength,
              },
            }
          : {}),
        history: conv.turns,
        lengthTier: msg.lengthTier,
        language: settings.reply.language,
        thinking: msg.thinking,
        requestedContextTier: msg.contextTier,
        model: target.model,
        contextSnapshotId,
        budget: defaultBudget(undefined, settings.context),
      });
      const record: JobRecord = {
        jobId,
        clientRequestId: msg.clientRequestId,
        conversationId: conv.id,
        messageId: deps.newId(),
        attemptId: deps.newId(),
        attempt: 1,
        workerEpoch: epoch,
        revision: conv.revision,
        state: 'accepted',
        requestSent: false,
        acceptedAt: now,
        updatedAt: now,
      };
      const job: Job = {
        record,
        tabId,
        seq: 0,
        log: [],
        controller: new AbortController(),
        answer: '',
        reasoning: '',
        pendingText: '',
        pendingReasoning: '',
        flushTimer: undefined,
        error: undefined,
        userText: assembly.userText,
        hasPageText: selection !== undefined,
        secrets: [target.conn.apiKey, ...Object.values(target.conn.headers)],
      };
      jobs.set(jobId, job);
      conv.activeJobId = jobId;
      evict();

      // 先写热副本，再发网络请求（5.5）；写不进去就不发
      try {
        await store.putJob(record);
      } catch {
        jobs.delete(jobId);
        conv.activeJobId = undefined;
        return refuse('invalid');
      }
      conv.revision++;
      reply({
        type: 'conv/accepted',
        clientRequestId: msg.clientRequestId,
        jobId,
        messageId: record.messageId,
        conversationId: conv.id,
      });
      // 发送计划先于请求推给界面（规则 8）
      hub.toTab(tabId, { type: 'conv/plan', jobId, contextSnapshotId, plan: assembly.plan });
      void run(job, target.conn, adapter, {
        model: target.model.model,
        messages: assembly.messages,
        stream: target.conn.stream,
        thinking: thinkingParam(msg.thinking),
      });
    },

    /** 停止：先落定 stopped 再中止请求，之后到达的完成回调被忽略 */
    stop(tabId: number, jobId: string): RejectReason | undefined {
      const job = jobs.get(jobId);
      if (!job || job.tabId !== tabId) return 'notOwner';
      if (transition(job, 'stopped', { stopReason: 'user' })) job.controller.abort();
      return undefined;
    },

    /** 断线重连：补发 seq > lastSeq 的增量，再报当前状态 */
    async replay(tabId: number, resume: { jobId: string; lastSeq: number }, reply: Reply): Promise<void> {
      await ready;
      const job = jobs.get(resume.jobId);
      if (job) {
        if (job.tabId !== tabId) return;
        for (const d of job.log) if (d.seq > resume.lastSeq) reply(d);
        reply(jobStateMsg(job));
        return;
      }
      // 不在内存（后台重启过）：只能报热副本里的状态，增量已随旧进程丢失
      const r = await store.getJob(resume.jobId);
      if (r) reply({ type: 'conv/jobState', jobId: r.jobId, state: r.state, attemptId: r.attemptId });
    },

    forgetTab(tabId: number): void {
      for (const [id, c] of conversations) if (c.tabId === tabId) conversations.delete(id);
    },
  };
}
