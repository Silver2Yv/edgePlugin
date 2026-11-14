// 任务状态机（5.5）与 D-03 的编号对应。
//
// D-03：一次发问 = 一个 clientRequestId = 一个 jobId = 一条助手消息（messageId）。
//   接单时后台在同一事务里写入用户消息与占位助手消息（状态 accepted），再开始网络请求。
//   重试不新建任务与消息：同一 jobId / messageId，换新 attemptId（见 canRetry）。
//
// 迁移时机：
//   accepted → streaming：网络请求发出的那一刻（requestSent 置真），不等首字节。
//     非流式路径同样先进 streaming，整段到达后直接 completed，中间没有增量。
//   终态不可覆盖：同一次尝试里第一个到达的终态落定，之后的迁移都被拒绝。
//
// 增量序号 seq：同一任务内单调递增，不随尝试重置。增量带 attemptId，客户端丢弃旧尝试的增量。
//   重试时旧尝试的内容保留到新尝试产出第一个增量，才整体替换（失败的重试不会清空旧回答）。
import type { AttemptId, ClientRequestId, ConversationId, JobId, MessageId } from './ids';

export type JobState = 'idle' | 'accepted' | 'streaming' | 'completed' | 'stopped' | 'interrupted' | 'failed';
export type TerminalJobState = Extract<JobState, 'completed' | 'stopped' | 'interrupted' | 'failed'>;

const TERMINAL: ReadonlySet<JobState> = new Set<JobState>(['completed', 'stopped', 'interrupted', 'failed']);
export const isTerminal = (s: JobState): s is TerminalJobState => TERMINAL.has(s);

const NEXT: Readonly<Record<JobState, readonly JobState[]>> = {
  idle: ['accepted'],
  accepted: ['streaming', 'stopped', 'interrupted', 'failed'],
  streaming: ['completed', 'stopped', 'interrupted', 'failed'],
  completed: [],
  stopped: [],
  interrupted: [],
  failed: [],
};

/** 同一次尝试内的迁移。终态没有出边 */
export function canTransition(from: JobState, to: JobState): boolean {
  return NEXT[from].includes(to);
}

/**
 * 重试：开一次新尝试（新 attemptId），任务回到 accepted。只有这几种终态可重试；
 * completed 不重试：「换个说法再答」是一次新的发问，有自己的 clientRequestId 与助手消息。
 */
const RETRYABLE: ReadonlySet<JobState> = new Set<JobState>(['failed', 'interrupted', 'stopped']);
export const canRetry = (s: JobState): boolean => RETRYABLE.has(s);

export type StopReason = 'user' | 'policyChanged';
export type InterruptReason = 'workerRestarted' | 'networkLost' | 'unknownOnStartup';

/**
 * 运行时任务记录，存 storage.session（5.5）。持久的真相是助手消息的 status。
 * 写入顺序：先写库（消息状态），再写 session。
 * 后台每次启动生成新的 workerEpoch。启动时：
 *   1. session 里 workerEpoch 与当前不同、且未到终态的记录 → interrupted（workerRestarted）；
 *   2. 库里 status 为 accepted / streaming、却没有对应运行时记录的消息 → interrupted（unknownOnStartup）。
 * 已推送的最后序号只留在内存，不进 session（每个增量都写 session 太贵）。
 */
export interface JobRecord {
  jobId: JobId;
  clientRequestId: ClientRequestId;
  conversationId: ConversationId;
  /** 本任务产出的助手消息（D-03） */
  messageId: MessageId;
  attemptId: AttemptId;
  /** 第几次尝试，从 1 起 */
  attempt: number;
  /** 接单时所在的后台实例 */
  workerEpoch: string;
  /** 接单时的对话修订号 */
  revision: number;
  state: JobState;
  /** 本次尝试的网络请求是否已发出（策略变更时决定继续还是取消，D-01） */
  requestSent: boolean;
  acceptedAt: number;
  updatedAt: number;
  stopReason?: StopReason;
  interruptReason?: InterruptReason;
}

/** 5.5 与 5.15 的初值 */
export const JOB_LIMITS = {
  /** 增量合并窗口 */
  deltaCoalesceMs: 40,
  /** 进行中内容写库间隔 */
  checkpointMs: 1500,
  /** 保活调用间隔 */
  keepaliveMs: 20_000,
  /** 跨进程单条消息上限（JSON 序列化后的 UTF-8 字节），超出拆包 */
  maxMessageBytes: 64 * 1024,
  /** 单个大字段（选区、问题、分片）的上限；余下 16 KB 留给其他字段 */
  maxFieldBytes: 48 * 1024,
} as const;
