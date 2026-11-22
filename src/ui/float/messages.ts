// 对话消息的界面模型（C1）：把后台快照里的消息记录（conv/snapshot 的 MessageRecord）、界面自己知道的发问、
// 以及正在生成的任务拼成一份按顺序显示的列表。纯逻辑，不碰扩展 API 与 DOM；归约器（state.ts）调用这里。
//
// 来源有两个，按消息编号合并：
// - 快照：后台从数据库读出的整段对话（持久化接入后才有内容，之前一直是空数组）。
// - 本地：这个界面亲手发的问（知道问题与引用）和它看着答完的任务。快照里出现同一条消息后，以快照的顺序为准。
import type { ContextTier, RequestContextPlan } from '@/core/context/plan';
import type { JobState } from '@/core/domain/job';
import type { ContentSegment, MessageRecord } from '@/core/domain/records';
import type { ModelErrorKind, Usage } from '@/core/llm/adapter';

/** 一条用户消息带的引用（选中的文字）；text 可能只是预览用的前一段 */
export interface QuoteSummary {
  text: string;
  truncated: boolean;
  originalLength: number;
}

interface MessageBase {
  id: string;
  conversationId: string | null;
  /** 对话内的序号（来自快照）；本地暂存、后台还没给记录的为 null，排在有序号的之后 */
  ordinal: number | null;
}

export interface UserMessageView extends MessageBase {
  role: 'user';
  text: string;
  quote?: QuoteSummary;
  /** 本地暂存的发问对应哪条助手消息；快照里出现那条助手消息后，暂存的让位给快照里的用户消息 */
  pairedMessageId?: string;
  /** 这一轮的动作与页面档位（「换个模型再试」按原样重问）；界面自己发的普通提问没有，按「问」处理 */
  request?: AskRequest;
  /**
   * 附带的截图（capture 块）：本地暂存的发问带着缩略图（thumb）；快照来的只有位置（messageId + index），
   * 缩略图按需向后台取（image/get）
   */
  images?: readonly UserImageView[];
}

/** 一轮发问的动作与页面档位 */
export interface AskRequest {
  actionId: string;
  contextTier: ContextTier;
}

export interface UserImageView {
  thumb?: string;
  messageId?: string;
  index: number;
}

/** 助手消息；正在生成的任务（JobView）字段是它的超集，回答区组件两种都收 */
export interface AssistantMessageView extends MessageBase {
  role: 'assistant';
  jobId?: string;
  /** 界面看着答完的任务留下的尝试编号；快照来的消息没有 */
  attemptId?: string;
  state: Exclude<JobState, 'idle'>;
  text: string;
  reasoning: string;
  error?: { kind: ModelErrorKind; message: string };
  /** 这条回答的发送计划：引用编号只在它的 sentBlockIds 内有效（规则 9），「实际发送说明」从它派生（规则 8） */
  plan?: RequestContextPlan;
  usage?: Usage;
}

export type MessageView = UserMessageView | AssistantMessageView;

/** 回答区组件要的最小形状：消息记录转来的视图与正在生成的任务都满足 */
export interface AnswerLike {
  jobId?: string;
  attemptId?: string;
  state: JobState;
  text: string;
  reasoning: string;
  error?: { kind: ModelErrorKind; message: string };
  plan?: RequestContextPlan;
  usage?: Usage;
}

// ───────────── 引用编号 ─────────────

/**
 * 块编号 → 回答里引用标记用的数字：b12 → 12。回答里的引用写法是全角【12】（render/citation.ts），
 * 提示词按同一规则给模型标编号；形状不对的块号没有对应的引用编号
 */
export function citationNumber(blockId: string): string | null {
  const m = /^b?(\d+)$/.exec(blockId);
  return m ? String(Number.parseInt(m[1] as string, 10)) : null;
}

/** 一次请求实际发送的块 → 这条回答允许的引用编号集合（交给渲染管线的 allowedIds） */
export function citationIds(sentBlockIds: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const id of sentBlockIds) {
    const n = citationNumber(id);
    if (n !== null) out.add(n);
  }
  return out;
}

// ───────────── 消息记录 → 视图 ─────────────

/** 内容分段还原成渲染管线认的文本：引用分段写回【N】或【N】原文【/N】，编号对不上的只留原文 */
export function segmentsToText(segments: readonly ContentSegment[]): string {
  return segments
    .map((s) => {
      if (s.kind === 'text') return s.text;
      const n = citationNumber(s.ref.blockId);
      if (n === null) return s.quote ?? '';
      return s.quote === undefined ? `【${n}】` : `【${n}】${s.quote}【/${n}】`;
    })
    .join('');
}

export function recordToView(r: MessageRecord): MessageView {
  const base = { id: r.id, conversationId: r.conversationId, ordinal: r.ordinal };
  const text = segmentsToText(r.segments);
  if (r.role === 'user') {
    const sel = r.selection;
    return {
      ...base,
      role: 'user',
      text,
      ...(sel
        ? { quote: { text: sel.text, truncated: sel.truncated, originalLength: sel.originalLength } }
        : {}),
      ...(r.request ? { request: { actionId: r.request.actionId, contextTier: r.request.contextTier } } : {}),
      ...(r.images?.length ? { images: r.images.map((_, index) => ({ messageId: r.id, index })) } : {}),
    };
  }
  return {
    ...base,
    role: 'assistant',
    state: r.status,
    text,
    reasoning: r.reasoning ?? '',
    ...(r.jobId === undefined ? {} : { jobId: r.jobId }),
    ...(r.error ? { error: r.error } : {}),
    ...(r.plan ? { plan: r.plan } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
  };
}

// ───────────── 合并 ─────────────

/** 有序号的按序号排在前，本地暂存的按加入顺序排在后 */
function ordered(messages: readonly MessageView[]): MessageView[] {
  const persisted = messages.filter((m) => m.ordinal !== null);
  const local = messages.filter((m) => m.ordinal === null);
  persisted.sort((a, b) => (a.ordinal as number) - (b.ordinal as number));
  return [...persisted, ...local];
}

/**
 * 把一批快照消息并进列表：同编号的以快照为准；快照带来了某条助手消息，本地为它暂存的那条用户消息就让位
 * （快照里有真正的那条）。不属于这批消息所在对话的旧消息丢掉。分批到达的快照逐批调用即可
 */
export function mergeSnapshot(
  existing: readonly MessageView[],
  records: readonly MessageRecord[],
): readonly MessageView[] {
  const first = records[0];
  if (!first) return existing;
  const incoming = records.map(recordToView);
  const ids = new Set(incoming.map((m) => m.id));
  const kept = existing.filter(
    (m) =>
      m.conversationId === first.conversationId &&
      !ids.has(m.id) &&
      !(m.role === 'user' && m.pairedMessageId !== undefined && ids.has(m.pairedMessageId)),
  );
  return ordered([...kept, ...incoming]);
}

/** 任务视图里与消息有关的部分（state.ts 的 JobView 满足它） */
export interface JobLike extends AnswerLike {
  jobId: string;
  messageId: string;
  state: JobState;
}

export function jobToView(
  job: JobLike,
  conversationId: string | null,
  ordinal: number | null = null,
): AssistantMessageView {
  return {
    id: job.messageId,
    conversationId,
    ordinal,
    role: 'assistant',
    jobId: job.jobId,
    ...(job.attemptId ? { attemptId: job.attemptId } : {}),
    state: job.state === 'idle' ? 'accepted' : job.state,
    text: job.text,
    reasoning: job.reasoning,
    ...(job.error ? { error: job.error } : {}),
    ...(job.plan ? { plan: job.plan } : {}),
    ...(job.usage ? { usage: job.usage } : {}),
  };
}

/** 换下一个任务之前，把当前任务的回答留在列表里（同编号的原地更新，没有就接在最后） */
export function archiveJob(
  messages: readonly MessageView[],
  job: JobLike | null,
  conversationId: string | null,
): readonly MessageView[] {
  if (!job) return messages;
  const at = messages.findIndex((m) => m.id === job.messageId);
  if (at < 0) return [...messages, jobToView(job, conversationId)];
  const next = [...messages];
  next[at] = jobToView(job, conversationId, messages[at]?.ordinal ?? null);
  return next;
}

/** 界面自己发的问：接单后先在本地暂存一条用户消息（问题与引用界面都知道），不等快照 */
export function localUserMessage(
  ask: { text: string; quote: QuoteSummary | null; request?: AskRequest; capture?: { thumb: string } },
  accepted: { messageId: string; conversationId: string },
): UserMessageView {
  return {
    id: `local:${accepted.messageId}`,
    conversationId: accepted.conversationId,
    ordinal: null,
    role: 'user',
    text: ask.text,
    pairedMessageId: accepted.messageId,
    ...(ask.quote ? { quote: ask.quote } : {}),
    ...(ask.request ? { request: ask.request } : {}),
    ...(ask.capture ? { images: [{ thumb: ask.capture.thumb, index: 0 }] } : {}),
  };
}

/**
 * live（contract-v1.5）：别的界面（或后台替用户）在这个标签页发问时，conv/current 带来的这一轮用户消息。
 * 用真实的消息编号与序号（不加 local: 前缀）——之后真正的快照带着同一个 id 到达会直接替换掉它（mergeSnapshot）
 */
export function remoteUserMessage(
  um: { id: string; ordinal: number; text: string; quote?: QuoteSummary; request?: AskRequest },
  conversationId: string,
): UserMessageView {
  return {
    id: um.id,
    conversationId,
    ordinal: um.ordinal,
    role: 'user',
    text: um.text,
    ...(um.quote ? { quote: um.quote } : {}),
    ...(um.request ? { request: um.request } : {}),
  };
}

// ───────────── 显示列表 ─────────────

export type DisplayItem =
  | {
      kind: 'user';
      message: UserMessageView;
      /** 气泡里要不要显示引用摘要：和上一条用户消息引用的是同一段时不重复显示（引用条一直带着同一段选区连续追问时） */
      showQuote: boolean;
    }
  | {
      kind: 'assistant';
      id: string;
      view: AnswerLike;
      /** 是正在显示的任务（可停止、重试、续播增量）；历史消息为 false */
      live: boolean;
      /** 这条回答对应的发问选中了多少字（取自它前面那条用户消息的引用），不知道为 null */
      selectedChars: number | null;
    };

/**
 * 要显示的列表：消息按顺序排，其中属于当前任务的那条助手消息换成任务视图（它有实时的增量）；
 * 列表里还没有当前任务的消息时接在最后
 */
export function displayItems(messages: readonly MessageView[], job: JobLike | null): DisplayItem[] {
  const out: DisplayItem[] = [];
  let selectedChars: number | null = null;
  let placed = false;
  let prevQuote: string | undefined;
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ kind: 'user', message: m, showQuote: m.quote !== undefined && m.quote.text !== prevQuote });
      prevQuote = m.quote?.text;
      selectedChars = m.quote ? m.quote.originalLength : null;
      continue;
    }
    const live = job !== null && m.id === job.messageId;
    if (live) placed = true;
    out.push({ kind: 'assistant', id: m.id, view: live ? job : m, live, selectedChars });
    selectedChars = null;
  }
  if (job && !placed)
    out.push({ kind: 'assistant', id: job.messageId, view: job, live: true, selectedChars });
  return out;
}

/** 按「一问一答」分组：每条用户消息开一组（前面没有用户消息的回答自成一组）。最后一组用于定位到最新一轮 */
export function groupTurns(items: readonly DisplayItem[]): DisplayItem[][] {
  const turns: DisplayItem[][] = [];
  for (const item of items) {
    const last = turns.at(-1);
    if (item.kind === 'user' || !last || last.at(-1)?.kind === 'assistant') turns.push([item]);
    else last.push(item);
  }
  return turns;
}

/** 最近一次带发送计划的回答的计划（侧边栏顶部的当前页信息从它取，C3） */
export function latestPlan(
  messages: readonly MessageView[],
  job: JobLike | null,
): RequestContextPlan | undefined {
  if (job?.plan) return job.plan;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'assistant' && m.plan) return m.plan;
  }
  return undefined;
}

/**
 * 「换个模型再试」（H12）：找出某条助手消息对应的发问（问题文字与引用），换个模型重新问一遍要用同样的内容。
 * 本地暂存的用户消息靠 pairedMessageId 对上；快照来的消息靠「紧挨在它前面那条用户消息」对上
 * （一问一答按顺序落库，见 jobs.ts 的落库时机）。两边都对不上（消息还没来得及出现在列表里）时返回 null
 */
export function questionForJob(
  messages: readonly MessageView[],
  jobMessageId: string,
): { text: string; quote: QuoteSummary | null; request?: AskRequest } | null {
  const of = (m: UserMessageView) => ({
    text: m.text,
    quote: m.quote ?? null,
    ...(m.request ? { request: m.request } : {}),
  });
  for (const m of messages) {
    if (m.role === 'user' && m.pairedMessageId === jobMessageId) return of(m);
  }
  const idx = messages.findIndex((m) => m.id === jobMessageId);
  const prev = idx > 0 ? messages[idx - 1] : undefined;
  return prev && prev.role === 'user' ? of(prev) : null;
}
