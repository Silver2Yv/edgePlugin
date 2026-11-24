// 收藏（G2 侧边栏「收藏」视图）：列表、搜索、编辑（标题 / 笔记）、删除、导出 Markdown（单条 / 全部 / 按页面）。
// 列表与搜索直接只读查询 IndexedDB（5.4，favorites-db.ts）；写入（编辑、删除）经后台（conv-ops.ts）。
// favorite/changed 广播到达时（SidePanelApp 转成 refreshSeq 递增）重新查询。
import { useEffect, useState } from 'preact/hooks';
import { favoriteTitle } from '@/core/domain/favorite-export';
import type { FavoriteRecord } from '@/core/domain/records';
import { T } from '../strings';
import { type OpDeps, removeFavorite, updateFavorite } from './conv-ops';
import { exportFavorite, exportFavorites } from './export';
import { readOnlyDb } from './favorites-db';
import { favoriteMatches } from './favorites-search';

const PAGE_SIZE = 30;
/** 搜索单次最多扫描这么多条收藏（和 history.ts 的 SEARCH_SCAN_MAX 同一个口径：先简单实现，达到实测阈值再优化） */
const SEARCH_SCAN_MAX = 300;

export interface FavoritesViewProps {
  deps: OpDeps;
  pageKey: string | null;
  refreshSeq: number;
  /** 「回到原文」（决策 098）：打开或切到收藏时的页面并定位；不给就不显示按钮 */
  onJump?: (f: FavoriteRecord) => void;
  /** 上一次回到原文还没有结果：先不让再点 */
  jumping?: boolean;
}

interface Loaded {
  items: FavoriteRecord[];
  nextBefore?: number;
}

async function load(pageKey: string | undefined, needle: string, before?: number): Promise<Loaded> {
  const db = readOnlyDb();
  if (!needle) {
    const rows = await db.listFavorites({
      ...(pageKey ? { pageKey } : {}),
      ...(before === undefined ? {} : { before }),
      limit: PAGE_SIZE + 1,
    });
    const items = rows.slice(0, PAGE_SIZE);
    const tail = items.at(-1);
    return rows.length > PAGE_SIZE && tail ? { items, nextBefore: tail.createdAt } : { items };
  }
  const items: FavoriteRecord[] = [];
  let cursor = before;
  let scanned = 0;
  for (;;) {
    const rows = await db.listFavorites({
      ...(pageKey ? { pageKey } : {}),
      ...(cursor === undefined ? {} : { before: cursor }),
      limit: 50,
    });
    for (const f of rows) {
      scanned++;
      cursor = f.createdAt;
      if (favoriteMatches(f, needle)) items.push(f);
      if (items.length >= PAGE_SIZE || scanned >= SEARCH_SCAN_MAX) return { items, nextBefore: cursor };
    }
    if (rows.length < 50) return { items };
  }
}

export function FavoritesView({ deps, pageKey, refreshSeq, onJump, jumping }: FavoritesViewProps) {
  const [scope, setScope] = useState<'all' | 'page'>('all');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<FavoriteRecord[]>([]);
  const [nextBefore, setNextBefore] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const effectiveScope = scope === 'page' && pageKey !== null ? pageKey : undefined;

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    void load(effectiveScope, query.trim()).then((r) => {
      if (stale) return;
      setLoading(false);
      setItems(r.items);
      setNextBefore(r.nextBefore);
    });
    return () => {
      stale = true;
    };
  }, [effectiveScope, query, refreshSeq]);

  const loadMore = () => {
    if (nextBefore === undefined || loading) return;
    setLoading(true);
    void load(effectiveScope, query.trim(), nextBefore).then((r) => {
      setLoading(false);
      setItems((prev) => [...prev, ...r.items]);
      setNextBefore(r.nextBefore);
    });
  };

  const startEdit = (f: FavoriteRecord) => {
    setEditingId(f.id);
    setDraftTitle(f.title ?? '');
    setDraftNote(f.note ?? '');
  };

  const saveEdit = (id: string) => {
    const title = draftTitle.trim();
    const note = draftNote.trim();
    setEditingId(null);
    setItems((prev) => prev.map((f) => (f.id === id ? { ...f, title, note } : f)));
    void updateFavorite(deps, id, { title, note }).then((r) => {
      if (!r.ok) setError(T.favorites.updateFailed(r.reason));
    });
  };

  const handleDelete = (id: string) => {
    setConfirmId(null);
    setItems((prev) => prev.filter((f) => f.id !== id));
    void removeFavorite(deps, id).then((r) => {
      if (!r.ok) setError(T.favorites.deleteFailed(r.reason));
    });
  };

  const handleExportAll = () => {
    if (items.length === 0) return;
    exportFavorites(items, scope === 'page' ? '本页收藏.md' : '全部收藏.md');
  };

  return (
    <div className="ra-panel-view" data-testid="favorites-view">
      <div className="ra-panel-toolbar">
        <input
          type="text"
          className="ra-panel-search"
          data-testid="favorites-search"
          placeholder={T.favorites.searchPlaceholder}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          aria-label={T.favorites.searchPlaceholder}
        />
      </div>
      <div className="ra-panel-toolbar">
        {pageKey !== null && (
          <div className="ra-segmented">
            <button
              type="button"
              className="ra-segmented__btn"
              aria-pressed={scope === 'page'}
              onClick={() => setScope('page')}
            >
              本页
            </button>
            <button
              type="button"
              className="ra-segmented__btn"
              aria-pressed={scope === 'all'}
              onClick={() => setScope('all')}
            >
              全部
            </button>
          </div>
        )}
        <button
          type="button"
          className="ra-btn ra-btn--small"
          onClick={handleExportAll}
          disabled={items.length === 0}
        >
          {scope === 'page' ? T.favorites.exportPage : T.favorites.exportAll}
        </button>
      </div>
      {error && <p className="ra-note ra-note--error">{error}</p>}
      <div className="ra-panel-list" data-testid="favorites-list">
        {items.length === 0 && !loading && (
          <p className="ra-empty">{query.trim() ? T.favorites.noMatch : T.favorites.empty}</p>
        )}
        {items.map((f) => (
          <div className="ra-panel-item ra-panel-item--block" key={f.id} data-testid="favorite-item">
            {editingId === f.id ? (
              <div className="ra-favorite-edit">
                <label className="ra-favorite-edit__label" htmlFor={`fav-title-${f.id}`}>
                  {T.favorites.titleLabel}
                </label>
                <input
                  id={`fav-title-${f.id}`}
                  type="text"
                  className="ra-panel-search"
                  placeholder={T.favorites.titlePlaceholder}
                  value={draftTitle}
                  onInput={(e) => setDraftTitle((e.target as HTMLInputElement).value)}
                />
                <label className="ra-favorite-edit__label" htmlFor={`fav-note-${f.id}`}>
                  {T.favorites.noteLabel}
                </label>
                <textarea
                  id={`fav-note-${f.id}`}
                  className="ra-favorite-edit__note"
                  data-testid="favorite-note-input"
                  placeholder={T.favorites.notePlaceholder}
                  value={draftNote}
                  onInput={(e) => setDraftNote((e.target as HTMLTextAreaElement).value)}
                />
                <div className="ra-actions">
                  <button
                    type="button"
                    className="ra-btn ra-btn--primary ra-btn--small"
                    data-testid="favorite-save-edit"
                    onClick={() => saveEdit(f.id)}
                  >
                    {T.favorites.save}
                  </button>
                  <button type="button" className="ra-btn ra-btn--small" onClick={() => setEditingId(null)}>
                    {T.favorites.cancel}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="ra-panel-item__title">{favoriteTitle(f)}</div>
                <div className="ra-favorite-text">{f.sourceText || f.selection}</div>
                {f.answer !== undefined && (
                  <details className="ra-fold">
                    <summary>{T.favorites.answerLabel}</summary>
                    <div className="ra-favorite-text">{f.answer}</div>
                  </details>
                )}
                {f.note && <div className="ra-favorite-note">{f.note}</div>}
                <div className="ra-panel-item__meta">
                  <a href={f.url} target="_blank" rel="noreferrer">
                    {T.favorites.source}
                  </a>
                  {' · '}
                  {new Date(f.createdAt).toLocaleString()}
                </div>
                <div className="ra-actions">
                  {onJump && (
                    <button
                      type="button"
                      className="ra-btn ra-btn--small"
                      data-testid="favorite-jump"
                      title={T.favorites.jumpTitle}
                      disabled={jumping === true}
                      onClick={() => onJump(f)}
                    >
                      {T.favorites.jump}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ra-btn ra-btn--small"
                    data-testid="favorite-edit"
                    onClick={() => startEdit(f)}
                  >
                    {T.favorites.edit}
                  </button>
                  <button
                    type="button"
                    className="ra-btn ra-btn--small"
                    data-testid="favorite-export"
                    onClick={() => exportFavorite(f)}
                  >
                    {T.favorites.exportOne}
                  </button>
                  {confirmId === f.id ? (
                    <button
                      type="button"
                      className="ra-btn ra-btn--small ra-btn--danger"
                      data-testid="favorite-delete-confirm"
                      onClick={() => handleDelete(f.id)}
                    >
                      {T.favorites.deleteConfirmBtn}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="ra-btn ra-btn--small"
                      data-testid="favorite-delete"
                      title={T.favorites.deleteConfirm}
                      onClick={() => setConfirmId(f.id)}
                    >
                      {T.favorites.delete}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
        {nextBefore !== undefined && (
          <button type="button" className="ra-btn" onClick={loadMore} disabled={loading}>
            {loading ? T.favorites.loading : T.favorites.loadMore}
          </button>
        )}
      </div>
    </div>
  );
}
