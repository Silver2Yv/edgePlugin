// IndexedDB 表结构（5.11）。只定义记录形状、主键与索引；打开与迁移在 platform/。
import type { Anchor, CitationRef } from '../anchor/anchor';
import type { ContextTier, LengthTier, RequestContextPlan, ThinkingLevel } from '../context/plan';
import type { FinishReason, ModelErrorKind, ModelRef, Usage } from '../llm/adapter';
import type { ActionId } from './actions';
import type {
  AttemptId,
  BlobId,
  BlockId,
  ClientRequestId,
  ContentVersion,
  ContextSnapshotId,
  ConversationId,
  FavoriteId,
  JobId,
  MessageId,
  PageKey,
} from './ids';
import type { InterruptReason, JobState, StopReason } from './job';

export interface PageRecord {
  pageKey: PageKey;
  host: string;
  url: string;
  title: string;
  updatedAt: number;
  /** 上次总结的消息与它基于的内容版本；版本不一致时标注「基于旧版本」 */
  lastSummary?: { messageId: MessageId; contentVersion: ContentVersion };
}

export interface ConversationRecord {
  id: ConversationId;
  pageKey?: PageKey;
  title: string;
  model: ModelRef;
  /** 对话级档位与思考强度（D3、H6）；不填跟随设置默认值 */
  contextTier?: ContextTier;
  lengthTier?: LengthTier;
  thinking?: ThinkingLevel;
  turns: number;
  /** 当前修订号；每次写入消息加一 */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = 'user' | 'assistant';

/** 内容分段：正文文本，或引用（渲染时校验是否属于发送集合） */
export type ContentSegment =
  | { kind: 'text'; text: string }
  | { kind: 'citation'; ref: CitationRef; quote?: string };

export interface MessageRecord {
  id: MessageId;
  conversationId: ConversationId;
  /** 对话内第几条，从 0 起（与增量的 seq 无关） */
  ordinal: number;
  role: MessageRole;
  segments: readonly ContentSegment[];
  reasoning?: string;
  /** 用户消息为 completed；助手消息跟随任务状态 */
  status: Exclude<JobState, 'idle'>;
  /** 仅助手消息：终态的原因与错误（错误信息已脱敏、限长） */
  finishReason?: FinishReason;
  stopReason?: StopReason;
  interruptReason?: InterruptReason;
  error?: { kind: ModelErrorKind; message: string };
  /** 实际使用的模型（J10） */
  model?: ModelRef;
  usage?: Usage;
  /** 仅助手消息：产出它的发问、任务与尝试（D-03）；clientRequestId 有唯一索引，用于去重 */
  clientRequestId?: ClientRequestId;
  jobId?: JobId;
  attemptId?: AttemptId;
  /**
   * 仅助手消息：这次请求的发送计划。随消息永久保存，快照过期后「实际发送说明」仍可显示（规则 8）
   */
  plan?: RequestContextPlan;
  contextSnapshotId?: ContextSnapshotId;
  /** 仅用户消息：发问时的动作与档位（重试按它重建请求） */
  request?: { actionId: ActionId; contextTier: ContextTier; lengthTier: LengthTier; thinking: ThinkingLevel };
  /** 仅用户消息：选中文字与锚点；truncated 表示超过 48 KB 被截断 */
  selection?: { text: string; truncated: boolean; originalLength: number; anchor?: Anchor };
  createdAt: number;
  updatedAt: number;
}

/** 实际发送的页面块文本（引用回查用）。计划在消息里，这里只放大块文本，可被清理 */
export interface SnapshotRecord {
  id: ContextSnapshotId;
  conversationId: ConversationId;
  pageKey?: PageKey;
  contentVersion?: ContentVersion;
  blocks: readonly { id: BlockId; text: string }[];
  /** 被收藏引用的次数；> 0 不随 7 天清理。过期后引用只能按引用原文定位 */
  refCount: number;
  expiresAt: number;
}

export interface FavoriteRecord {
  id: FavoriteId;
  pageKey: PageKey;
  selection: string;
  /** 原文快照 */
  sourceText: string;
  anchor?: Anchor;
  answer: string;
  source: { conversationId: ConversationId; messageId: MessageId };
  blobIds: readonly BlobId[];
  createdAt: number;
}

export interface BlobRecord {
  id: BlobId;
  mime: string;
  data: Blob;
  refCount: number;
  createdAt: number;
}

export const DB_NAME = 'reading-assistant';
export const DB_VERSION = 1;
/** 无人引用的页面快照保留天数 */
export const SNAPSHOT_TTL_MS = 7 * 24 * 3600 * 1000;

type KeyPath = string | readonly string[];
/** 普通索引直接写键路径；唯一索引写 { keyPath, unique: true }（缺该字段的记录不进索引） */
type IndexDef = KeyPath | { keyPath: KeyPath; unique: true };
interface StoreDef {
  keyPath: string;
  indexes: Readonly<Record<string, IndexDef>>;
}

/** 表名 → 主键与索引；platform/ 按它建表，版本升级时对照迁移 */
export const DB_STORES = {
  pages: { keyPath: 'pageKey', indexes: { byUpdatedAt: 'updatedAt', byHost: 'host' } },
  conversations: {
    keyPath: 'id',
    indexes: { byPageUpdated: ['pageKey', 'updatedAt'], byUpdatedAt: 'updatedAt' },
  },
  messages: {
    keyPath: 'id',
    indexes: {
      byConversationOrdinal: { keyPath: ['conversationId', 'ordinal'], unique: true },
      byClientRequest: { keyPath: 'clientRequestId', unique: true },
      byJob: 'jobId',
      // 启动扫描 accepted / streaming 的消息
      byStatus: 'status',
    },
  },
  snapshots: {
    keyPath: 'id',
    indexes: {
      byConversation: 'conversationId',
      byPageKey: 'pageKey',
      byRefCount: 'refCount',
      byExpiresAt: 'expiresAt',
    },
  },
  favorites: { keyPath: 'id', indexes: { byPage: 'pageKey', byCreatedAt: 'createdAt' } },
  blobs: { keyPath: 'id', indexes: { byRefCount: 'refCount' } },
} as const satisfies Record<string, StoreDef>;

export type StoreName = keyof typeof DB_STORES;

export interface DbRecords {
  pages: PageRecord;
  conversations: ConversationRecord;
  messages: MessageRecord;
  snapshots: SnapshotRecord;
  favorites: FavoriteRecord;
  blobs: BlobRecord;
}
