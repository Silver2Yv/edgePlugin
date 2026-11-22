// 历史（C5）：按页面或网站分组、可搜索（标题与正文）、可删除（就地确认，不用模态）、分页加载。
// 列表数据经后台 history/query（conv-ops.ts 按 queryId 关联分批应答）；点一条交给父组件（SidePanelApp）处理
// 「打开」——同一个机制既用于只读查看也用于续问，续问是否允许由后台按页面归属判定（5.12）。
import { useEffect, useState } from 'preact/hooks';
import type { ConversationRecord } from '@/core/domain/records';
import { T } from '../strings';
import { deleteHistoryConversation, type OpDeps, queryHistory } from './conv-ops';
import { groupHistory } from './history-group';

const PAGE_SIZE = 30;

export interface HistoryViewProps {
  deps: OpDeps;
  /** 当前标签页的页面身份；为 null（非 http(s) 页面等）时「本页」范围不可用 */
  pageKey: string | null;
  onOpen: (conversationId: string) => void;
}

export function HistoryView({ deps, pageKey, onOpen }: HistoryViewProps) {
  const [scope, setScope] = useState<'all' | 'page'>('all');
  const [groupBy, setGroupBy] = useState<'page' | 'host'>('page');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ConversationRecord[]>([]);
  const [nextBefore, setNextBefore] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  const effectiveScope = scope === 'page' && pageKey !== null ? pageKey : undefined;

  // 范围、分组、搜索词变了：清空重新查询
  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    void queryHistory(deps, {
      limit: PAGE_SIZE,
      ...(effectiveScope === undefined ? {} : { pageKey: effectiveScope }),
      ...(query.trim() ? { text: query.trim() } : {}),
    }).then((r) => {
      if (stale) return;
      setLoading(false);
      if (!r.ok) {
        setError(r.reason);
        return;
      }
      setItems([...r.value.items]);
      setNextBefore(r.value.nextBefore);
    });
    return () => {
      stale = true;
    };
  }, [effectiveScope, query, reloadSeq]);

  const loadMore = () => {
    if (nextBefore === undefined || loading) return;
    setLoading(true);
    void queryHistory(deps, {
      limit: PAGE_SIZE,
      before: nextBefore,
      ...(effectiveScope === undefined ? {} : { pageKey: effectiveScope }),
      ...(query.trim() ? { text: query.trim() } : {}),
    }).then((r) => {
      setLoading(false);
      if (!r.ok) {
        setError(r.reason);
        return;
      }
      setItems((prev) => [...prev, ...r.value.items]);
      setNextBefore(r.value.nextBefore);
    });
  };

  const handleDelete = (id: string) => {
    setConfirmId(null);
    void deleteHistoryConversation(deps, id).then((r) => {
      if (!r.ok) {
        setError(T.history.deleteFailed(r.reason));
        return;
      }
      setItems((prev) => prev.filter((c) => c.id !== id));
    });
  };

  const groups = groupHistory(items, groupBy);

  return (
    <div className="ra-panel-view" data-testid="history-view">
      <div className="ra-panel-toolbar">
        <input
          type="text"
          className="ra-panel-search"
          data-testid="history-search"
          placeholder={T.history.searchPlaceholder}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          aria-label={T.history.searchPlaceholder}
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
        <div className="ra-segmented">
          <button
            type="button"
            className="ra-segmented__btn"
            aria-pressed={groupBy === 'page'}
            onClick={() => setGroupBy('page')}
          >
            {T.history.group.byPage}
          </button>
          <button
            type="button"
            className="ra-segmented__btn"
            aria-pressed={groupBy === 'host'}
            onClick={() => setGroupBy('host')}
          >
            {T.history.group.byHost}
          </button>
        </div>
      </div>
      {error && (
        <p className="ra-note ra-note--error">
          {error}
          <button type="button" className="ra-btn ra-btn--small" onClick={() => setReloadSeq((n) => n + 1)}>
            重试
          </button>
        </p>
      )}
      <div className="ra-panel-list" data-testid="history-list">
        {items.length === 0 && !loading && (
          <p className="ra-empty">{query.trim() ? T.history.noMatch : T.history.empty}</p>
        )}
        {groups.map((g) => (
          <section className="ra-panel-group" key={g.key}>
            <h3 className="ra-panel-group__title">{g.label}</h3>
            {g.items.map((c) => (
              <div className="ra-panel-item" key={c.id} data-testid="history-item">
                <button
                  type="button"
                  className="ra-panel-item__main"
                  data-conversation-id={c.id}
                  onClick={() => onOpen(c.id)}
                >
                  <span className="ra-panel-item__title">{c.title || T.page.untitled}</span>
                  <span className="ra-panel-item__meta">
                    {T.history.turns(c.turns)} · {new Date(c.updatedAt).toLocaleString()}
                  </span>
                </button>
                {confirmId === c.id ? (
                  <button
                    type="button"
                    className="ra-btn ra-btn--small ra-btn--danger"
                    data-testid="history-delete-confirm"
                    data-conversation-id={c.id}
                    onClick={() => handleDelete(c.id)}
                  >
                    {T.history.deleteConfirmBtn}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ra-icon-btn"
                    data-testid="history-delete"
                    data-conversation-id={c.id}
                    aria-label={T.history.delete}
                    title={T.history.deleteConfirm}
                    onClick={() => setConfirmId(c.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </section>
        ))}
        {nextBefore !== undefined && (
          <button type="button" className="ra-btn" onClick={loadMore} disabled={loading}>
            {loading ? T.history.loading : T.history.loadMore}
          </button>
        )}
      </div>
    </div>
  );
}
