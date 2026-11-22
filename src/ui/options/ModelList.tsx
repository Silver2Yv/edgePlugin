// 模型列表（H5）：可搜索——公司中转站上有一百多个模型。两种用法：勾选常用模型（多选），或向导里选默认模型（单选）。
import { useState } from 'preact/hooks';
import { filterModels } from './model';
import { S } from './strings';

export function ModelList(props: {
  models: readonly string[];
  mode: 'check' | 'radio';
  selected: readonly string[];
  onToggle: (model: string, on: boolean) => void;
  /** 多选时的上限；到了上限，没勾的不能再勾 */
  max?: number;
}) {
  const [query, setQuery] = useState('');
  const shown = filterModels(props.models, query);
  const full = props.max !== undefined && props.selected.length >= props.max;
  return (
    <div class="opt-models">
      <input
        class="opt-input"
        type="search"
        aria-label={S.models.search}
        placeholder={S.models.searchPlaceholder}
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
      />
      <div class="opt-models__list" role={props.mode === 'radio' ? 'radiogroup' : 'group'}>
        {shown.length === 0 && <div class="opt-muted opt-models__empty">{S.models.none}</div>}
        {shown.map((m) => {
          const on = props.selected.includes(m);
          return (
            <label key={m} class="opt-models__item">
              <input
                type={props.mode === 'radio' ? 'radio' : 'checkbox'}
                name={props.mode === 'radio' ? 'opt-model-choice' : undefined}
                aria-label={props.mode === 'radio' ? m : S.models.checkLabel(m)}
                checked={on}
                disabled={props.mode === 'check' && !on && full}
                onChange={(e) => props.onToggle(m, (e.target as HTMLInputElement).checked)}
              />
              <span class="opt-models__name">{m}</span>
            </label>
          );
        })}
      </div>
      <div class="opt-muted opt-models__count">{S.models.shown(shown.length, props.models.length)}</div>
    </div>
  );
}
