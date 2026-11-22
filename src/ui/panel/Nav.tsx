// 侧边栏顶部的三个视图切换（对话 / 历史 / 收藏）：顶部分段按钮，保持小窗/侧边栏最小版已有的行为不变——
// 这一行只在侧边栏出现，不影响小窗。
import { T } from '../strings';

export type PanelView = 'chat' | 'history' | 'favorites';

export interface NavProps {
  view: PanelView;
  onChange: (view: PanelView) => void;
}

export function Nav({ view, onChange }: NavProps) {
  const tabs: { id: PanelView; label: string }[] = [
    { id: 'chat', label: T.panel.tabChat },
    { id: 'history', label: T.panel.tabHistory },
    { id: 'favorites', label: T.panel.tabFavorites },
  ];
  return (
    <div className="ra-nav" role="tablist" data-testid="panel-nav">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          className="ra-nav__btn"
          aria-selected={view === t.id}
          data-testid={`panel-nav-${t.id}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
