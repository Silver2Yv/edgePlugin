// 模型下拉（H4、H5），小窗与侧边栏共用：按连接分组列出用户在设置里勾选的常用模型，可搜索（勾选多的时候），
// 没勾选过任何常用模型时退回只显示默认模型并提示去设置里勾选。做成窗内面板而不是原生下拉——面板自己定位、
// 定宽，不会超出小窗所在的 iframe（5.3 已知约束：原生下拉列表由浏览器画，不受布局限制，自定义面板才能控制）。
// 纯 UI；分组/过滤/候选等纯逻辑在 model/options.ts。
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Connection, ModelRef } from '@/core/llm/adapter';
import { filterGroups, modelGroups, SEARCH_THRESHOLD, sameModel, totalModels } from '../model/options';
import { T } from '../strings';

export interface ModelPickerProps {
  connections: readonly Connection[];
  /** 当前生效的模型（临时切换的，或设置里的默认值）；没有连接时为 null，整个控件不渲染 */
  value: ModelRef | null;
  defaultModel: ModelRef | null;
  /** 选了与默认值相同的模型按回到默认处理（null），其余传所选的模型（H4，和档位/思考同一套） */
  onChange: (model: ModelRef | null) => void;
}

export function ModelPicker(p: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  if (!p.value) return null;

  const groups = modelGroups(p.connections);
  const count = totalModels(groups);
  const shown = count > 0 ? filterGroups(groups, query) : groups;
  const changed = !sameModel(p.value, p.defaultModel);

  const pick = (ref: ModelRef | null) => {
    p.onChange(ref);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="ra-model-picker" ref={rootRef}>
      <button
        type="button"
        className="ra-select ra-model-btn"
        data-changed={changed}
        data-testid="model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={T.composer.modelLabel}
        title={T.composer.modelTitle(p.value.model)}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        {p.value.model}
      </button>
      {open && (
        <div className="ra-model-panel" role="listbox" data-testid="model-panel" onKeyDown={onKeyDown}>
          {count > SEARCH_THRESHOLD && (
            <input
              type="text"
              className="ra-model-search"
              data-testid="model-search"
              aria-label={T.composer.modelSearchLabel}
              placeholder={T.composer.modelSearchPlaceholder}
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={onKeyDown}
            />
          )}
          {count === 0 ? (
            <p className="ra-model-hint">{T.composer.modelNoCommon}</p>
          ) : (
            shown.map((g) => (
              <div className="ra-model-group" key={g.connectionId}>
                <p className="ra-model-group__name">{g.connectionName}</p>
                {g.models.map((m) => {
                  const ref: ModelRef = { connectionId: g.connectionId, model: m };
                  const selected = sameModel(ref, p.value);
                  return (
                    <button
                      type="button"
                      key={m}
                      role="option"
                      aria-selected={selected}
                      data-testid="model-option"
                      data-model={m}
                      className={selected ? 'ra-model-option ra-model-option--selected' : 'ra-model-option'}
                      onClick={() => pick(sameModel(ref, p.defaultModel) ? null : ref)}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
