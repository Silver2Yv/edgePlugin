// 收藏导出（G2、G6）：纯函数，把收藏记录格式化成结构化 Markdown——原文片段、笔记、来源链接、时间、回答分开。
// 不碰扩展 API、不碰 DOM；触发下载在 ui/panel/export.ts。
import type { FavoriteRecord } from './records';

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 一条收藏的标题：用户编辑过的优先，否则取选中文字/问题开头 */
export function favoriteTitle(fav: FavoriteRecord): string {
  const t = fav.title?.trim();
  if (t) return t;
  const src = fav.selection.trim().replace(/\s+/g, ' ');
  const cps = [...src];
  return cps.length > 40 ? `${cps.slice(0, 39).join('')}…` : cps.join('') || '（无标题）';
}

/** 单条收藏的 Markdown：标题 → 来源链接与时间 → 原文 → 回答（若有）→ 笔记（若有） */
export function favoriteMarkdown(fav: FavoriteRecord): string {
  const lines: string[] = [
    `## ${favoriteTitle(fav)}`,
    '',
    `- 来源：${fav.url}`,
    `- 时间：${fmtTime(fav.createdAt)}`,
  ];
  lines.push('', '### 原文', '', fav.sourceText || fav.selection);
  if (fav.answer !== undefined) lines.push('', '### 回答', '', fav.answer);
  if (fav.note?.trim()) lines.push('', '### 笔记', '', fav.note.trim());
  return lines.join('\n');
}

/** 多条收藏合成一份文档，每条之间用分隔线隔开 */
export function favoritesMarkdown(favs: readonly FavoriteRecord[]): string {
  return favs.map(favoriteMarkdown).join('\n\n---\n\n');
}
