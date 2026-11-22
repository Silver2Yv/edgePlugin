// 「实际发送说明」（B8、规则 8）与侧边栏顶部的当前页信息（C3）：都从发送计划（RequestContextPlan）派生，
// 界面显示的和发出去的出自同一份数据。纯逻辑。
//
// 一行小字：选中多少字 · 带了前后几段 / 全文 · 全文共多少字（是否截断）· 计划里的说明（plan.notes，
// 回指命中几处、只出现一次的提示、抽取的不确定项都由后台写进 notes，这里原样显示）。
// 没带上页面内容的（站点「不读取页面内容」、读取失败等）只显示选中字数与「未读取页面」（ARCHITECTURE 4.1），
// 原因放在展开后的明细里。
import type { RequestContextPlan } from '@/core/context/plan';
import { T } from '../strings';

export interface SendSummary {
  /** 一行小字的各段，界面用「 · 」连起来 */
  parts: string[];
  /** 展开后的明细：上面各段 + 其余说明，一条一行 */
  details: string[];
}

/**
 * selectedChars：这次发问选中了多少字（来自对应的用户消息）；不知道时，没带页面内容的请求用计划里的
 * 已发送字数代替（那时发送的只有选中文字）
 */
export function sendSummary(plan: RequestContextPlan, selectedChars: number | null): SendSummary {
  const { sentChars, extractableChars } = plan.coverage;
  const selected = selectedChars ?? (!plan.pageRead && sentChars > 0 ? sentChars : null);
  const parts: string[] = [];
  if (selected !== null && selected > 0)
    parts.push(
      T.sent.selected(selected) + (plan.selectionTruncated ? `（${T.sent.selectionTruncated}）` : ''),
    );

  const extra: string[] = [];
  if (!plan.pageRead) {
    // 想带页面却没带上时计划里有说明；用户自己选了「只看选中」则没有
    if (plan.notes.length > 0) parts.push(T.sent.notRead);
    else parts.push(parts.length > 0 ? T.sent.selectionOnly : T.sent.nothing);
    extra.push(...plan.notes);
  } else {
    if (plan.contextTier === 'nearby') parts.push(T.sent.nearby(plan.sentBlockIds.length));
    else parts.push(sentChars < extractableChars ? T.sent.fullPagePartial(sentChars) : T.sent.fullPage);
    parts.push(T.sent.pageTotal(extractableChars));
    parts.push(...plan.notes);
  }
  // 框选截图（E1、5.9 图片单列）：附了几张图照实写
  if (plan.imageCount > 0) parts.push(T.capture.sent(plan.imageCount));
  if (plan.droppedHistoryTurns > 0) extra.push(T.sent.droppedHistory(plan.droppedHistoryTurns));
  if (plan.historyHasPageText) extra.push(T.sent.historyHasPageText);
  if (plan.removedEarlierPageText) extra.push(T.sent.removedEarlierPageText);
  extra.push(T.sent.estimatedTokens(plan.estimatedInputTokens), T.sent.model(plan.model.model));
  return { parts, details: [...new Set([...parts, ...extra])] };
}

/** 侧边栏顶部「当前页信息」里从计划能知道的部分；没有计划（还没发过问）时为 null */
export interface PageInfo {
  /** 能读取的正文字数；这次没带页面内容时为 null */
  readableChars: number | null;
  /** 带全文时有没有截断；不是带全文的请求说不上截断，为 null */
  truncated: boolean | null;
  /** 想带页面内容却没带上（站点不读取、读取失败等，计划里有说明） */
  notRead: boolean;
}

export function pageInfo(plan: RequestContextPlan | undefined): PageInfo | null {
  if (!plan) return null;
  if (!plan.pageRead) return { readableChars: null, truncated: null, notRead: plan.notes.length > 0 };
  return {
    readableChars: plan.coverage.extractableChars,
    truncated:
      plan.contextTier === 'fullPage' ? plan.coverage.sentChars < plan.coverage.extractableChars : null,
    notRead: false,
  };
}
