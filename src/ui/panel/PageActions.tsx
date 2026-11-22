// 整页快捷动作（C4）：总结本页 / 提取要点 / 这页在讲什么，以及 scope 为 page 的自定义动作。
// 只负责发起（conv/ask，actionId 对应、text 为动作问题、contextTier fullPage）；总结卡片（上次总结、重新总结）
// 是 cite 块的工作，这里不重复做。
import { useEffect, useState } from 'preact/hooks';
import { type ActionDef, BUILTIN_ACTIONS } from '@/core/domain/actions';
import { loadSettings } from '@/platform/settings-store';
import { T } from '../strings';

export interface PageActionsProps {
  /** label 用来构造这次发问显示的问题文字（与工具栏直接发送的动作同一套措辞，见 intents.ts 的 directQuestion） */
  onAsk: (actionId: ActionDef['id'], label: string) => void;
  disabled: boolean;
}

export function PageActions({ onAsk, disabled }: PageActionsProps) {
  const [actions, setActions] = useState<ActionDef[]>([]);

  useEffect(() => {
    let stale = false;
    void loadSettings().then((r) => {
      if (stale || !r.ok) return;
      const hidden = new Set(r.settings.hiddenActions);
      const all = [...BUILTIN_ACTIONS, ...r.settings.customActions];
      setActions(all.filter((a) => a.kind === 'model' && a.scope === 'page' && !hidden.has(a.id)));
    });
    return () => {
      stale = true;
    };
  }, []);

  if (actions.length === 0) return null;

  return (
    <div className="ra-page-actions" data-testid="page-actions">
      <span className="ra-page-actions__label">{T.panel.pageActions}</span>
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          className="ra-btn ra-btn--small"
          disabled={disabled}
          onClick={() => onAsk(a.id, a.label)}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
