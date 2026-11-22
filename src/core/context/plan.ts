// 请求装配计划（5.9）：每次请求一份，随消息保存；「实际发送说明」从它派生（规则 8）。
import type { BlockId, ContentVersion, ContextSnapshotId, DocumentId, PageKey } from '../domain/ids';
import type { ModelRef } from '../llm/adapter';

/** 回答长度档（I2） */
export type LengthTier = 'brief' | 'normal' | 'detailed';
/** 页面上下文档位（三档） */
export type ContextTier = 'selection' | 'nearby' | 'fullPage';
/** 思考强度（H6），出厂默认 off；模型只支持开关时 low/medium/high 都按「开」发送 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export interface Budget {
  /** 模型硬上限；能力表未知时按 32k 保守值 */
  hardLimit: number;
  /** min(4096, 20% 硬上限) */
  outputReserve: number;
  /** 硬上限 × speedSoftBudgetRatio（默认 50%） */
  speedSoftBudget: number;
  /** 软预算 × summaryReadRatio（默认 30%） */
  summaryRead: number;
}

export const UNKNOWN_CONTEXT_LIMIT = 32_000;
export const DEFAULT_BUDGET_RATIOS = { speedSoftBudgetRatio: 0.5, summaryReadRatio: 0.3 } as const;

const validRatio = (r: number | undefined, fallback: number) =>
  r !== undefined && Number.isFinite(r) && r > 0 && r <= 1 ? r : fallback;

/** 比例取自设置（Settings.context）；非法输入（NaN、负数、越界）退回默认值，结果不会是 NaN 或负数 */
export function defaultBudget(
  hardLimit: number = UNKNOWN_CONTEXT_LIMIT,
  ratios: { speedSoftBudgetRatio?: number; summaryReadRatio?: number } = {},
): Budget {
  const limit = Number.isFinite(hardLimit) && hardLimit >= 1 ? Math.floor(hardLimit) : UNKNOWN_CONTEXT_LIMIT;
  const soft = validRatio(ratios.speedSoftBudgetRatio, DEFAULT_BUDGET_RATIOS.speedSoftBudgetRatio);
  const summary = validRatio(ratios.summaryReadRatio, DEFAULT_BUDGET_RATIOS.summaryReadRatio);
  const speedSoftBudget = Math.floor(limit * soft);
  return {
    hardLimit: limit,
    outputReserve: Math.min(4096, Math.floor(limit * 0.2)),
    speedSoftBudget,
    summaryRead: Math.floor(speedSoftBudget * summary),
  };
}

export interface RequestContextPlan {
  contextSnapshotId: ContextSnapshotId;
  pageKey?: PageKey;
  documentId?: DocumentId;
  contentVersion?: ContentVersion;
  model: ModelRef;
  lengthTier: LengthTier;
  contextTier: ContextTier;
  thinking: ThinkingLevel;
  /** 选中文字超过 48 KB 被截断（界面写明「选区过长，只发送了前 N 字」） */
  selectionTruncated: boolean;
  /** 站点为「不读取」时为 false，此时只带选中文字 */
  pageRead: boolean;
  /** 实际发送的块，按发送顺序；引用编号只能取自这里 */
  sentBlockIds: readonly BlockId[];
  /** 已发送文本 / 可提取正文文本 */
  coverage: { sentChars: number; extractableChars: number };
  /** 历史因预算丢弃到第几轮；historyHasPageText 为真时界面提示「历史中仍包含之前发送的原文」 */
  droppedHistoryTurns: number;
  historyHasPageText: boolean;
  /** 降档时移除了先前请求里的页面全文 */
  removedEarlierPageText: boolean;
  imageCount: number;
  budget: Budget;
  estimatedInputTokens: number;
  /** 抽取的不确定项，原样展示 */
  notes: readonly string[];
  /**
   * 实体回指（D5、contract-v1.4 增量）：因回指并入 nearby 发送内容的块号，是 sentBlockIds 的子集；
   * 只在 nearby 档且命中时才有
   */
  entityBlockIds?: readonly BlockId[];
  /** 识别出但全页只在选区处出现过一次的实体原文；界面据此提示「答案可能在别处，可切换全文」 */
  entitySingleMentions?: readonly string[];
  /**
   * 页面图片（E2、5.14「页面图片（可选）」，contract-v1.5 增量）：这次附带的页面图片地址，按发送顺序；
   * 只在设置开着、且确实取到了图片时才有。发送说明据此展开后列出地址（规则 8：URL 在发送说明中可见）
   */
  pageImageUrls?: readonly string[];
}

/**
 * 中日韩文字与全角符号：CJK 标点、假名、注音、扩展 A、基本区、谚文、兼容区、全角形式、扩展 B 以后。
 * 按码点判断，扩展 B 区的字（代理对）算一个字
 */
const CJK =
  /[\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{3ffff}]/u;

/** token 估算（5.9）：中日韩文字约 1 字 1 个，其他约 4 字符 1 个，留保守余量 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil((cjk + other / 4) * 1.1);
}
