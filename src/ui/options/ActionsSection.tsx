// 动作与工具栏（A2、A3）：工具栏按钮的顺序、放不放在工具栏、停用；自定义动作的增删改
// （名字、提示词、作用范围：选中内容 / 整页、是否先让用户输入）。即点即存；自定义动作的表单点「保存动作」才落盘。
import { useState } from 'preact/hooks';
import type { ActionId } from '@/core/domain/actions';
import {
  type ActionRow,
  actionRows,
  blankCustomAction,
  type CustomActionDraft,
  type CustomActionErrors,
  customActionDraft,
  moveToolbarAction,
  removeCustomAction,
  setActionHidden,
  setOnToolbar,
  toolbarPlacement,
  upsertCustomAction,
  validateCustomAction,
} from './model';
import { Field } from './parts';
import { S } from './strings';
import type { SettingsHandle } from './useSettings';

export function ActionsSection({ handle }: { handle: SettingsHandle }) {
  const { settings } = handle;
  const [form, setForm] = useState<CustomActionDraft | null>(null);
  const [errors, setErrors] = useState<CustomActionErrors>({});
  const rows = actionRows(settings);
  const placement = toolbarPlacement(settings);
  const onToolbar = rows.filter((r) => r.toolbarIndex >= 0);

  async function saveForm(): Promise<void> {
    if (!form) return;
    const found = validateCustomAction(form, settings);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (await handle.set((s) => upsertCustomAction(s, form, crypto.randomUUID()))) setForm(null);
  }

  async function remove(row: ActionRow): Promise<void> {
    if (!window.confirm(S.actions.confirmRemove(row.def.label))) return;
    await handle.set((s) => removeCustomAction(s, row.def.id));
    if (form?.id === row.def.id) setForm(null);
  }

  const move = (id: ActionId, delta: -1 | 1) => void handle.set((s) => moveToolbarAction(s, id, delta));

  return (
    <div class="opt-actions">
      <div class="opt-help">{S.actions.help}</div>
      <ul class="opt-list" data-testid="action-list">
        {rows.map((row) => {
          const name = row.def.label;
          const place = placement.get(row.def.id);
          const first = onToolbar[0]?.def.id === row.def.id;
          const last = onToolbar[onToolbar.length - 1]?.def.id === row.def.id;
          return (
            <li key={row.def.id} class="opt-list__item opt-action" data-action-id={row.def.id}>
              <div class="opt-list__main">
                <div class="opt-list__title">
                  {name}
                  <span class="opt-badge opt-badge--muted">
                    {row.custom ? S.actions.custom : S.actions.builtin}
                  </span>
                  {place && (
                    <span class="opt-badge" data-testid="action-place">
                      {place.overflow ? S.actions.overflow : S.actions.position(place.position)}
                    </span>
                  )}
                </div>
                <div class="opt-list__sub">
                  {S.actions.scope[row.def.scope]}
                  {row.custom && (
                    <span class="opt-action__edit">
                      <button
                        type="button"
                        class="opt-link"
                        aria-label={S.actions.editLabel(name)}
                        onClick={() => {
                          setErrors({});
                          setForm(customActionDraft(row.def));
                        }}
                      >
                        {S.actions.edit}
                      </button>
                      <button
                        type="button"
                        class="opt-link"
                        aria-label={S.actions.removeLabel(name)}
                        onClick={() => void remove(row)}
                      >
                        {S.actions.remove}
                      </button>
                    </span>
                  )}
                </div>
              </div>
              <label class="opt-check">
                <input
                  type="checkbox"
                  aria-label={S.actions.toolbarLabel(name)}
                  checked={row.toolbarIndex >= 0}
                  onChange={(e) => {
                    const on = (e.target as HTMLInputElement).checked;
                    void handle.set((s) => setOnToolbar(s, row.def.id, on));
                  }}
                />
                {S.actions.toolbar}
              </label>
              <button
                type="button"
                class="ra-btn ra-btn--small"
                aria-label={S.actions.upLabel(name)}
                disabled={row.toolbarIndex < 0 || first}
                onClick={() => move(row.def.id, -1)}
              >
                {S.actions.up}
              </button>
              <button
                type="button"
                class="ra-btn ra-btn--small"
                aria-label={S.actions.downLabel(name)}
                disabled={row.toolbarIndex < 0 || last}
                onClick={() => move(row.def.id, 1)}
              >
                {S.actions.down}
              </button>
              <label class="opt-check">
                <input
                  type="checkbox"
                  aria-label={S.actions.hiddenLabel(name)}
                  checked={row.hidden}
                  onChange={(e) => {
                    const hidden = (e.target as HTMLInputElement).checked;
                    void handle.set((s) => setActionHidden(s, row.def.id, hidden));
                  }}
                />
                {S.actions.hidden}
              </label>
            </li>
          );
        })}
      </ul>
      <div class="opt-help">{S.actions.hiddenHelp}</div>

      {form === null ? (
        <button
          type="button"
          class="ra-btn"
          onClick={() => {
            setErrors({});
            setForm(blankCustomAction());
          }}
        >
          {S.actions.add}
        </button>
      ) : (
        <div class="opt-editor" data-testid="action-form">
          <div class="opt-editor__title">{form.id ? S.actions.formEdit : S.actions.formNew}</div>
          <Field label={S.actions.name} for="action-name" help={S.actions.nameHelp}>
            <input
              id="action-name"
              class="opt-input"
              maxLength={40}
              value={form.label}
              onInput={(e) => setForm({ ...form, label: (e.target as HTMLInputElement).value })}
            />
            {errors.label && <div class="opt-error">{errors.label}</div>}
          </Field>
          <Field label={S.actions.prompt} for="action-prompt" help={S.actions.promptHelp}>
            <textarea
              id="action-prompt"
              class="opt-input opt-textarea"
              rows={4}
              value={form.prompt}
              onInput={(e) => setForm({ ...form, prompt: (e.target as HTMLTextAreaElement).value })}
            />
            {errors.prompt && <div class="opt-error">{errors.prompt}</div>}
          </Field>
          <Field label={S.actions.scopeLabel} for="action-scope" help={S.actions.scopeHelp}>
            <select
              id="action-scope"
              class="opt-select opt-select--wide"
              value={form.scope}
              onChange={(e) =>
                setForm({
                  ...form,
                  scope: (e.target as HTMLSelectElement).value as CustomActionDraft['scope'],
                })
              }
            >
              <option value="selection">{S.actions.scope.selection}</option>
              <option value="page">{S.actions.scope.page}</option>
            </select>
          </Field>
          <div class="opt-field">
            <label class="opt-check">
              <input
                type="checkbox"
                checked={form.needsInput}
                onChange={(e) => setForm({ ...form, needsInput: (e.target as HTMLInputElement).checked })}
              />
              <span class="opt-field__label">{S.actions.needsInput}</span>
            </label>
            <div class="opt-help">{S.actions.needsInputHelp}</div>
          </div>
          {errors.count && <div class="opt-error">{errors.count}</div>}
          {handle.saveError && <div class="opt-error">{handle.saveError}</div>}
          <div class="opt-editor__actions">
            <button type="button" class="ra-btn ra-btn--primary" onClick={() => void saveForm()}>
              {S.actions.save}
            </button>
            <button type="button" class="ra-btn" onClick={() => setForm(null)}>
              {S.actions.cancel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
