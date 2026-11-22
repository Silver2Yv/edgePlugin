// 任务执行（5.5）：接单先写 storage.session 再发网络请求；增量按 deltaCoalesceMs 合并后按 seq 推给订阅者；
// 终态不可覆盖（canTransition）；进行中每 checkpointMs 写一次 storage.session，这同时让后台不被空闲回收。
// 本版本不接 IndexedDB：对话历史只在内存，任务热副本只在 storage.session。
import { toPageKey } from '@/core/context/page-key';
import { defaultBudget } from '@/core/context/plan';
import { splitByJsonBytes } from '@/core/domain/bytes';
import {
  canRetry,
  canTransition,
  isTerminal,
  JOB_LIMITS,
  type JobRecord,
  type JobState,
} from '@/core/domain/job';
import type { BackgroundToClient, ClientToBackground, RejectReason } from '@/core/domain/messages';
import type { Settings } from '@/core/domain/settings';
import { onPolicyChange } from '@/core/domain/site-policy';
import type {
  ChatRequest,
  Connection,
  ModelAdapter,
  ModelError,
  ModelErrorKind,
  ModelRef,
  StreamEvent,
  Usage,
} from '@/core/llm/adapter';
import { decideParamRetry } from '@/core/llm/param-retry';
import { type AskTurn, assembleAsk } from '@/core/prompt/ask';
import type { BackgroundDeps } from './deps';
import type { Hub } from './hub';
import type { Pages } from './pages';
import { loadQuirks, recordQuirk } from './quirk-store';
import type { Store, StoredSelection } from './store';

type AskMsg = Extract<ClientToBackground, { type: 'conv/ask' }>;
type Delta = Extract<BackgroundToClient, { type: 'conv/delta' }>;
type PlanMsg = Extract<BackgroundToClient, { type: 'conv/plan' }>;
type Reply = (msg: BackgroundToClient) => void;
type ClientError = { kind: ModelErrorKind; message: string };

interface Job {
  record: JobRecord;
  tabId: number;
  seq: number;
  /** 已推送的增量，断线重连时按 lastSeq 补发 */
  log: Delta[];
  /** 已推送的发送计划，新订阅者（侧边栏接手、转接）补发，引用渲染要用它的块号 */
  plan: PlanMsg | undefined;
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
  /** 用量（J9）：流里和整段响应里解析出的都在这累加；中转站没给就一直是 undefined，不编造 */
  usage: Usage | undefined;
  /** 参数自动重试去掉的参数（H7）；去掉的是语义敏感参数时界面必须能看到（5.8） */
  droppedParam: { param: string; semantic: boolean } | undefined;
  /** 重试（conv/retry）要重新发起同一份请求，这三样原样保留，不重新装配 */
  conn: Connection;
  adapter: ModelAdapter;
  /** 页面读取与装配在接单之后，装配完才有；装配前就被停掉的任务没有可重发的请求 */
  req: ChatRequest | undefined;
}

interface Conversation {
  id: string;
  tabId: number;
  turns: AskTurn[];
  revision: number;
  activeJobId: string | undefined;
  /** 最近一次接单的任务：新订阅者（侧边栏）从它续播 */
  lastJobId: string | undefined;
  /** 最近一次发问时标签页所在的页面（pageKey）。换了页面，不指定对话的订阅不再接上它 */
  pageKey: string | undefined;
  /** 上一次请求带了页面全文；下次不带时计划写明「已移除先前的全文」（5.9 降档） */
  lastFullPage: boolean;
}

/** 内存里最多保留的任务（含增量日志）；超出时丢最早的已终结任务 */
const MAX_JOBS = 50;
/** 错误正文最多读这么多来分类 */
const ERROR_BODY_CHARS = 16 * 1024;
const ERROR_MESSAGE_MAX = 300;

/** 只用来给网络诊断按主机名归因（H9）；解析不了就不监听、不归因 */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

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

export function createJobs(deps: BackgroundDeps, store: Store, hub: Hub, pages: Pages) {
  const epoch = deps.newId();
  const jobs = new Map<string, Job>();
  const byRequest = new Map<string, string>();
  const conversations = new Map<string, Conversation>();
  /** 标签页当前的对话：最近一次接单的那个。侧边栏不指定对话时显示它（5.4「显示当前页的对话」） */
  const currentByTab = new Map<number, string>();

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
    ...(job.usage ? { usage: job.usage } : {}),
    ...(job.droppedParam ? { droppedParam: job.droppedParam } : {}),
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
      } else if (ev.kind === 'usage') {
        // 增量合并：多数中转站只在最后一个块里给一次；个别可能分批给，字段按后到的覆盖
        job.usage = { ...job.usage, ...ev.usage };
      } else if (ev.kind === 'error') {
        fail(job, ev.error);
        return false;
      }
    }
    return true;
  }

  async function run(job: Job, conn: Connection, adapter: ModelAdapter, req: ChatRequest): Promise<void> {
    const signal = job.controller.signal;
    // 怪癖学习（AR-09）：这个连接 + 模型之前学到的、该预先不发的参数，这次请求起就不带
    let excludeParams = [...(await loadQuirks(conn, req.model))];
    // 参数自动重试（H7）：同一次尝试只允许发生一次，不无限重试
    let retriedParam = false;
    // 检查点：进行中每 checkpointMs 写一次热副本；扩展接口调用会重置后台的空闲计时
    const checkpoint = setInterval(() => {
      if (isTerminal(job.record.state)) return;
      job.record = { ...job.record, updatedAt: deps.now() };
      void store.putJob(job.record);
    }, JOB_LIMITS.checkpointMs);
    try {
      for (;;) {
        const http = adapter.buildChat(conn, { ...req, signal }, { excludeParams });
        const host = hostnameOf(http.url);
        if (host !== undefined) deps.netDiagnostics?.watch([host]);
        const attemptStartedAt = deps.now();
        // 连接超时（V-01 实测）：等响应头的阶段单独计时，拿到响应头后立即解除；首条内容之后的沉默不受此限
        let connectTimedOut = false;
        const connectTimer = setTimeout(() => {
          connectTimedOut = true;
          job.controller.abort();
        }, deps.askConnectTimeoutMs ?? JOB_LIMITS.connectTimeoutMs);
        // accepted → streaming：请求发出的那一刻，不等首字节；重试同一次尝试已在 streaming，no-op
        transition(job, 'streaming', { requestSent: true });
        let res: Response;
        try {
          res = await deps.fetch(http.url, {
            method: http.method,
            headers: { ...http.headers },
            body: http.body ?? null,
            redirect: http.redirect,
            signal,
          });
        } catch {
          clearTimeout(connectTimer);
          if (isTerminal(job.record.state)) return;
          if (connectTimedOut) return fail(job, { kind: 'timeout' });
          const netError = await deps.netDiagnostics?.netErrorFor(http.url, attemptStartedAt);
          fail(job, {
            kind: job.answer || job.reasoning ? 'streamBroken' : 'network',
            ...(netError ? { netError } : {}),
          });
          return;
        }
        clearTimeout(connectTimer);
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
        if (headError) {
          const decision = decideParamRetry(headError, {
            hasContent: job.answer !== '' || job.reasoning !== '',
            alreadyRetried: retriedParam,
          });
          if (decision) {
            retriedParam = true;
            excludeParams = [...excludeParams, decision.param];
            job.droppedParam = decision;
            continue; // 同一次尝试重新发起请求，不改变任务状态（仍是 streaming）
          }
          return fail(job, headError);
        }
        if (!res.ok)
          return fail(job, { kind: res.status >= 500 ? 'server' : 'badResponse', status: res.status });
        // 去掉参数后这次请求被接受：记入怪癖表，这个连接 + 模型 + 配置版本的后续请求预先不发
        if (retriedParam && job.droppedParam) void recordQuirk(conn, req.model, job.droppedParam.param);

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
        return;
      }
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

    /**
     * 订阅要接上的对话与任务：指定了对话就用它（须属于这个标签页）；否则用标签页当前的对话，
     * 但标签页已换到别的页面（pageKey 不同）时不接（新页面不显示旧页面的回答）。
     * 对话不在内存（后台重启过、或从没发过问）时返回 undefined
     */
    current(
      tabId: number,
      conversationId: string | undefined,
      pageKey: string | undefined,
    ): { conversationId: string; job?: { jobId: string; messageId: string } } | undefined {
      const id = conversationId ?? currentByTab.get(tabId);
      const conv = id === undefined ? undefined : conversations.get(id);
      if (!conv || conv.tabId !== tabId) return undefined;
      if (
        conversationId === undefined &&
        pageKey !== undefined &&
        conv.pageKey !== undefined &&
        conv.pageKey !== pageKey
      )
        return undefined;
      const j = conv.lastJobId === undefined ? undefined : jobs.get(conv.lastJobId);
      return {
        conversationId: conv.id,
        ...(j ? { job: { jobId: j.record.jobId, messageId: j.record.messageId } } : {}),
      };
    },

    /** 内存里的任务（属于这个标签页才给） */
    jobOf(tabId: number, jobId: string): { jobId: string; messageId: string } | undefined {
      const j = jobs.get(jobId);
      return j && j.tabId === tabId ? { jobId, messageId: j.record.messageId } : undefined;
    },

    /**
     * 同步补发：seq > fromSeq 的增量、发送计划、当前状态。调用方在同一个同步段里随后把端口登记为订阅者，
     * 中间没有 await，补发的与之后实时推送的不会交错、不会漏（侧边栏从 0 续播，6.4「无缝续上」）。
     * 任务不在内存返回 false
     */
    replayNow(tabId: number, jobId: string, fromSeq: number, reply: Reply): boolean {
      const job = jobs.get(jobId);
      if (!job || job.tabId !== tabId) return false;
      if (job.plan) reply(job.plan);
      for (const d of job.log) if (d.seq > fromSeq) reply(d);
      reply(jobStateMsg(job));
      return true;
    },

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
      const known = msg.conversationId === undefined ? undefined : conversations.get(msg.conversationId);
      const refuse = (reason: RejectReason) => {
        byRequest.delete(msg.clientRequestId);
        // 下面抢先占住的 activeJobId，在真正接单前的任何失败都要还回去
        if (known?.activeJobId === jobId) known.activeJobId = undefined;
        reject(reason);
      };

      if (known && known.tabId !== tabId) return refuse('notOwner');
      // 同一对话正在生成时不排队、不自动停止（决策 062）。下面到真正接单之间还有好几个 await
      // （取选区、读设置），先同步占住 activeJobId，关闭「两个界面同一对话几乎同时发问」的竞态窗口（V-03）
      if (known?.activeJobId !== undefined) return refuse('busy');
      if (known) known.activeJobId = jobId;

      let selection: StoredSelection | undefined;
      if (msg.selectionRevision !== undefined) {
        selection = await store.getSelection(tabId);
        if (selection?.selectionRevision !== msg.selectionRevision) return refuse('invalid');
      }
      if (!selection && msg.text.trim() === '') return refuse('invalid');

      const loaded = await deps.loadSettings();
      if (!loaded.ok) return refuse('invalid');
      const tabUrl = await deps.getTabUrl?.(tabId).catch(() => undefined);
      const pageKey = tabUrl === undefined ? undefined : toPageKey(tabUrl);
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
        lastJobId: undefined,
        pageKey,
        lastFullPage: false,
      };
      conversations.set(conv.id, conv);

      const now = deps.now();
      const contextSnapshotId = deps.newId();
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
        plan: undefined,
        controller: new AbortController(),
        answer: '',
        reasoning: '',
        pendingText: '',
        pendingReasoning: '',
        flushTimer: undefined,
        error: undefined,
        // 装配后填（页面读取在接单之后）
        userText: '',
        hasPageText: selection !== undefined,
        secrets: [target.conn.apiKey, ...Object.values(target.conn.headers)],
        usage: undefined,
        droppedParam: undefined,
        conn: target.conn,
        adapter,
        req: undefined,
      };
      jobs.set(jobId, job);
      conv.activeJobId = jobId;
      evict();
      const prevLastJobId = conv.lastJobId;
      conv.lastJobId = jobId;
      conv.pageKey = pageKey;
      const prevCurrent = currentByTab.get(tabId);
      currentByTab.set(tabId, conv.id);

      // 先写热副本，再发网络请求（5.5）；写不进去就不发
      try {
        await store.putJob(record);
      } catch {
        jobs.delete(jobId);
        conv.activeJobId = undefined;
        conv.lastJobId = prevLastJobId;
        if (prevCurrent === undefined) currentByTab.delete(tabId);
        else currentByTab.set(tabId, prevCurrent);
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
      // 同一标签页的其他界面（小窗、侧边栏）随之显示这个任务；这是在任何增量之前发出的
      hub.toTab(tabId, { type: 'conv/current', conversationId: conv.id, jobId, messageId: record.messageId });

      // 页面上下文（5.6、5.9）：接单之后、发请求之前读取。读取期间站点策略变了（设置页改了黑名单），
      // 这次请求取消（D-01：未发出的取消）；用户在读取期间点了停止，同样不再发出
      const ctx = await pages.prepare(tabId, msg.contextTier, selection, settings);
      const fresh = await deps.loadSettings();
      if (isTerminal(job.record.state)) return;
      if (!fresh.ok || pages.levelChanged(ctx, fresh.settings)) {
        deps.log('ask/policyChanged', { jobId });
        transition(job, 'stopped', { stopReason: 'policyChanged' });
        return;
      }
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
        ...(ctx.page ? { page: ctx.page } : {}),
        selectionBlockIds: ctx.selectionBlockIds,
        siteNoRead: ctx.siteNoRead,
        previousFullPage: conv.lastFullPage,
        extraNotes: ctx.notes,
      });
      conv.lastFullPage = assembly.sentFullPage;
      job.userText = assembly.userText;
      job.hasPageText = selection !== undefined || assembly.plan.pageRead;
      const { plan } = assembly;
      // 诊断日志只记计划的结构（档位、块号、覆盖率、版本），不记任何页面文字或问题
      deps.log('ask/plan', {
        jobId,
        requestedTier: msg.contextTier,
        contextTier: plan.contextTier,
        siteLevel: ctx.level,
        pageRead: plan.pageRead,
        sentBlockIds: plan.sentBlockIds,
        coverage: plan.coverage,
        contentVersion: plan.contentVersion,
        removedEarlierPageText: plan.removedEarlierPageText,
        droppedHistoryTurns: plan.droppedHistoryTurns,
        historyHasPageText: plan.historyHasPageText,
        estimatedInputTokens: plan.estimatedInputTokens,
        budget: plan.budget,
        model: plan.model,
        notes: plan.notes.length,
      });
      // 发送计划先于请求推给界面（规则 8）
      job.plan = { type: 'conv/plan', jobId, contextSnapshotId, plan };
      hub.toTab(tabId, job.plan);
      job.req = {
        model: target.model.model,
        messages: assembly.messages,
        stream: target.conn.stream,
        thinking: thinkingParam(msg.thinking),
      };
      void run(job, job.conn, job.adapter, job.req);
    },

    /** 停止：先落定 stopped 再中止请求，之后到达的完成回调被忽略 */
    stop(tabId: number, jobId: string): RejectReason | undefined {
      const job = jobs.get(jobId);
      if (!job || job.tabId !== tabId) return 'notOwner';
      if (transition(job, 'stopped', { stopReason: 'user' })) job.controller.abort();
      return undefined;
    },

    /**
     * 重试（V-03）：同一 jobId / messageId，开一次新尝试（新 attemptId），任务回到 accepted，
     * 原样重发上次装配好的请求（job.ts 文件头：不是新发问，不重新装配）。只对还在内存里、且处于
     * 可重试终态（failed / interrupted / stopped）的任务生效；跨后台重启后任务已不在内存，
     * 没有保存原始请求内容，退化为不可重试（notOwner），需要用户发起新一轮提问。
     */
    retry(tabId: number, jobId: string): RejectReason | undefined {
      const job = jobs.get(jobId);
      if (!job || job.tabId !== tabId) return 'notOwner';
      if (!canRetry(job.record.state)) return 'notAllowed';
      // 装配前就被停掉的（读页面时站点策略变了、用户停止）：没有请求可重发，要用户重新提问
      const req = job.req;
      if (req === undefined) return 'notAllowed';
      job.controller = new AbortController();
      job.answer = '';
      job.reasoning = '';
      job.pendingText = '';
      job.pendingReasoning = '';
      if (job.flushTimer !== undefined) clearTimeout(job.flushTimer);
      job.flushTimer = undefined;
      job.error = undefined;
      const { stopReason: _stopReason, interruptReason: _interruptReason, ...rest } = job.record;
      job.record = {
        ...rest,
        attemptId: deps.newId(),
        attempt: job.record.attempt + 1,
        state: 'accepted',
        requestSent: false,
        updatedAt: deps.now(),
      };
      const conv = conversations.get(job.record.conversationId);
      if (conv) conv.activeJobId = jobId;
      void store.putJob(job.record);
      hub.toTab(tabId, jobStateMsg(job));
      void run(job, job.conn, job.adapter, req);
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
      currentByTab.delete(tabId);
    },

    /** 站点策略变更（D-01）：已接单、尚未发出网络请求的任务取消（stopped，policyChanged）；已发出的继续 */
    cancelPending(): number {
      let n = 0;
      for (const job of jobs.values()) {
        if (isTerminal(job.record.state) || onPolicyChange(job.record.requestSent) !== 'cancel') continue;
        if (transition(job, 'stopped', { stopReason: 'policyChanged' })) {
          job.controller.abort();
          n++;
        }
      }
      return n;
    },
  };
}
