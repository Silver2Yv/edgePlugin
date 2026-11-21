// 小窗纯逻辑（5.3 小窗、5.5 任务与恢复）：增量合并、任务状态迁移、握手/重连状态机、
// 以及发给后台的消息构造。不碰扩展 API、不碰 DOM，便于单测；FloatApp.tsx 只做装配与副作用。
import type { ContextTier, LengthTier, ThinkingLevel } from '@/core/context/plan';
import { TOKEN_PATTERN } from '@/core/domain/float';
import { isTerminal, type JobState } from '@/core/domain/job';
import type {
  BackgroundToClient,
  ClientToBackground,
  FloatToReader,
  RejectReason,
} from '@/core/domain/messages';
import { PROTOCOL_VERSION } from '@/core/domain/messages';
import type { ModelErrorKind, ModelRef } from '@/core/llm/adapter';

/** 从地址片段（如 `#t=<32 位十六进制>`）里取令牌；前缀不对或剩余部分不是合法令牌格式都返回 null */
export function parseTokenFromHash(hash: string): string | null {
  if (!hash.startsWith('#t=')) return null;
  const candidate = hash.slice(3);
  return TOKEN_PATTERN.test(candidate) ? candidate : null;
}

type DeltaMsg = Extract<BackgroundToClient, { type: 'conv/delta' }>;
type JobStateMsg = Extract<BackgroundToClient, { type: 'conv/jobState' }>;
type PlanMsg = Extract<BackgroundToClient, { type: 'conv/plan' }>;
type RejectedMsg = Extract<BackgroundToClient, { type: 'conv/rejected' }>;

// ───────────── 任务视图：增量合并（规则见 job.ts 文件头注释） ─────────────

/** 当前任务在小窗里的累积视图 */
export interface JobView {
  jobId: string;
  messageId: string;
  attemptId: string;
  /** 当前尝试是否已经收到过增量：没收到时下一条整段替换，收到过则追加（配合重试换尝试） */
  attemptStarted: boolean;
  state: JobState;
  /** 已处理过的最大 seq（同一任务内单调递增，不随尝试重置） */
  lastSeq: number;
  text: string;
  reasoning: string;
  error?: { kind: ModelErrorKind; message: string };
  /**
   * 本次请求实际发送的块编号（5.9/5.10 的 sentBlockIds，取自 conv/plan）；回答渲染的
   * 引用只在这个集合内生效。收到 conv/plan 之前为空数组，等于不替换任何引用标记。
   */
  sentBlockIds: readonly string[];
}

/** conv/accepted 落定后创建；attemptId 留空，第一条 jobState / delta 会补上（见 applyJobState / applyDelta） */
export function createJobView(jobId: string, messageId: string, resumeLastSeq = 0): JobView {
  return {
    jobId,
    messageId,
    attemptId: '',
    attemptStarted: false,
    state: 'accepted',
    lastSeq: resumeLastSeq,
    text: '',
    reasoning: '',
    sentBlockIds: [],
  };
}

export function isGenerating(job: JobView | null): boolean {
  return job !== null && !isTerminal(job.state);
}

/**
 * 合并一条增量。丢弃：不属于这个任务的、任务已到终态的、seq 不够新的。
 * 新尝试（重试）的第一条增量整段替换，不与旧尝试内容拼接：判断「是不是新尝试的第一条」不能只看
 * attemptId 是否变化——重试的 jobState 消息通常先于它的第一条增量到达，到增量来时 view.attemptId
 * 已经被 applyJobState 同步成新值了，两边会显示"相同"。真正可靠的信号是 attemptStarted
 * （这次尝试是否已经收到过增量），所以两个条件都要看。
 */
export function applyDelta(view: JobView, delta: DeltaMsg): JobView {
  if (delta.jobId !== view.jobId || isTerminal(view.state) || delta.seq <= view.lastSeq) return view;
  const isNewAttempt = delta.attemptId !== view.attemptId || !view.attemptStarted;
  return {
    ...view,
    attemptId: delta.attemptId,
    attemptStarted: true,
    lastSeq: delta.seq,
    text: (isNewAttempt ? '' : view.text) + (delta.text ?? ''),
    reasoning: (isNewAttempt ? '' : view.reasoning) + (delta.reasoning ?? ''),
  };
}

/**
 * 合并一次状态迁移。终态落定后不可覆盖——但这不妨碍重试：重试带着新 attemptId 把任务从终态
 * 带回 accepted，是唯一能跳出终态的例外（job.ts 文件头「重试」）。attemptId 变化表示开了新尝试：
 * 保留旧的正文/思考，直到这次尝试的第一条增量到达（attemptStarted 复位为 false，交给 applyDelta 整段替换）。
 */
export function applyJobState(view: JobView, msg: JobStateMsg): JobView {
  if (msg.jobId !== view.jobId) return view;
  if (isTerminal(view.state) && msg.attemptId === view.attemptId) return view;
  const retried = msg.attemptId !== view.attemptId;
  const { error: _prevError, ...rest } = view;
  const base: JobView = {
    ...rest,
    attemptId: msg.attemptId,
    attemptStarted: retried ? false : view.attemptStarted,
    state: msg.state,
  };
  return msg.error === undefined ? base : { ...base, error: msg.error };
}

/** 收到本次请求的发送计划（5.9）：取出引用渲染要用的 allowedIds（sentBlockIds） */
export function applyPlan(view: JobView, msg: PlanMsg): JobView {
  if (msg.jobId !== view.jobId) return view;
  return { ...view, sentBlockIds: msg.plan.sentBlockIds };
}

// ───────────── 握手与重连状态机（5.3 握手令牌、5.5 断线重连） ─────────────

export type ConnPhase =
  | 'noToken' // 地址片段里没有有效令牌，不发起连接
  | 'connecting' // 端口已建立，等待 conv/ready
  | 'ready' // 已握手，可以订阅 / 发问
  | 'versionMismatch' // protocolVersion 对不上，提示刷新页面
  | 'reconnecting' // 正用 conv/resumeFloat 重新握手（断线且有未到终态的任务，或从 idle 被唤醒）
  | 'idle' // 断线且没有未到终态的任务：不自动重连，不提示，等用户动作唤醒
  | 'expired'; // conv/resumeFloat 被拒绝（badToken），需要关闭小窗重开

/** 收到 conv/ready：版本一致才算真正就绪，否则提示刷新页面，不再订阅 */
export function onReady(protocolVersion: number): ConnPhase {
  return protocolVersion === PROTOCOL_VERSION ? 'ready' : 'versionMismatch';
}

/**
 * 端口断开（后台空闲被回收）。noToken / expired 没有有效连接可重连；
 * 有未到终态的任务要立即重连续上增量，否则转入 idle，不唤醒后台，等用户动作再连（见 onWake）。
 */
export function onPortDisconnect(phase: ConnPhase, hasActiveJob: boolean): ConnPhase {
  if (phase === 'noToken' || phase === 'expired') return phase;
  return hasActiveJob ? 'reconnecting' : 'idle';
}

/** 从 idle 唤醒重连：窗口获得焦点、输入框获得焦点、用户点发送 / 按 Enter。其余状态不受影响 */
export function onWake(phase: ConnPhase): ConnPhase {
  return phase === 'idle' ? 'reconnecting' : phase;
}

/** conv/resumeFloat 被拒绝：绑定已失效，不再重试 */
export function onResumeRejected(): ConnPhase {
  return 'expired';
}

export function rejectReasonText(reason: RejectReason): string {
  switch (reason) {
    case 'tooLarge':
      return '内容过长';
    case 'invalid':
      return '消息格式不对';
    case 'notAllowed':
      return '当前状态不允许该操作';
    case 'notHandshaken':
      return '尚未完成握手';
    case 'badToken':
      return '连接已失效';
    case 'notOwner':
      return '无权限操作该任务';
    default:
      return '未知原因';
  }
}

/**
 * conv/retry 被拒绝时的专属文案：比通用 rejectReasonText 更具体，直接告诉用户接下来怎么办。
 * notOwner（后台已重启，内存里没有这次请求）与 notAllowed（请求还没发出就被停掉，如读页面时
 * 站点规则变了）是重试仅有的两种拒绝原因（见 background/jobs.ts 的 retry()），其余原因沿用通用文案。
 */
export function retryRejectedText(reason: RejectReason): string {
  switch (reason) {
    case 'notOwner':
      return '后台已重启，这次没法重试，请重新提问';
    case 'notAllowed':
      return '这次请求没有发出，没法重试，请重新提问';
    default:
      return `操作失败：${rejectReasonText(reason)}`;
  }
}

// ───────────── 引用条 ─────────────

export interface QuoteView {
  selectionRevision: number;
  text: string;
  truncated: boolean;
  originalLength: number;
}

// ───────────── 整体状态与归约 ─────────────

export interface FloatState {
  connPhase: ConnPhase;
  quote: QuoteView | null;
  job: JobView | null;
  /** 已发出但还没收到 conv/accepted / conv/rejected 的发问 */
  pendingClientRequestId: string | null;
  /** 连接未就绪时存下的待发问（只存一个，新的覆盖旧的）；重连并收到这次订阅的 conv/snapshot 后发出 */
  queuedAsk: QueuedAsk | null;
  /** 收到过几次 done: true 的 conv/snapshot；用它在 effect 里触发 queuedAsk 的发出 */
  snapshotSeq: number;
  /** 发问或操作失败的提示（不对应某条消息的持续渲染，只是一次性提示） */
  actionError: string | null;
}

export function initialFloatState(hasToken: boolean): FloatState {
  return {
    connPhase: hasToken ? 'connecting' : 'noToken',
    quote: null,
    job: null,
    pendingClientRequestId: null,
    queuedAsk: null,
    snapshotSeq: 0,
    actionError: null,
  };
}

export type FloatAction =
  | { kind: 'server'; msg: BackgroundToClient }
  | { kind: 'disconnected' }
  | { kind: 'wake' }
  | { kind: 'askSent'; clientRequestId: string }
  | { kind: 'queueAsk'; ask: QueuedAsk }
  | { kind: 'localError'; message: string };

export function floatReducer(state: FloatState, action: FloatAction): FloatState {
  switch (action.kind) {
    case 'disconnected': {
      const next = onPortDisconnect(state.connPhase, isGenerating(state.job));
      return next === state.connPhase ? state : { ...state, connPhase: next };
    }
    case 'wake': {
      const next = onWake(state.connPhase);
      return next === state.connPhase ? state : { ...state, connPhase: next };
    }
    case 'askSent':
      return {
        ...state,
        pendingClientRequestId: action.clientRequestId,
        queuedAsk: null,
        actionError: null,
      };
    case 'queueAsk':
      return { ...state, queuedAsk: action.ask, actionError: null };
    case 'localError':
      return { ...state, actionError: action.message };
    case 'server':
      return applyServerMessage(state, action.msg);
    default:
      return state;
  }
}

function applyServerMessage(state: FloatState, msg: BackgroundToClient): FloatState {
  switch (msg.type) {
    case 'conv/ready':
      return { ...state, connPhase: onReady(msg.protocolVersion) };
    case 'conv/quote':
      return {
        ...state,
        quote: {
          selectionRevision: msg.selectionRevision,
          text: msg.text,
          truncated: msg.truncated,
          originalLength: msg.originalLength,
        },
      };
    case 'conv/accepted':
      if (msg.clientRequestId !== state.pendingClientRequestId) return state;
      return {
        ...state,
        pendingClientRequestId: null,
        actionError: null,
        job: createJobView(msg.jobId, msg.messageId),
      };
    case 'conv/delta':
      return state.job ? { ...state, job: applyDelta(state.job, msg) } : state;
    case 'conv/jobState':
      return state.job ? { ...state, job: applyJobState(state.job, msg) } : state;
    case 'conv/plan':
      return state.job ? { ...state, job: applyPlan(state.job, msg) } : state;
    case 'conv/snapshot':
      // 空对话，当前版本不渲染历史；只记一下「这次订阅的初始推送完了」，
      // 触发 FloatApp 把 queuedAsk（若有）用这时最新的 quote 发出
      return msg.done ? { ...state, snapshotSeq: state.snapshotSeq + 1 } : state;
    case 'conv/rejected':
      return applyRejected(state, msg);
    // 侧边栏专属的 handoff/* history/* favorite/* citation/*：小窗不处理
    default:
      return state;
  }
}

function applyRejected(state: FloatState, msg: RejectedMsg): FloatState {
  if (msg.refType === 'conv/resumeFloat') return { ...state, connPhase: onResumeRejected() };
  if (state.job && msg.refId === state.job.jobId) {
    const actionError =
      msg.refType === 'conv/retry'
        ? retryRejectedText(msg.reason)
        : `操作失败：${rejectReasonText(msg.reason)}`;
    return { ...state, actionError };
  }
  if (state.pendingClientRequestId && msg.refId === state.pendingClientRequestId)
    return {
      ...state,
      pendingClientRequestId: null,
      actionError: `发送失败：${rejectReasonText(msg.reason)}`,
    };
  return state;
}

// ───────────── 发给后台的消息构造 ─────────────

/** 订阅消息：有未到终态的任务时带上 resume，断线重连后由此续上增量 */
export function subscribeMessage(job: JobView | null): ClientToBackground {
  return job && !isTerminal(job.state)
    ? { type: 'conv/subscribe', resume: { jobId: job.jobId, lastSeq: job.lastSeq } }
    : { type: 'conv/subscribe' };
}

export interface AskParams {
  clientRequestId: string;
  text: string;
  quote: QuoteView | null;
  lengthTier: LengthTier;
  thinking: ThinkingLevel;
  model: ModelRef;
  /** 页面上下文档位；小窗还没有切换界面，取设置里的默认档位（settings.context.defaultTier），不填按只发选区 */
  contextTier?: ContextTier;
}

export function buildAskMessage(p: AskParams): ClientToBackground {
  return {
    type: 'conv/ask',
    clientRequestId: p.clientRequestId,
    actionId: 'ask',
    text: p.text,
    ...(p.quote ? { selectionRevision: p.quote.selectionRevision } : {}),
    contextTier: p.contextTier ?? 'selection',
    lengthTier: p.lengthTier,
    thinking: p.thinking,
    model: p.model,
  };
}

/**
 * 连接未就绪时存下的待发问：不含引用，发出时用当时最新的 quote（见 FloatState.queuedAsk）。
 * 只存一个，新的发问覆盖旧的（floatReducer 的 'queueAsk' 分支）。
 */
export interface QueuedAsk {
  clientRequestId: string;
  text: string;
  lengthTier: LengthTier;
  thinking: ThinkingLevel;
  model: ModelRef;
  contextTier?: ContextTier;
}

/** Enter 发送、Shift+Enter 换行；输入法组合输入中的 Enter 不发送（keyCode 229 是旧浏览器的组合态标记） */
export function shouldSendOnEnter(e: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}

// ───────────── 等待提示（小窗回答区持续反馈，用户 2026-11-19 Edge 试用反馈） ─────────────

const WAIT_HINT_THINKING_MS = 7_000;
const WAIT_HINT_LONG_MS = 15_000;
const WAIT_HINT_PAUSE_MS = 10_000;

/** waitHintText 的输入：计时从发问/重试开始算起，收到任何增量就按情况切换，任务到终态由调用方立即停表 */
export interface WaitHintInput {
  /** 距发问（或重试开始）过去多久 */
  elapsedMs: number;
  hasAnswerText: boolean;
  hasReasoningText: boolean;
  /** 距最近一次收到正文/思考增量过去多久 */
  msSinceLastDelta: number;
  jobState: JobState;
}

/**
 * 等待时持续给反馈：发问后迟迟没有任何增量时按已过时间换文案；已有正文后若连续一段时间没有
 * 新内容，换成「暂停」提示；任务到终态立即不再提示（28 秒的连接超时等现有逻辑不受影响）。
 */
export function waitHintText(input: WaitHintInput): string | null {
  if (isTerminal(input.jobState)) return null;
  if (input.hasAnswerText) {
    return input.msSinceLastDelta >= WAIT_HINT_PAUSE_MS ? '回答暂停了一会儿，仍在等待…' : null;
  }
  if (input.hasReasoningText) return '正在思考…（思考过程可展开查看）';
  if (input.elapsedMs >= WAIT_HINT_LONG_MS) return '等待时间较长，仍在尝试中…';
  if (input.elapsedMs >= WAIT_HINT_THINKING_MS) return '正在努力思考中…';
  return '正在等待回答…';
}

// ───────────── 小窗私有端口：拖动 / 缩放持久化（5.3） ─────────────

export interface FloatRectValue {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatSettingsLike {
  placement: 'nearSelection' | 'remembered';
  rect?: FloatRectValue;
}

/**
 * 私有端口连接后，用阅读器回报的当前 rect 与持久化设置算出要发的恢复指令：
 * - 记忆了尺寸且与当前不同：恢复尺寸（与摆放策略无关——摆放只管坐标，尺寸是用户另一个决定）。
 * - 摆放策略是「记住位置」且记了坐标：恢复坐标；「出现在选区附近」时坐标保持阅读器算好的近选区位置。
 * 没有记忆设置时返回空数组（不发任何指令）。
 */
export function restoreCommandsOnConnect(
  current: FloatRectValue,
  settings: FloatSettingsLike,
): FloatToReader[] {
  const r = settings.rect;
  if (!r) return [];
  const cmds: FloatToReader[] = [];
  if (r.w !== current.w || r.h !== current.h) cmds.push({ type: 'float/resize', w: r.w, h: r.h });
  if (settings.placement === 'remembered') cmds.push({ type: 'float/reposition', x: r.x, y: r.y });
  return cmds;
}
