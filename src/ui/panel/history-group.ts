// 历史分组（C5）：按页面或按网站把对话列表分成若干组，纯逻辑，便于单测。
import type { ConversationRecord } from '@/core/domain/records';

export interface HistoryGroup {
  /** 分组键：按页面是 pageKey，按网站是主机名；取不到页面身份的对话单独归进「其他」 */
  key: string;
  /** 分组标题：按页面取主机名 + 路径，按网站就是主机名 */
  label: string;
  items: ConversationRecord[];
}

const OTHER = '（无法识别的页面）';

function hostOf(pageKey: string | undefined): string | undefined {
  if (pageKey === undefined) return undefined;
  try {
    return new URL(pageKey).hostname;
  } catch {
    return undefined;
  }
}

function pageLabel(pageKey: string): string {
  try {
    const u = new URL(pageKey);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return pageKey;
  }
}

/** 按 updatedAt 降序的输入分组，组内顺序不变；组的顺序按组内最新一条排 */
export function groupHistory(
  items: readonly ConversationRecord[],
  by: 'page' | 'host',
): readonly HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
  for (const c of items) {
    const key = by === 'page' ? (c.pageKey ?? OTHER) : (hostOf(c.pageKey) ?? OTHER);
    const label = key === OTHER ? OTHER : by === 'page' ? pageLabel(key) : key;
    const g = groups.get(key);
    if (g) g.items.push(c);
    else groups.set(key, { key, label, items: [c] });
  }
  return [...groups.values()];
}
