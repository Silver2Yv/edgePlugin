// 小窗与侧边栏共用的纯逻辑（5.3 小窗、5.4 侧边栏、5.5 任务与恢复）：增量合并、任务状态迁移、握手/重连状态机、
// 订阅切换（侧边栏跟随标签页）、转接（6.4），以及发给后台的消息构造。不碰扩展 API、不碰 DOM，便于单测；
// FloatApp.tsx / SidePanelApp.tsx 只做装配与副作用。
import type { ContextTier, LengthTier, RequestContextPlan, ThinkingLevel } from '@/core/context/plan';
import { TOKEN_PATTERN } from '@/core/domain/float';
import { isTerminal, type JobState } from '@/core/domain/job';
import type {
  BackgroundToClient,
  ClientToBackground,
  FloatToReader,
  PanelNoticeKind,
  RejectReason,
} from '@/core/domain/messages';
import { PROTOCOL_VERSION } from '@/core/domain/messages';
import type { ModelErrorKind, ModelRef, Usage } from '@/core/llm/adapter';
import { T } from '../strings';
import { archiveJob, localUserMessage, type MessageView, mergeSnapshot, type QuoteSummary } from './messages';

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
  /** 这次请求的发送计划（conv/plan）：「实际发送说明」与侧边栏的当前页信息从它派生（B8、C3） */
  plan?: RequestContextPlan;
  /** 用量（J9）：后台随终态给出时才有 */
  usage?: Usage;
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
  // 用量（J9）：协议里 conv/jobState 还没有这个字段，网关接入后若随状态带上就记下，没有就不显示
  const usage = (msg as { usage?: Usage }).usage;
  const withUsage: JobView = usage === undefined ? base : { ...base, usage };
  return msg.error === undefined ? withUsage : { ...withUsage, error: msg.error };
}

/** 收到本次请求的发送计划（5.9）：取出引用渲染要用的 sentBlockIds，整份计划留给「实际发送说明」 */
export function applyPlan(view: JobView, msg: PlanMsg): JobView {
  if (msg.jobId !== view.jobId) return view;
  return { ...view, sentBlockIds: msg.plan.sentBlockIds, plan: msg.plan };
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
      return T.reject.tooLarge;
    case 'invalid':
      return T.reject.invalid;
    case 'notAllowed':
      return T.reject.notAllowed;
    case 'notHandshaken':
      return T.reject.notHandshaken;
    case 'badToken':
      return T.reject.badToken;
    case 'notOwner':
      return T.reject.notOwner;
    case 'busy':
      return T.reject.busy;
    case 'gone':
      return T.reject.gone;
    case 'storageFailed':
      return T.reject.storageFailed;
    case 'modelGone':
      return T.reject.modelGone;
    default:
      return T.reject.unknown;
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
      return T.reject.retryNotOwner;
    case 'notAllowed':
      return T.reject.retryNotAllowed;
    default:
      return T.reject.action(rejectReasonText(reason));
  }
}

// ───────────── 引用条 ─────────────

export interface QuoteView {
  selectionRevision: number;
  text: string;
  truncated: boolean;
  originalLength: number;
}

// ───────────── 侧边栏顶部说明（5.4 降级提示） ─────────────

/** 「加载失败」与「网站不支持」分开说，不把前者说成后者（V-02） */
export const PANEL_NOTICE_TEXT: Readonly<Record<PanelNoticeKind, string>> = {
  floatTransient: T.notice.floatTransient,
  floatUnsupported: T.notice.floatUnsupported,
  noConnection: T.notice.noConnection,
  requestRefused: T.notice.requestRefused,
};

// ───────────── 转接（6.4） ─────────────

/** 转接发出后等侧边栏接手多久，没接上就提示一行（小窗不收起） */
export const HANDOFF_SLOW_MS = 5_000;

/**
 * 小窗这边的转接进度：handoff/created 带回编号，handoff/done 对上编号才收起。
 * sent：handoff/start 发出去没有。点击时连接没就绪（后台被回收后闲着）先记下，重连就绪后再发
 */
export interface HandoffView {
  handoffId: string | null;
  sent: boolean;
  slow: boolean;
  done: boolean;
}

/** 侧边栏收到的待接转接（handoff/pending） */
export interface IncomingHandoff {
  handoffId: string;
  tabId: number;
  conversationId?: string;
}

/** 面板加载后，这个窗口来了一次「开关侧边栏」命令（at）：面板在命令之前就已存在，就该自行关闭（5.4） */
export function shouldCloseOnToggle(panelCreatedAt: number, commandAt: number): boolean {
  return commandAt > panelCreatedAt;
}

// ───────────── 整体状态与归约 ─────────────

export interface FloatState {
  connPhase: ConnPhase;
  quote: QuoteView | null;
  job: JobView | null;
  /** 正在显示的对话（conv/accepted、conv/subscribed、conv/current 给出）；转接与侧边栏续问用它 */
  conversationId: string | null;
  /**
   * 侧边栏要订阅的标签页（小窗为 null，订阅的标签页由令牌决定）。换了之后、收到这个标签页的 conv/subscribed 之前，
   * 到达的推送都属于旧标签页，丢弃（targetConfirmed 为 false）
   */
  target: number | null;
  targetConfirmed: boolean;
  /** 每换一次订阅加一；侧边栏据此（重新）发 conv/subscribe，同一标签页地址变了也要重订 */
  targetSeq: number;
  /** 订阅附带的转接：侧边栏带着它订阅，后台据此通知小窗收起 */
  subscribeHandoff: IncomingHandoff | null;
  /** 侧边栏收到、还没处理的待接转接 */
  incomingHandoff: IncomingHandoff | null;
  /** 侧边栏顶部的一行说明 */
  notice: PanelNoticeKind | null;
  /** 小窗发起的转接 */
  handoff: HandoffView | null;
  /** 已发出但还没收到 conv/accepted / conv/rejected 的发问 */
  pendingClientRequestId: string | null;
  /** 连接未就绪时存下的待发问（只存一个，新的覆盖旧的）；重连并收到这次订阅的 conv/snapshot 后发出 */
  queuedAsk: QueuedAsk | null;
  /** 收到过几次 done: true 的 conv/snapshot；用它在 effect 里触发 queuedAsk 的发出 */
  snapshotSeq: number;
  /** 发问或操作失败的提示（不对应某条消息的持续渲染，只是一次性提示） */
  actionError: string | null;
  /**
   * 当前对话已有的消息（C1）：后台快照里的（conv/snapshot）加上这个界面自己发的问、看着答完的任务。
   * 正在显示的任务（job）不一定在里面，显示时由 messages.ts 的 displayItems 拼到一起
   */
  messages: readonly MessageView[];
  /** 已发出、还没接单的发问内容（问题与当时的引用）：接单后变成对话里的一条用户消息 */
  pendingAsk: { text: string; quote: QuoteSummary | null } | null;
  /**
   * 用户点 × 取消的那次引用（D11）：重连后后台会把存着的选区再推一遍，同一次选区不再显示；
   * 新的选区（修订号或文字不同）照常显示。修订号每个网页文档从头数，所以连文字一起比
   */
  dismissedQuote: { selectionRevision: number; text: string } | null;
  /** 输入区临时切换的上下文档位与思考强度（D3、H4）：只影响当前对话之后的发问；null 用设置里的默认值 */
  tierOverride: ContextTier | null;
  thinkingOverride: ThinkingLevel | null;
  /**
   * 输入区临时切换的模型（H4、contract-v1.5 增量，这次发问才带，不走 conv/setModel——那个消息类型
   * 本版本后台不处理）；null 用设置里的默认模型。模型所在连接被删（modelGone）时后台拒绝，
   * 界面收到后把它清回 null（见 applyRejected）
   */
  modelOverride: ModelRef | null;
  /** 用户点了「新对话」：下一次发问不带 conversationId；在那之前订阅补发的旧对话不再显示 */
  freshConversation: boolean;
  /** 一行提示：这次发问被后台接到了新对话（D13「已开启新对话，旧的仍可在历史里找回」） */
  convHint: 'newConversation' | null;
}

export function initialFloatState(hasToken: boolean): FloatState {
  return {
    connPhase: hasToken ? 'connecting' : 'noToken',
    quote: null,
    job: null,
    conversationId: null,
    target: null,
    targetConfirmed: true,
    targetSeq: 0,
    subscribeHandoff: null,
    incomingHandoff: null,
    notice: null,
    handoff: null,
    pendingClientRequestId: null,
    queuedAsk: null,
    snapshotSeq: 0,
    actionError: null,
    messages: [],
    pendingAsk: null,
    dismissedQuote: null,
    tierOverride: null,
    thinkingOverride: null,
    modelOverride: null,
    freshConversation: false,
    convHint: null,
  };
}

/** 侧边栏的初始状态：没有令牌，连上后跟随本窗口的活动标签页 */
export function initialPanelState(): FloatState {
  return { ...initialFloatState(true), targetConfirmed: false };
}

export type FloatAction =
  | { kind: 'server'; msg: BackgroundToClient }
  | { kind: 'disconnected' }
  | { kind: 'wake' }
  /** text / quote：这次发问的问题与引用，接单后显示成对话里的用户消息（不给则不显示这条用户消息） */
  | { kind: 'askSent'; clientRequestId: string; text?: string; quote?: QuoteSummary | null }
  | { kind: 'queueAsk'; ask: QueuedAsk }
  | { kind: 'localError'; message: string }
  /** 侧边栏换订阅：跟随切换标签页、地址变化，或接手转接 */
  | { kind: 'retarget'; tabId: number; handoff?: IncomingHandoff }
  /** 小窗点了「转到侧边栏」（已同步 open）；handoff/start 等连接就绪再发 */
  | { kind: 'handoffStarted' }
  | { kind: 'handoffSent' }
  | { kind: 'handoffSlow' }
  /** 转接结束（已收起，或放弃） */
  | { kind: 'handoffClear' }
  /** 点引用条的 ×：取消引用，之后的发问不带选区，直到有新的选区 */
  | { kind: 'dismissQuote' }
  /** 输入区临时切换档位 / 思考强度；null 回到设置里的默认值 */
  | { kind: 'setTier'; contextTier: ContextTier | null }
  | { kind: 'setThinking'; thinking: ThinkingLevel | null }
  /** 输入区临时切换模型（H4）；null 回到设置里的默认模型 */
  | { kind: 'setModel'; model: ModelRef | null }
  /** 点「新对话」：清空显示，下一次发问开新对话（回答生成中不动） */
  | { kind: 'newConversation' };

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
        pendingAsk: action.text === undefined ? null : { text: action.text, quote: action.quote ?? null },
      };
    case 'queueAsk':
      return { ...state, queuedAsk: action.ask, actionError: null };
    case 'localError':
      return { ...state, actionError: action.message };
    case 'retarget': {
      const sameTab = action.tabId === state.target;
      const base: FloatState = {
        ...state,
        target: action.tabId,
        targetConfirmed: false,
        targetSeq: state.targetSeq + 1,
        subscribeHandoff: action.handoff ?? null,
        incomingHandoff: null,
      };
      // 换了标签页：立刻清掉旧标签页的内容，不让它在新订阅回来之前冒充新页面的对话
      return sameTab
        ? base
        : {
            ...base,
            quote: null,
            job: null,
            conversationId: null,
            notice: null,
            actionError: null,
            messages: [],
            pendingAsk: null,
            dismissedQuote: null,
            tierOverride: null,
            thinkingOverride: null,
            modelOverride: null,
            freshConversation: false,
            convHint: null,
          };
    }
    case 'handoffStarted':
      return {
        ...state,
        handoff: { handoffId: null, sent: false, slow: false, done: false },
        actionError: null,
      };
    case 'handoffSent':
      return state.handoff ? { ...state, handoff: { ...state.handoff, sent: true } } : state;
    case 'handoffSlow':
      return state.handoff && !state.handoff.done
        ? { ...state, handoff: { ...state.handoff, slow: true } }
        : state;
    case 'handoffClear':
      return { ...state, handoff: null };
    case 'dismissQuote':
      return state.quote
        ? {
            ...state,
            quote: null,
            dismissedQuote: { selectionRevision: state.quote.selectionRevision, text: state.quote.text },
          }
        : state;
    case 'setTier':
      return { ...state, tierOverride: action.contextTier };
    case 'setThinking':
      return { ...state, thinkingOverride: action.thinking };
    case 'setModel':
      return { ...state, modelOverride: action.model };
    case 'newConversation':
      if (isGenerating(state.job)) return state;
      return {
        ...state,
        conversationId: null,
        job: null,
        messages: [],
        pendingAsk: null,
        tierOverride: null,
        thinkingOverride: null,
        modelOverride: null,
        freshConversation: true,
        convHint: null,
        actionError: null,
      };
    case 'server':
      return applyServerMessage(state, action.msg);
    default:
      return state;
  }
}

/** 换订阅之后、新标签页的 conv/subscribed 到达之前，只认这几种（其余属于旧标签页） */
const UNGATED: ReadonlySet<BackgroundToClient['type']> = new Set<BackgroundToClient['type']>([
  'conv/ready',
  'conv/rejected',
  'handoff/pending',
]);

function applyServerMessage(state: FloatState, msg: BackgroundToClient): FloatState {
  if (!state.targetConfirmed && !UNGATED.has(msg.type)) {
    if (msg.type !== 'conv/subscribed' || msg.tabId !== state.target) return state;
  }
  switch (msg.type) {
    case 'conv/ready':
      return { ...state, connPhase: onReady(msg.protocolVersion) };
    case 'conv/subscribed':
      return applySubscribed(state, msg);
    case 'conv/current':
      if (msg.jobId === state.job?.jobId) return { ...state, conversationId: msg.conversationId };
      // 自己刚发的问还没回 conv/accepted：不被别的界面发起的任务换掉
      if (state.pendingClientRequestId !== null) return state;
      // 别的界面（或后台替用户）在这个标签页发了问：同一对话就把上一条回答留在列表里，换了对话从头显示
      return {
        ...state,
        conversationId: msg.conversationId,
        job: createJobView(msg.jobId, msg.messageId),
        messages:
          msg.conversationId === state.conversationId
            ? archiveJob(state.messages, state.job, state.conversationId)
            : [],
        freshConversation: false,
        convHint: null,
      };
    case 'conv/notice':
      return { ...state, notice: msg.kind };
    case 'handoff/created':
      return state.handoff ? { ...state, handoff: { ...state.handoff, handoffId: msg.handoffId } } : state;
    case 'handoff/done':
      return state.handoff && state.handoff.handoffId === msg.handoffId
        ? { ...state, handoff: { ...state.handoff, done: true } }
        : state;
    case 'handoff/pending':
      return {
        ...state,
        incomingHandoff: {
          handoffId: msg.handoffId,
          tabId: msg.tabId,
          ...(msg.conversationId === undefined ? {} : { conversationId: msg.conversationId }),
        },
      };
    case 'conv/quote':
      // 用户取消过的同一次选区（重连后后台重推）不再显示；新的选区照常显示
      if (
        state.dismissedQuote?.selectionRevision === msg.selectionRevision &&
        state.dismissedQuote.text === msg.text
      )
        return state;
      return {
        ...state,
        dismissedQuote: null,
        quote: {
          selectionRevision: msg.selectionRevision,
          text: msg.text,
          truncated: msg.truncated,
          originalLength: msg.originalLength,
        },
      };
    case 'conv/accepted': {
      if (msg.clientRequestId !== state.pendingClientRequestId) return state;
      // 接在正在显示的对话后面：上一条回答留在列表里；后台给的是另一个对话（新对话）：从头显示
      const continuing = msg.conversationId === state.conversationId;
      const kept = continuing ? archiveJob(state.messages, state.job, state.conversationId) : [];
      return {
        ...state,
        pendingClientRequestId: null,
        pendingAsk: null,
        actionError: null,
        conversationId: msg.conversationId,
        job: createJobView(msg.jobId, msg.messageId),
        messages: state.pendingAsk ? [...kept, localUserMessage(state.pendingAsk, msg)] : kept,
        freshConversation: false,
        // 想接着问、后台却另开了对话（D13 的续接规则）：提示一行。用户自己点的「新对话」、第一次发问不提示
        convHint:
          !continuing && state.conversationId !== null && !state.freshConversation ? 'newConversation' : null,
      };
    }
    case 'conv/delta':
      return state.job ? { ...state, job: applyDelta(state.job, msg) } : state;
    case 'conv/jobState':
      return state.job ? { ...state, job: applyJobState(state.job, msg) } : state;
    case 'conv/plan':
      return state.job ? { ...state, job: applyPlan(state.job, msg) } : state;
    case 'conv/snapshot': {
      // 对话已有的消息并进列表（C1）；空的一批不动已显示的内容。done 记一下「这次订阅的初始推送完了」，
      // 触发 FloatApp 把 queuedAsk（若有）用这时最新的 quote 发出
      const next = applySnapshotMessages(state, msg);
      return msg.done ? { ...next, snapshotSeq: next.snapshotSeq + 1 } : next;
    }
    case 'conv/rejected':
      return applyRejected(state, msg);
    case 'conv/saveFailed':
      // 写入确认（5.11）：终态没写进库，不能让人以为已经存进历史
      return state.job?.jobId === msg.jobId ? { ...state, actionError: T.reject.saveFailed } : state;
    // history/* favorite/* citation/*：本版本不处理
    default:
      return state;
  }
}

type SubscribedMsg = Extract<BackgroundToClient, { type: 'conv/subscribed' }>;

/**
 * 订阅生效。侧边栏换了订阅（有 target 且还没确认）：这次订阅的初始推送完整描述了要显示的东西——任务、对话、引用、
 * 说明都以它为准，没带的就是没有（换了页面、没发过问）。小窗、以及侧边栏断线重连后的重订（没换标签页）：只补不删
 * （后台重启后内存里没有对话，照旧显示上一次的回答）。
 * 同一个任务保留已有的视图，补发的增量按 seq 去重；换了任务从 0 开始续播
 */
function applySubscribed(state: FloatState, msg: SubscribedMsg): FloatState {
  const job = msg.job
    ? state.job?.jobId === msg.job.jobId
      ? state.job
      : createJobView(msg.job.jobId, msg.job.messageId)
    : null;
  if (state.target === null || state.targetConfirmed) {
    // 用户刚点过「新对话」：重连补发的旧对话不再接回来
    if (state.freshConversation) return state;
    const conversationId = msg.conversationId ?? state.conversationId;
    return {
      ...state,
      job: job ?? state.job,
      conversationId,
      messages: keptMessages(state, conversationId, job),
    };
  }
  if (state.freshConversation) return { ...state, targetConfirmed: true, quote: null, notice: null };
  const conversationId = msg.conversationId ?? null;
  return {
    ...state,
    targetConfirmed: true,
    job,
    conversationId,
    quote: null,
    notice: null,
    messages: keptMessages(state, conversationId, job),
    convHint: null,
  };
}

/**
 * 订阅接上之后列表里留什么：还是同一个对话就留着（接上的任务换了，把上一条回答归进列表）；
 * 换了对话就清空，等快照补上
 */
function keptMessages(
  state: FloatState,
  conversationId: string | null,
  job: JobView | null,
): readonly MessageView[] {
  if (conversationId !== state.conversationId) return [];
  return job !== null && job !== state.job
    ? archiveJob(state.messages, state.job, state.conversationId)
    : state.messages;
}

type SnapshotMsg = Extract<BackgroundToClient, { type: 'conv/snapshot' }>;

/**
 * 快照里的消息并进列表。只收正在显示的那个对话的（还没有对话时，快照说是哪个就是哪个）；
 * 用户刚点过「新对话」时不收
 */
function applySnapshotMessages(state: FloatState, msg: SnapshotMsg): FloatState {
  const first = msg.messages[0];
  if (!first || state.freshConversation) return state;
  const conversationId = state.conversationId ?? msg.conversation?.id ?? first.conversationId;
  if (first.conversationId !== conversationId) return state;
  return { ...state, conversationId, messages: mergeSnapshot(state.messages, msg.messages) };
}

function applyRejected(state: FloatState, msg: RejectedMsg): FloatState {
  if (msg.refType === 'conv/resumeFloat') return { ...state, connPhase: onResumeRejected() };
  // 握手失败（令牌无效、过期）：不再停在「连接中」，提示重开或转到侧边栏
  if (msg.refType === 'conv/helloFloat') return { ...state, connPhase: onResumeRejected() };
  if (msg.refType === 'handoff/start')
    return { ...state, handoff: null, actionError: T.reject.handoff(rejectReasonText(msg.reason)) };
  if (msg.refType === 'conv/subscribe' && state.target !== null)
    return {
      ...state,
      targetConfirmed: true,
      actionError: T.reject.subscribe(rejectReasonText(msg.reason)),
    };
  if (state.job && msg.refId === state.job.jobId) {
    const actionError =
      msg.refType === 'conv/retry'
        ? retryRejectedText(msg.reason)
        : T.reject.action(rejectReasonText(msg.reason));
    return { ...state, actionError };
  }
  if (state.pendingClientRequestId && msg.refId === state.pendingClientRequestId)
    return {
      ...state,
      pendingClientRequestId: null,
      pendingAsk: null,
      actionError: T.reject.send(rejectReasonText(msg.reason)),
      // 临时切换的模型所在连接已不存在（modelGone，J10/V-07）：切回设置里的默认模型，
      // 不然下次发问还是同一个模型、还是会被拒
      ...(msg.reason === 'modelGone' ? { modelOverride: null } : {}),
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

/**
 * 侧边栏的订阅：指定标签页；接手转接时带上转接的对话与编号。不带 resume——后台从 0 补发接上的任务，
 * 已显示过的部分按 seq 去重（换订阅期间被丢掉的推送也因此补得回来）
 */
export function panelSubscribeMessage(state: FloatState): ClientToBackground | null {
  if (state.target === null) return null;
  const h = state.subscribeHandoff;
  return {
    type: 'conv/subscribe',
    tabId: state.target,
    ...(h?.conversationId === undefined ? {} : { conversationId: h.conversationId }),
    ...(h ? { handoffId: h.handoffId } : {}),
  };
}

export interface AskParams {
  clientRequestId: string;
  text: string;
  quote: QuoteView | null;
  /** 接着正在显示的这个对话问（B5、D12）；不填是新对话（还没发过问，或点了「新对话」） */
  conversationId?: string | null;
  /** 用户点了「新对话」：明确新建（contract-v1.4 的 fresh），否则后台按续接规则（D13）可能接上近期的对话 */
  fresh?: boolean;
  lengthTier: LengthTier;
  thinking: ThinkingLevel;
  model: ModelRef;
  /** 页面上下文档位：输入区临时切换的，没切换过取设置里的默认档位（settings.context.defaultTier）；不填按只发选区 */
  contextTier?: ContextTier;
}

export function buildAskMessage(p: AskParams): ClientToBackground {
  return {
    type: 'conv/ask',
    clientRequestId: p.clientRequestId,
    ...(p.conversationId ? { conversationId: p.conversationId } : p.fresh ? { fresh: true } : {}),
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
    return input.msSinceLastDelta >= WAIT_HINT_PAUSE_MS ? T.wait.paused : null;
  }
  if (input.hasReasoningText) return T.wait.reasoning;
  if (input.elapsedMs >= WAIT_HINT_LONG_MS) return T.wait.long;
  if (input.elapsedMs >= WAIT_HINT_THINKING_MS) return T.wait.thinkingHard;
  return T.wait.waiting;
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
