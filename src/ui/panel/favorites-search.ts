// 收藏搜索的匹配规则（G2）：原文、标题、笔记、回答都算，纯函数便于单测；扫描循环在 FavoritesView 里。
import type { FavoriteRecord } from '@/core/domain/records';

export function favoriteMatches(f: FavoriteRecord, needle: string): boolean {
  const n = needle.trim().toLocaleLowerCase();
  if (!n) return true;
  return [f.title, f.selection, f.sourceText, f.answer, f.note].some((s) =>
    s?.toLocaleLowerCase().includes(n),
  );
}
