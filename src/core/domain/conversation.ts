// 对话的纯逻辑（5.5、5.11；D12、D13）：续接规则、标题、从库里的消息重建装配用的历史、订阅快照分批。
// 不依赖扩展接口与数据库，后台（background/jobs.ts、history.ts）与单测共用。
import type { AskTurn } from '../prompt/ask';
import { jsonStringBytes, splitByJsonBytes } from './bytes';
import { JOB_LIMITS } from './job';
import { type BackgroundToClient, messageBytes } from './messages';
import type { ContentSegment, ConversationRecord, MessageRecord } from './records';

/**
 * 续接规则（D13）：不指定对话的发问与订阅，只在「距上次在该页提问不超过 30 分钟、且已有轮数少于 20」时
 * 接上该页最近的对话；否则新建（发问）或显示空的新对话（订阅）
 */
export const CONTINUE_LIMITS = {
  idleMs: 30 * 60 * 1000,
  maxTurns: 20,
} as const;

/** 不续接、新建对话的原因（conv/accepted 带给界面，提示「已开启新对话，旧的仍可在历史里找回」） */
export type NewConversationReason = NonNullable<
  Extract<BackgroundToClient, { type: 'conv/accepted' }>['newConversation']
>;

export function continuation(
  conv: Pick<ConversationRecord, 'turns' | 'updatedAt' | 'lastAskedAt'>,
  now: number,
): { ok: true } | { ok: false; reason: NewConversationReason } {
  if (conv.turns >= CONTINUE_LIMITS.maxTurns) return { ok: false, reason: 'turnLimit' };
  const last = conv.lastAskedAt ?? conv.updatedAt;
  if (now - last > CONTINUE_LIMITS.idleMs) return { ok: false, reason: 'idle' };
  return { ok: true };
}

/** 对话标题的上限（码点） */
export const TITLE_MAX = 60;

/** 对话标题：第一次发问的问题；问题为空（直接发送的动作）用选中文字开头。单行、限长 */
export function conversationTitle(question: string, selectionText?: string): string {
  const src = question.trim() || selectionText?.trim() || '';
  const cps = [...src.replace(/\s+/g, ' ')];
  return cps.length > TITLE_MAX ? `${cps.slice(0, TITLE_MAX - 1).join('')}…` : cps.join('');
}

/** 消息的正文文字（分段里的文本按顺序拼接；引用取引用原文） */
export function segmentsText(segments: readonly ContentSegment[]): string {
  return segments.map((s) => (s.kind === 'text' ? s.text : (s.quote ?? ''))).join('');
}

/**
 * 从库里的消息（按 ordinal 升序）重建装配用的历史（5.9）：一问一答成对，只收回答已完成的轮次，
 * 与进程内「完成才记入历史」一致。用户消息取当时实际发送的全文（sentText，含 nearby 带的页面片段）；
 * 没有 sentText（装配前就结束的发问不会完成，不会走到这里；只防旧数据）时退回问题原文。
 * lastFullPage：最后一条带计划的助手消息发送了页面全文（下次降档时计划写明「已移除先前的全文」）
 */
export function turnsFromMessages(messages: readonly MessageRecord[]): {
  turns: AskTurn[];
  lastFullPage: boolean;
  nextOrdinal: number;
} {
  const turns: AskTurn[] = [];
  let lastFullPage = false;
  let nextOrdinal = 0;
  let user: MessageRecord | undefined;
  for (const m of messages) {
    nextOrdinal = Math.max(nextOrdinal, m.ordinal + 1);
    if (m.role === 'user') {
      user = m;
      continue;
    }
    if (m.plan) lastFullPage = m.plan.pageRead && m.plan.contextTier === 'fullPage';
    if (user && m.status === 'completed') {
      turns.push({
        user: user.sentText ?? segmentsText(user.segments),
        assistant: segmentsText(m.segments),
        hasPageText: user.selection !== undefined || m.plan?.pageRead === true,
      });
    }
    user = undefined;
  }
  return { turns, lastFullPage, nextOrdinal };
}

type SnapshotMsg = Extract<BackgroundToClient, { type: 'conv/snapshot' }>;

/** 快照里选中文字连同其他字段放不下时只给预览（与引用条同口径，前 2000 字） */
const SELECTION_PREVIEW = 2000;

/** 发给界面的消息：去掉只给装配用的字段（sentText） */
export function clientMessage(m: MessageRecord): MessageRecord {
  const { sentText: _sentText, ...rest } = m;
  return rest;
}

/**
 * 单条消息超过 budget 字节时切成几片：第一片带全部字段与正文开头；后面的续片 id 相同，只有分段与思考有意义，
 * 按顺序拼到前一片后面（见 messages.ts conv/snapshot 的说明）
 */
function pieces(m: MessageRecord, budget: number): MessageRecord[] {
  if (messageBytes(m) <= budget) return [m];
  let base: MessageRecord = { ...m, segments: [] };
  delete base.reasoning;
  if (base.selection && messageBytes(base) > budget / 2) {
    const cps = [...base.selection.text];
    base = {
      ...base,
      selection: {
        ...base.selection,
        text: cps.slice(0, SELECTION_PREVIEW).join(''),
        truncated: base.selection.truncated || cps.length > SELECTION_PREVIEW,
      },
    };
  }
  // 每片文字不超过预算的一半：续片的固定字段很小，第一片的固定字段一般也在一半以内
  const chunk = Math.max(1024, Math.floor(budget / 2) - 64);
  const parts: ({ segment: ContentSegment } | { reasoning: string })[] = [];
  if (m.reasoning) for (const r of splitByJsonBytes(m.reasoning, chunk)) parts.push({ reasoning: r });
  for (const s of m.segments) {
    if (s.kind === 'text' && jsonStringBytes(s.text) > chunk) {
      for (const t of splitByJsonBytes(s.text, chunk)) parts.push({ segment: { kind: 'text', text: t } });
    } else parts.push({ segment: s });
  }
  const cont: MessageRecord = {
    id: m.id,
    conversationId: m.conversationId,
    ordinal: m.ordinal,
    role: m.role,
    status: m.status,
    segments: [],
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
  const add = (to: MessageRecord, p: (typeof parts)[number]): MessageRecord =>
    'segment' in p
      ? { ...to, segments: [...to.segments, p.segment] }
      : { ...to, reasoning: (to.reasoning ?? '') + p.reasoning };
  const out: MessageRecord[] = [];
  let cur = base;
  let empty = true;
  for (const p of parts) {
    const next = add(cur, p);
    if (!empty && messageBytes(next) > budget) {
      out.push(cur);
      cur = add(cont, p);
    } else cur = next;
    empty = false;
  }
  out.push(cur);
  return out;
}

/**
 * 订阅快照（5.5）：对话与消息按 ordinal 升序分批，每批整条消息 JSON 不超过 maxBytes，最后一批 done。
 * 对话只放在第一批；没有对话时只发一批空的
 */
export function snapshotBatches(
  conversation: ConversationRecord | undefined,
  messages: readonly MessageRecord[],
  maxBytes: number = JOB_LIMITS.maxMessageBytes,
): SnapshotMsg[] {
  const revision = conversation?.revision ?? 0;
  const envelope = (first: boolean): SnapshotMsg => ({
    type: 'conv/snapshot',
    ...(first && conversation ? { conversation } : {}),
    messages: [],
    done: false,
    conversationRevision: revision,
  });
  // done 从 false 变成 true 多 1 字节
  const overhead = (first: boolean) => messageBytes(envelope(first)) + 1;
  const items = messages.flatMap((m) => pieces(clientMessage(m), maxBytes - overhead(true) - 1));
  const batches: SnapshotMsg[] = [];
  let cur = envelope(true);
  let size = overhead(true);
  for (const item of items) {
    const n = messageBytes(item);
    if (cur.messages.length > 0 && size + n + 1 > maxBytes) {
      batches.push(cur);
      cur = envelope(false);
      size = overhead(false);
    }
    size += n + (cur.messages.length > 0 ? 1 : 0);
    cur = { ...cur, messages: [...cur.messages, item] };
  }
  batches.push({ ...cur, done: true });
  return batches;
}
