// 任务执行（5.5）：接单先持久化再发网络请求；增量按 deltaCoalesceMs 合并后按 seq 推给订阅者；
// 终态不可覆盖（canTransition）；进行中每 checkpointMs 写一次 storage.session，这同时让后台不被空闲回收。
//
// 对话落库（5.5、5.11）：
// | 时机 | 写什么 |
// | 接单 | 一个事务：对话（新建或更新轮数、修订号）、用户消息（问题、选区与锚点、档位）、占位助手消息（accepted）；提交后才写 session 热副本、回 conv/accepted、发请求。写不进去就拒绝（storageFailed），不发请求 |
// | 装配后 | 用户消息补上当时实际发送的全文（sentText）、助手消息补上发送计划；页面记录（PageRecord）；带了页面块时写一条快照（7 天到期） |
// | 生成中 | 每 checkpointMs 把已生成的部分写进库（有新内容才写），后台被回收后留下的是最近一次检查点 |
// | 终态 | 正文、思考、状态与原因、错误、计划、实际模型、用量；「总结本页」完成时记进 PageRecord.lastSummary。重试一次仍失败推 conv/saveFailed |
// 写库按调用顺序排队（persist），同一条消息的写入不会乱序；读库前先等排队的写完。
//
// 对话属于页面（pageKey），不属于标签页（5.11、D12）。不指定对话的发问与订阅按续接规则（D13，core/domain/conversation.ts）
// 找该页最近的对话。后台重启后对话与历史从库里重建，续接照常带历史；跨重启重试仍不支持（决策 070，不落盘原始请求）。
import { toPageKey } from '@/core/context/page-key';
import { defaultBudget } from '@/core/context/plan';
import type { ActionId } from '@/core/domain/actions';
import { splitByJsonBytes } from '@/core/domain/bytes';
import {
  continuation,
  conversationTitle,
  type NewConversationReason,
  snapshotBatches,
  turnsFromMessages,
} from '@/core/domain/conversation';
import {
  canRetry,
  canTransition,
  isTerminal,
  JOB_LIMITS,
  type JobRecord,
  type JobState,
} from '@/core/domain/job';
import type { BackgroundToClient, ClientToBackground, RejectReason } from '@/core/domain/messages';
import {
  type ConversationRecord,
  type MessageRecord,
  type PageRecord,
  SNAPSHOT_TTL_MS,
  type SnapshotRecord,
} from '@/core/domain/records';
import type { Settings } from '@/core/domain/settings';
import { onPolicyChange } from '@/core/domain/site-policy';
import type {
  ChatRequest,
  Connection,
  FinishReason,
  ModelAdapter,
  ModelError,
  ModelErrorKind,
  ModelRef,
  StreamEvent,
  Usage,
} from '@/core/llm/adapter';
import { effectiveCapabilities } from '@/core/llm/capabilities';
import { decideParamRetry } from '@/core/llm/param-retry';
import { type AskTurn, assembleAsk, resolveActionDef } from '@/core/prompt/ask';
import type { DbWrites } from '@/platform/conv-db';
import type { Capture, TakenCapture } from './capture';
import type { BackgroundDeps } from './deps';
import type { Hub } from './hub';
import type { PageContext, Pages } from './pages';
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
  usage?: Usage;
  /** 参数自动重试去掉的参数（H7）；去掉的是语义敏感参数时界面必须能看到（5.8） */
  droppedParam?: { param: string; semantic: boolean };
  /** 重试（conv/retry）要重新发起同一份请求，这三样原样保留，不重新装配 */
  conn: Connection;
  adapter: ModelAdapter;
  /** 页面读取与装配在接单之后，装配完才有；装配前就被停掉的任务没有可重发的请求 */
  req: ChatRequest | undefined;
  /** 结束原因（同上，有值就写进助手消息） */
  finishReason?: FinishReason;
  /** 发问的动作；summarizePage 完成时记进 PageRecord.lastSummary */
  actionId: string;
  /** 实际使用的模型（J10），写进助手消息 */
  model: ModelRef;
  /** 库里的用户消息（装配后补上 sentText） */
  userMessage: MessageRecord;
  /** 库里助手消息的固定部分；状态、正文等每次写库时按任务当前状态填（assistantRecord） */
  baseMessage: MessageRecord;
  /** 上次检查点写库时的正文与思考长度：没有新内容就不写 */
  savedChars: number;
  checkpointTimer: ReturnType<typeof setInterval> | undefined;
}

/** 对话的内存副本（真相在库里）：装配用的历史、下一条消息的序号、进行中的任务 */
interface ConvState {
  record: ConversationRecord;
  turns: AskTurn[];
  nextOrdinal: number;
  /** 上一次请求带了页面全文；下次不带时计划写明「已移除先前的全文」（5.9 降档） */
  lastFullPage: boolean;
  activeJobId: string | undefined;
}

/**
 * 发问时对话不属于标签页当前页面怎么办（5.12，见 messages.ts conv/ask 的 conversationId）：
 * reject 拒绝（侧边栏，用户明确选的对话不悄悄换掉）；fallback 当作没指定，按续接规则（小窗：单页应用换了地址）
 */
export interface AskOptions {
  otherPage?: 'reject' | 'fallback';
}

/** 订阅能看哪些对话：page 只能看标签页当前页面的（小窗）；any 任意历史对话（侧边栏） */
export type ViewScope = 'page' | 'any';

type Accepted = {
  job: Job;
  conv: ConvState;
  selection: StoredSelection | undefined;
  settings: Settings;
  target: { conn: Connection; model: ModelRef };
  pageKey: string | undefined;
  contextSnapshotId: string;
  newConversation: NewConversationReason | undefined;
  /** 这一问附带的截图（5.13）：已随接单事务写进库，装配时作为图片部分发送 */
  image: TakenCapture | undefined;
};

/** 内存里最多保留的任务（含增量日志）；超出时丢最早的已终结任务 */
const MAX_JOBS = 50;
/** 内存里最多保留的对话副本；超出时丢最早的、没有进行中任务的 */
const MAX_CONVS = 50;
/** 启动扫描等数据库的上限：库打不开时不能让后台一直不接单 */
const STARTUP_DB_MS = 5000;
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

export function createJobs(deps: BackgroundDeps, store: Store, hub: Hub, pages: Pages, capture?: Capture) {
  const db = deps.db;
  const epoch = deps.newId();
  const jobs = new Map<string, Job>();
  const byRequest = new Map<string, string>();
  /** 对话的内存副本（按最近使用排序）；真相在库里，不在就从库里重建 */
  const convs = new Map<string, ConvState>();
  /** 对话最近一次接单的任务（在内存里的）：订阅者从它续播 */
  const lastJobByConv = new Map<string, string>();
  /** 没有 pageKey 的页面（非 http(s)）按标签页记最近的对话，只在本进程内续接 */
  const lastConvByTab = new Map<number, string>();
  /** 删掉的对话：它在内存里的任务不再写库、不能重试 */
  const deleted = new Set<string>();

  // 写库排队：按调用顺序一个接一个执行，同一条消息的检查点与终态不会乱序；读库前先等它（settled）
  let writes: Promise<unknown> = Promise.resolve();
  function persist<T>(fn: () => Promise<T>): Promise<T> {
    const p = writes.then(fn);
    writes = p.catch(() => undefined);
    return p;
  }
  const settled = () => writes.then(() => undefined);

  // 接单排队：选对话、查忙、落库在一个接一个的段里做完，两个界面几乎同时发问不会都接上同一个对话（V-03）
  let accepting: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = accepting.then(fn);
    accepting = p.catch(() => undefined);
    return p;
  }

  /** 对话的更新时间：同一进程内严格递增，历史分页的 before 游标不会因同一毫秒漏掉 */
  let lastStamp = 0;
  const stamp = () => {
    lastStamp = Math.max(deps.now(), lastStamp + 1);
    return lastStamp;
  };

  const errName = (e: unknown) => (e instanceof Error ? e.name : 'unknown');

  /** 启动扫描（5.5）：上一个后台进程留下的未终结任务标 interrupted；同时恢复去重表 */
  const ready = (async () => {
    await store.setEpoch(epoch);
    const sessionJobs = new Set<string>();
    for (const r of await store.allJobs()) {
      byRequest.set(r.clientRequestId, r.jobId);
      sessionJobs.add(r.jobId);
      if (r.workerEpoch === epoch || isTerminal(r.state) || !canTransition(r.state, 'interrupted')) continue;
      await store.putJob({
        ...r,
        state: 'interrupted',
        interruptReason: 'workerRestarted',
        updatedAt: deps.now(),
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), STARTUP_DB_MS);
    });
    await Promise.race([scanDb(sessionJobs), timeout])
      .catch((e: unknown) =>
        deps.log('db/startupFailed', { error: e instanceof Error ? e.message : 'unknown' }),
      )
      .finally(() => clearTimeout(timer));
  })();

  /**
   * 库里的启动扫描（5.5）：accepted / streaming 的助手消息都不属于这个刚启动的进程，标 interrupted——
   * session 里有它的任务记录是旧进程被回收（workerRestarted），没有（浏览器重启清空了 session）是结果未知
   * （unknownOnStartup）。界面据此提示「上次请求的结果未知」。顺带清掉到期且无人引用的快照（5.11）
   */
  async function scanDb(sessionJobs: ReadonlySet<string>): Promise<void> {
    const stale = (await db.messagesWithStatus(['accepted', 'streaming'])).filter(
      (m) => m.role === 'assistant',
    );
    const byConv = new Map<string, MessageRecord[]>();
    for (const m of stale) byConv.set(m.conversationId, [...(byConv.get(m.conversationId) ?? []), m]);
    for (const [id, msgs] of byConv) {
      const now = deps.now();
      const c = await db.getConversation(id);
      const marked = msgs.map(
        (m): MessageRecord => ({
          ...m,
          status: 'interrupted',
          interruptReason:
            m.jobId !== undefined && sessionJobs.has(m.jobId) ? 'workerRestarted' : 'unknownOnStartup',
          updatedAt: now,
        }),
      );
      await persist(() =>
        db.write({ messages: marked, ...(c ? { conversations: [{ ...c, revision: c.revision + 1 }] } : {}) }),
      );
    }
    const purged = await persist(() => db.purgeExpiredSnapshots(deps.now()));
    if (stale.length > 0 || purged > 0)
      deps.log('db/startup', { interrupted: stale.length, purgedSnapshots: purged });
  }

  function remember(c: ConvState): void {
    convs.delete(c.record.id);
    convs.set(c.record.id, c);
    for (const [id, x] of convs) {
      if (convs.size <= MAX_CONVS) break;
      if (x.activeJobId === undefined) convs.delete(id);
    }
  }

  /** 对话的内存副本；不在内存就从库里重建（历史、序号、上次是否带了全文）。库里没有返回 undefined */
  async function loadConv(id: string): Promise<ConvState | undefined> {
    const hit = convs.get(id);
    if (hit) return hit;
    await settled();
    const record = await db.getConversation(id);
    if (!record) return undefined;
    const messages = await db.getMessages(id);
    const again = convs.get(id);
    if (again) return again;
    const c: ConvState = { record, ...turnsFromMessages(messages), activeJobId: undefined };
    remember(c);
    return c;
  }

  /** 该页最近的对话（不论是否合续接规则） */
  async function recentFor(tabId: number, pageKey: string | undefined): Promise<ConvState | undefined> {
    if (pageKey === undefined) {
      const id = lastConvByTab.get(tabId);
      return id === undefined ? undefined : loadConv(id);
    }
    await settled();
    const r = await db.latestConversation(pageKey);
    return r ? loadConv(r.id) : undefined;
  }

  /**
   * 这个标签页能不能接着这个对话（5.12）：对话属于标签页当前的页面；或本进程里它最近的任务就在这个标签页上
   * （单页应用换了地址，界面还显示着这个对话）
   */
  function mayContinue(c: ConversationRecord, tabId: number, pageKey: string | undefined): boolean {
    if (pageKey !== undefined && c.pageKey === pageKey) return true;
    const j = lastJobByConv.get(c.id);
    return j !== undefined && jobs.get(j)?.tabId === tabId;
  }

  /** 助手消息此刻的完整记录：固定部分 + 任务当前的状态、正文、思考、原因、计划、用量 */
  function assistantRecord(job: Job): MessageRecord {
    const r = job.record;
    const { plan } = job;
    return {
      ...job.baseMessage,
      attemptId: r.attemptId,
      segments: job.answer ? [{ kind: 'text', text: job.answer }] : [],
      ...(job.reasoning ? { reasoning: job.reasoning } : {}),
      status: r.state === 'idle' ? 'accepted' : r.state,
      ...(job.finishReason ? { finishReason: job.finishReason } : {}),
      ...(r.stopReason ? { stopReason: r.stopReason } : {}),
      ...(r.interruptReason ? { interruptReason: r.interruptReason } : {}),
      ...(job.error ? { error: job.error } : {}),
      model: job.model,
      ...(job.usage ? { usage: job.usage } : {}),
      ...(plan ? { plan: plan.plan, contextSnapshotId: plan.contextSnapshotId } : {}),
      updatedAt: deps.now(),
    };
  }

  /** 生成中的检查点写库：有新内容才写 */
  function startCheckpoint(job: Job): void {
    if (job.checkpointTimer !== undefined) return;
    job.checkpointTimer = setInterval(() => {
      const n = job.answer.length + job.reasoning.length;
      if (n === job.savedChars || deleted.has(job.record.conversationId)) return;
      job.savedChars = n;
      void persist(() => db.write({ messages: [assistantRecord(job)] })).catch((e: unknown) =>
        deps.log('db/checkpointFailed', { error: errName(e) }),
      );
    }, JOB_LIMITS.checkpointMs);
  }

  function stopCheckpoint(job: Job): void {
    if (job.checkpointTimer !== undefined) clearInterval(job.checkpointTimer);
    job.checkpointTimer = undefined;
  }

  /**
   * 终态写库：用户消息、助手消息、对话（修订号加一）；「总结本页」完成时更新 PageRecord.lastSummary。
   * 失败重试一次；仍失败告诉界面这一轮没存进历史（conv/saveFailed）
   */
  async function saveTerminal(job: Job): Promise<void> {
    const { conversationId, jobId, messageId } = job.record;
    if (deleted.has(conversationId)) return;
    const conv = convs.get(conversationId);
    if (conv) conv.record = { ...conv.record, revision: conv.record.revision + 1, updatedAt: stamp() };
    const write = () =>
      persist(async () => {
        const w: DbWrites = {
          messages: [job.userMessage, assistantRecord(job)],
          ...(conv ? { conversations: [conv.record] } : {}),
        };
        const plan = job.plan?.plan;
        if (
          job.actionId === 'summarizePage' &&
          job.record.state === 'completed' &&
          plan?.pageKey &&
          plan.contentVersion
        ) {
          const page = await db.getPage(plan.pageKey);
          w.pages = [
            {
              ...(page ?? pageRecordOf(plan.pageKey, '', undefined)),
              updatedAt: deps.now(),
              lastSummary: { messageId, contentVersion: plan.contentVersion },
            },
          ];
        }
        await db.write(w);
      });
    try {
      await write();
    } catch {
      try {
        await write();
      } catch (e) {
        deps.log('db/saveFailed', { jobId, error: errName(e) });
        hub.toTab(job.tabId, { type: 'conv/saveFailed', jobId, messageId });
      }
    }
  }

  /** 页面记录：地址记规范化后的（pageKey 去掉了跟踪参数与非路由锚点），标题没读到就沿用旧的 */
  function pageRecordOf(pageKey: string, title: string, old: PageRecord | undefined): PageRecord {
    let host = '';
    try {
      host = new URL(pageKey).hostname;
    } catch {
      // pageKey 一定是合法的 http(s) 地址；保险起见
    }
    return {
      pageKey,
      host,
      url: pageKey,
      title: title || old?.title || '',
      updatedAt: deps.now(),
      ...(old?.lastSummary ? { lastSummary: old.lastSummary } : {}),
    };
  }

  /** 装配后写库：用户消息的实际发送全文、助手消息的计划、页面记录、实际发送的块（快照）。失败只记日志，终态再写一次消息 */
  function saveAssembly(job: Job, ctx: PageContext, a: Accepted): void {
    const plan = job.plan?.plan;
    const page = ctx.page;
    const now = deps.now();
    let snapshot: SnapshotRecord | undefined;
    if (plan && page && plan.sentBlockIds.length > 0) {
      const byId = new Map(page.blocks.map((b) => [b.id, b.text]));
      snapshot = {
        id: a.contextSnapshotId,
        conversationId: job.record.conversationId,
        pageKey: page.pageKey,
        contentVersion: page.contentVersion,
        blocks: plan.sentBlockIds.map((id) => ({ id, text: byId.get(id) ?? '' })),
        refCount: 0,
        expiresAt: now + SNAPSHOT_TTL_MS,
      };
    }
    void persist(async () => {
      if (deleted.has(job.record.conversationId)) return;
      const w: DbWrites = { messages: [job.userMessage, assistantRecord(job)] };
      if (a.pageKey !== undefined) {
        const old = await db.getPage(a.pageKey);
        w.pages = [pageRecordOf(a.pageKey, page?.title ?? '', old)];
      }
      if (snapshot) w.snapshots = [snapshot];
      await db.write(w);
    }).catch((e: unknown) => deps.log('db/assemblyFailed', { error: errName(e) }));
  }

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
    if (to === 'streaming') startCheckpoint(job);
    if (isTerminal(to)) {
      stopCheckpoint(job);
      const conv = convs.get(job.record.conversationId);
      if (conv?.activeJobId === job.record.jobId) conv.activeJobId = undefined;
      if (conv && to === 'completed') {
        conv.turns.push({ user: job.userText, assistant: job.answer, hasPageText: job.hasPageText });
      }
      void saveTerminal(job);
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

  /**
   * 接单（在 serial 里执行）：取选区与设置，选对话（指定的、或按续接规则 D13），查忙，落库，写 session 热副本。
   * 返回拒绝原因时没有任何写入
   */
  async function accept(
    tabId: number,
    msg: AskMsg,
    jobId: string,
    opts: AskOptions,
  ): Promise<Accepted | { reason: RejectReason }> {
    let selection: StoredSelection | undefined;
    if (msg.selectionRevision !== undefined) {
      selection = await store.getSelection(tabId);
      if (selection?.selectionRevision !== msg.selectionRevision) return { reason: 'invalid' };
    }
    // 附带的截图（5.13）：编号对不上、已被取走或过期就拒绝（gone），不悄悄当成没附图发出去
    let image: TakenCapture | undefined;
    if (msg.captureId !== undefined) {
      image = await capture?.take(tabId, msg.captureId);
      if (!image) return { reason: 'gone' };
    }
    const loaded = await deps.loadSettings();
    if (!loaded.ok) return { reason: 'invalid' };
    // 没有选区也没有问题文字：只有不需要输入的动作（解释、总结本页等，问题由装配补默认值）才能这样发
    const needsInput =
      resolveActionDef(msg.actionId as ActionId, loaded.settings.customActions)?.needsInput ?? true;
    if (!selection && !image && msg.text.trim() === '' && needsInput) return { reason: 'invalid' };
    const tabUrl = await deps.getTabUrl?.(tabId).catch(() => undefined);
    const pageKey = tabUrl === undefined ? undefined : toPageKey(tabUrl);
    const settings = loaded.settings;
    const target = resolveModel(settings, msg.model);
    const adapter = target && deps.adapters[target.conn.interfaceType];
    if (!target || !adapter) return { reason: 'invalid' };
    // 模型明确不能看图（能力表 vision 为 no，E3）：不发，界面提示换能看图的模型；unknown 照发
    if (image && effectiveCapabilities(target.conn, target.model.model).vision === 'no')
      return { reason: 'noVision' };

    // 选对话：指定了且这个标签页能接着问就直接续接；不指定（或小窗指定了别的页面的）按续接规则
    const now = deps.now();
    let conv: ConvState | undefined;
    let newConversation: NewConversationReason | undefined;
    try {
      let auto = msg.fresh !== true;
      if (msg.conversationId !== undefined) {
        const c = await loadConv(msg.conversationId);
        if (c && mayContinue(c.record, tabId, pageKey)) {
          conv = c;
          auto = false;
        } else if (c && opts.otherPage !== 'fallback') {
          return { reason: 'notOwner' };
        } else if (c) {
          deps.log('ask/otherPageConversation', { fallback: true });
        } else {
          // 对话已被删除：这一问开新对话
          auto = false;
        }
      }
      if (!conv && auto) {
        const recent = await recentFor(tabId, pageKey);
        if (recent) {
          const k = continuation(recent.record, now);
          if (k.ok) conv = recent;
          else newConversation = k.reason;
        }
      }
    } catch (e) {
      deps.log('db/readFailed', { error: errName(e) });
      return { reason: 'storageFailed' };
    }
    // 同一对话正在生成时不排队、不自动停止（决策 062）
    if (conv?.activeJobId !== undefined) return { reason: 'busy' };

    const prev = conv?.record;
    const conversationId = prev?.id ?? deps.newId();
    const ordinal = conv?.nextOrdinal ?? 0;
    const record: ConversationRecord = prev
      ? {
          ...prev,
          // 对话归最近一次发问的页面（单页应用换了地址接着问时跟过去）
          ...(pageKey !== undefined ? { pageKey } : {}),
          model: target.model,
          turns: prev.turns + 1,
          revision: prev.revision + 1,
          updatedAt: stamp(),
          lastAskedAt: now,
        }
      : {
          id: conversationId,
          ...(pageKey !== undefined ? { pageKey } : {}),
          title: conversationTitle(msg.text, selection?.text),
          model: target.model,
          turns: 1,
          revision: 1,
          createdAt: now,
          updatedAt: stamp(),
          lastAskedAt: now,
        };
    const anchor = selection ? pages.anchorFor(tabId, selection.selectionRevision) : undefined;
    const userMessage: MessageRecord = {
      id: deps.newId(),
      conversationId,
      ordinal,
      role: 'user',
      segments: [{ kind: 'text', text: msg.text }],
      status: 'completed',
      request: {
        // 协议已按内置动作与 custom: 格式校验过
        actionId: msg.actionId as ActionId,
        contextTier: msg.contextTier,
        lengthTier: msg.lengthTier,
        thinking: msg.thinking,
      },
      ...(selection
        ? {
            selection: {
              text: selection.text,
              truncated: selection.truncated,
              originalLength: selection.originalLength,
              ...(anchor ? { anchor } : {}),
            },
          }
        : {}),
      ...(image ? { images: [image.image] } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const jobRecord: JobRecord = {
      jobId,
      clientRequestId: msg.clientRequestId,
      conversationId,
      messageId: deps.newId(),
      attemptId: deps.newId(),
      attempt: 1,
      workerEpoch: epoch,
      revision: record.revision,
      state: 'accepted',
      requestSent: false,
      acceptedAt: now,
      updatedAt: now,
    };
    const baseMessage: MessageRecord = {
      id: jobRecord.messageId,
      conversationId,
      ordinal: ordinal + 1,
      role: 'assistant',
      segments: [],
      status: 'accepted',
      model: target.model,
      clientRequestId: msg.clientRequestId,
      jobId,
      attemptId: jobRecord.attemptId,
      createdAt: now,
      updatedAt: now,
    };

    // 先落库（对话、用户消息、占位助手消息，一个事务），再写 session 热副本，都成了才接单（5.5）
    try {
      await persist(() =>
        db.write({
          conversations: [record],
          messages: [userMessage, baseMessage],
          ...(image ? { blobs: [image.blob] } : {}),
        }),
      );
    } catch (e) {
      deps.log('db/acceptFailed', { error: errName(e) });
      return { reason: 'storageFailed' };
    }
    try {
      await store.putJob(jobRecord);
    } catch {
      // 尽力撤回刚写进库的这一问
      void persist(async () => {
        await db.remove({
          messages: [userMessage.id, baseMessage.id],
          ...(prev ? {} : { conversations: [conversationId] }),
          ...(image ? { blobs: [image.blob.id] } : {}),
        });
        if (prev) await db.write({ conversations: [prev] });
      }).catch(() => undefined);
      return { reason: 'storageFailed' };
    }
    // 截图已随这一问存进库：待确认的那份删掉，各界面收起预览
    if (image && msg.captureId !== undefined)
      void capture
        ?.consumed(tabId, msg.captureId)
        .catch((e: unknown) => deps.log('capture/consumeFailed', { error: errName(e) }));

    const state: ConvState = conv ?? {
      record,
      turns: [],
      nextOrdinal: 0,
      lastFullPage: false,
      activeJobId: undefined,
    };
    state.record = record;
    state.nextOrdinal = ordinal + 2;
    state.activeJobId = jobId;
    remember(state);
    const job: Job = {
      record: jobRecord,
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
      conn: target.conn,
      adapter,
      req: undefined,
      actionId: msg.actionId,
      model: target.model,
      userMessage,
      baseMessage,
      savedChars: 0,
      checkpointTimer: undefined,
    };
    jobs.set(jobId, job);
    evict();
    lastJobByConv.set(conversationId, jobId);
    if (pageKey === undefined) lastConvByTab.set(tabId, conversationId);
    return {
      job,
      conv: state,
      selection,
      settings,
      target,
      pageKey,
      contextSnapshotId: deps.newId(),
      newConversation,
      image,
    };
  }

  return {
    ready,
    epoch,
    /** 等排队中的写库完成（读库前用） */
    settled,

    /**
     * 订阅要显示的对话（5.4、D13）：指定了就用它——scope 为 page（小窗）时须是这个标签页能接着问的对话，否则 notOwner；
     * any（侧边栏）任意历史对话都能看。没指定就找该页最近的对话，合续接规则（或正有回答在生成）才显示，否则是空的新对话。
     * 指定的对话库里没有（已删除）返回空。读库失败抛错
     */
    async viewFor(
      tabId: number,
      conversationId: string | undefined,
      pageKey: string | undefined,
      scope: ViewScope,
    ): Promise<{ conversation?: ConversationRecord } | 'notOwner'> {
      if (conversationId !== undefined) {
        const c = await loadConv(conversationId);
        if (!c) return {};
        if (scope === 'page' && !mayContinue(c.record, tabId, pageKey)) return 'notOwner';
        return { conversation: c.record };
      }
      const recent = await recentFor(tabId, pageKey);
      if (!recent) return {};
      const show = continuation(recent.record, deps.now()).ok || recent.activeJobId !== undefined;
      return show ? { conversation: recent.record } : {};
    },

    /** 对话最近一次的任务，在内存里且属于这个标签页才给（订阅者从它续播） */
    liveJob(conversationId: string, tabId: number): { jobId: string; messageId: string } | undefined {
      const id = lastJobByConv.get(conversationId);
      const j = id === undefined ? undefined : jobs.get(id);
      return j && j.tabId === tabId ? { jobId: j.record.jobId, messageId: j.record.messageId } : undefined;
    },

    /** 订阅快照（5.5）：对话与消息从库里读（先等排队的写完），按 ordinal 升序分批；没有对话时一批空的 */
    async snapshot(conversationId: string | undefined): Promise<ReturnType<typeof snapshotBatches>> {
      if (conversationId === undefined) return snapshotBatches(undefined, []);
      await settled();
      const record = await db.getConversation(conversationId);
      return snapshotBatches(record, record ? await db.getMessages(conversationId) : []);
    },

    /**
     * 删除对话（5.11 级联：消息、无人引用的快照）。正有回答在生成时拒绝（busy）；写库失败 storageFailed。
     * 删除排在已排队的写之后；删掉之后它在内存里的任务不再写库、不能重试
     */
    async deleteConversation(conversationId: string): Promise<RejectReason | undefined> {
      if (convs.get(conversationId)?.activeJobId !== undefined) return 'busy';
      try {
        await persist(() => db.deleteConversation(conversationId));
      } catch (e) {
        deps.log('db/deleteFailed', { error: errName(e) });
        return 'storageFailed';
      }
      deleted.add(conversationId);
      convs.delete(conversationId);
      lastJobByConv.delete(conversationId);
      for (const [tab, id] of lastConvByTab) if (id === conversationId) lastConvByTab.delete(tab);
      return undefined;
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

    /**
     * 发问。界面经对话端口发来（conv.ts），后台替界面发起的任务（快捷键「总结本页」、工具栏直接发送的动作）也走这里。
     * opts 见 AskOptions；不传按 reject
     */
    async ask(tabId: number, msg: AskMsg, reply: Reply, opts: AskOptions = {}): Promise<void> {
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
      // 「新建对话」与指定对话不能同时有
      if (msg.fresh === true && msg.conversationId !== undefined) return refuse('invalid');

      const got = await serial(() => accept(tabId, msg, jobId, opts)).catch((e: unknown) => {
        deps.log('ask/acceptFailed', { error: errName(e) });
        return { reason: 'storageFailed' as const };
      });
      if ('reason' in got) return refuse(got.reason);
      const a = got;
      const { job, conv, selection, settings, target, contextSnapshotId } = a;
      const { record } = job;
      reply({
        type: 'conv/accepted',
        clientRequestId: msg.clientRequestId,
        jobId,
        messageId: record.messageId,
        conversationId: conv.record.id,
        ...(a.newConversation ? { newConversation: a.newConversation } : {}),
      });
      // 同一标签页的其他界面（小窗、侧边栏）随之显示这个任务；这是在任何增量之前发出的
      hub.toTab(tabId, {
        type: 'conv/current',
        conversationId: conv.record.id,
        jobId,
        messageId: record.messageId,
      });

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
        actionId: msg.actionId as ActionId,
        promptOverrides: settings.promptOverrides,
        customActions: settings.customActions,
        ...(a.image ? { image: { dataUrl: a.image.dataUrl } } : {}),
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
        imageCount: plan.imageCount,
      });
      // 发送计划先于请求推给界面（规则 8）
      job.plan = { type: 'conv/plan', jobId, contextSnapshotId, plan };
      hub.toTab(tabId, job.plan);
      job.userMessage = { ...job.userMessage, sentText: assembly.userText };
      saveAssembly(job, ctx, a);
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
      // 对话已被删除：不再写回库里
      if (deleted.has(job.record.conversationId)) return 'notAllowed';
      // 装配前就被停掉的（读页面时站点策略变了、用户停止）：没有请求可重发，要用户重新提问
      const req = job.req;
      if (req === undefined) return 'notAllowed';
      // 同一对话已有别的回答在生成（重试期间又问了一轮）：不并发（决策 062）
      const conv = convs.get(job.record.conversationId);
      if (conv?.activeJobId !== undefined && conv.activeJobId !== jobId) return 'busy';
      job.controller = new AbortController();
      job.answer = '';
      job.reasoning = '';
      job.pendingText = '';
      job.pendingReasoning = '';
      if (job.flushTimer !== undefined) clearTimeout(job.flushTimer);
      job.flushTimer = undefined;
      job.error = undefined;
      // 用量与去掉的参数属于上一次尝试，新尝试重新计
      delete job.usage;
      delete job.droppedParam;
      delete job.finishReason;
      const { stopReason: _stopReason, interruptReason: _interruptReason, ...rest } = job.record;
      job.record = {
        ...rest,
        attemptId: deps.newId(),
        attempt: job.record.attempt + 1,
        state: 'accepted',
        requestSent: false,
        updatedAt: deps.now(),
      };
      if (conv) conv.activeJobId = jobId;
      job.savedChars = 0;
      void store.putJob(job.record);
      // 库里的助手消息回到 accepted：后台这时被回收，启动扫描能把它标出来
      void persist(() => db.write({ messages: [assistantRecord(job)] })).catch((e: unknown) =>
        deps.log('db/retryFailed', { error: errName(e) }),
      );
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

    /** 标签页关闭：对话属于页面，不随标签页删除；只忘掉没有 pageKey 的页面按标签页记的最近对话 */
    forgetTab(tabId: number): void {
      lastConvByTab.delete(tabId);
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
