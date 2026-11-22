// 收藏导出下载（G2）：Blob + <a download>，不申请 downloads 权限。格式化逻辑在 core/domain/favorite-export.ts（纯函数）。
import { favoriteMarkdown, favoritesMarkdown, favoriteTitle } from '@/core/domain/favorite-export';
import type { FavoriteRecord } from '@/core/domain/records';

function slug(s: string): string {
  const cps = [...s.trim()].slice(0, 40).join('');
  return cps.replace(/[\\/:*?"<>|]/g, '_') || 'favorite';
}

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // 下一轮事件循环再释放：部分浏览器在同步段里 revoke 会让尚未触发的下载失败
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportFavorite(fav: FavoriteRecord): void {
  download(`${slug(favoriteTitle(fav))}.md`, favoriteMarkdown(fav));
}

export function exportFavorites(favs: readonly FavoriteRecord[], filename: string): void {
  download(filename, favoritesMarkdown(favs));
}
