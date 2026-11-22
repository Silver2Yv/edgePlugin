// 本页对话列表（C2）：侧边栏头部的小下拉，列出当前页面的历史对话，点一条切换过去（continue 的权限仍由
// 后台按页面归属判定，这里只负责发订阅）。只在有页面身份（pageKey）时可用。
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConversationRecord } from '@/core/domain/records';
import { T } from '../strings';
import { type OpDeps, queryHistory } from './conv-ops';

const LIMIT = 10;

export interface ConversationSwitcherProps {
  deps: OpDeps;
  pageKey: string | null;
  currentConversationId: string | null;
  disabled: boolean;
  onSelect: (conversationId: string) => void;
}

export function ConversationSwitcher({
  deps,
  pageKey,
  currentConversationId,
  disabled,
  onSelect,
}: ConversationSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ConversationRecord[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || pageKey === null) return;
    void queryHistory(deps, { pageKey, limit: LIMIT }).then((r) => {
      if (r.ok) setItems([...r.value.items]);
    });
  }, [open, pageKey]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (pageKey === null) return null;

  return (
    <div className="ra-conv-switcher" ref={rootRef}>
      <button
        type="button"
        className="ra-btn ra-btn--small"
        title={T.panel.pageConversationsTitle}
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {T.panel.pageConversations}
      </button>
      {open && (
        <div className="ra-conv-switcher__panel" data-testid="conversation-switcher">
          {items.length === 0 && <p className="ra-empty">{T.history.empty}</p>}
          {items.map((c) => (
            <button
              key={c.id}
              type="button"
              className="ra-panel-item ra-panel-item--compact"
              data-conversation-id={c.id}
              aria-current={c.id === currentConversationId}
              onClick={() => {
                setOpen(false);
                onSelect(c.id);
              }}
            >
              <span className="ra-panel-item__title">{c.title || T.page.untitled}</span>
              <span className="ra-panel-item__meta">{new Date(c.updatedAt).toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
