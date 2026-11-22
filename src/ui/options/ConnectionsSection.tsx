// 连接管理（H2、H5、H7、H9、H11）：多个连接各自起名；预设服务商；地址、Key、自定义请求头、逐字输出、
// 额外请求参数；测试连接（失败原因、服务器原始报错、浏览器错误码、缺 /v1 一键改地址重测、一键复制诊断）；
// 拉取模型列表后勾选常用模型（可搜索）；每个常用模型的能力判断可以手动改。
// 编辑器里的字段点「保存」才落盘；常用模型与能力覆盖是即点即存，直接改存储里的那条连接。
import { useState } from 'preact/hooks';
import type { Settings } from '@/core/domain/settings';
import type { Connection, ModelCapabilities, Tri } from '@/core/llm/adapter';
import { PROVIDER_PRESETS } from '@/core/llm/presets';
import { listModels, testConnection } from './api';
import { ModelList } from './ModelList';
import {
  applyPreset,
  blankConnection,
  type CapabilityPatch,
  capabilityRow,
  displayBaseUrl,
  formatExtraParams,
  type HeaderRow,
  headerRows,
  headersFromRows,
  MAX_COMMON_MODELS,
  mergeConnectionForm,
  parseExtraParams,
  presetOf,
  removeConnection,
  resolveApiKey,
  setCapabilityOverride,
  setDefaultModel,
  toggleCommonModel,
  upsertConnection,
} from './model';
import { Field, SecretInput } from './parts';
import { S } from './strings';
import { type TestOutcome, TestResultView } from './TestResultView';
import type { SettingsHandle } from './useSettings';

const SENSITIVE_HEADER = /auth|key|token|secret|cookie/i;
const THINKING_VALUES: readonly ModelCapabilities['thinking'][] = ['none', 'toggle', 'effort', 'unknown'];
const VISION_VALUES: readonly Tri[] = ['yes', 'no', 'unknown'];

/** 即点即存的改动：取存储里最新的那条连接来改，不经过编辑器草稿 */
function changeStored(
  handle: SettingsHandle,
  connectionId: string,
  change: (conn: Connection, settings: Settings) => Connection,
): Promise<boolean> {
  return handle.set((s) => {
    const current = s.connections.find((c) => c.id === connectionId);
    return current ? upsertConnection(s, change(current, s)).settings : s;
  });
}

export function ConnectionsSection({ handle }: { handle: SettingsHandle }) {
  const { settings } = handle;
  const [editing, setEditing] = useState<{ conn: Connection; isNew: boolean } | null>(null);

  async function remove(conn: Connection): Promise<void> {
    const isDefault = settings.defaultModel?.connectionId === conn.id;
    const message = isDefault ? S.conn.confirmRemoveDefault(conn.name) : S.conn.confirmRemove(conn.name);
    if (!window.confirm(message)) return;
    const ok = await handle.set((s) => removeConnection(s, conn.id));
    if (ok && editing?.conn.id === conn.id) setEditing(null);
  }

  return (
    <div class="opt-conns">
      {settings.connections.length === 0 && <div class="opt-muted">{S.conn.empty}</div>}
      <ul class="opt-list">
        {settings.connections.map((conn) => (
          <li key={conn.id} class="opt-list__item" data-testid="connection-item">
            <div class="opt-list__main">
              <div class="opt-list__title">
                {conn.name}
                {settings.defaultModel?.connectionId === conn.id && (
                  <span class="opt-badge">{S.conn.isDefault}</span>
                )}
              </div>
              <div class="opt-list__sub">{displayBaseUrl(conn.baseUrl)}</div>
            </div>
            <button type="button" class="ra-btn" onClick={() => setEditing({ conn, isNew: false })}>
              {S.conn.edit}
            </button>
            <button type="button" class="ra-btn" onClick={() => void remove(conn)}>
              {S.conn.remove}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        class="ra-btn"
        onClick={() => setEditing({ conn: blankConnection(crypto.randomUUID()), isNew: true })}
      >
        {S.conn.add}
      </button>
      {editing && (
        <ConnectionEditor
          key={editing.conn.id}
          handle={handle}
          initial={editing.conn}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ConnectionEditor(props: {
  handle: SettingsHandle;
  initial: Connection;
  isNew: boolean;
  onClose: () => void;
}) {
  const { handle } = props;
  const { settings } = handle;
  const [draft, setDraft] = useState<Connection>(props.initial);
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [clearKey, setClearKey] = useState(false);
  const [headers, setHeaders] = useState<HeaderRow[]>(() => headerRows(props.initial.headers));
  const [extraText, setExtraText] = useState(() => formatExtraParams(props.initial.extraParams));
  const [testModel, setTestModel] = useState(
    () =>
      (settings.defaultModel?.connectionId === props.initial.id ? settings.defaultModel.model : undefined) ??
      props.initial.models?.[0] ??
      '',
  );
  const [fetched, setFetched] = useState<readonly string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [listMessage, setListMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'list' | null>(null);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  /** 存储里的这条连接（保存过才有）：常用模型、能力覆盖以它为准 */
  const stored = settings.connections.find((c) => c.id === draft.id);
  const extra = parseExtraParams(extraText, draft.interfaceType);
  const preset = presetOf(draft.preset);
  const uid = draft.id;

  const patch = (p: Partial<Connection>) => {
    setDraft((d) => ({ ...d, ...p }));
    setSavedFlash(false);
  };

  /** 校验并保存编辑器里的字段；返回保存后的连接，没存成返回 undefined（原因已显示） */
  async function save(override: Partial<Connection> = {}): Promise<Connection | undefined> {
    const h = headersFromRows(headers);
    if (!h.ok) {
      setFormError(h.error);
      return undefined;
    }
    if (!extra.ok) {
      setFormError(`${S.conn.extra}：${extra.error}`);
      return undefined;
    }
    setFormError(null);
    const next: Connection = { ...draft, headers: h.headers, extraParams: extra.value, ...override };
    const saved = await handle.update((s) => {
      const current = s.connections.find((c) => c.id === next.id);
      const merged = mergeConnectionForm(current, {
        ...next,
        apiKey: resolveApiKey(current?.apiKey ?? '', keyInput, clearKey),
      });
      const r = upsertConnection(s, merged);
      return { settings: r.settings, result: r.saved };
    });
    if (!saved) return undefined;
    // Key 存好就不再留在输入框里（不回显已存的 Key）
    setDraft(saved);
    setKeyInput('');
    setShowKey(false);
    setClearKey(false);
    return saved;
  }

  async function handleSave(): Promise<void> {
    setBusy('save');
    try {
      if (await save()) setSavedFlash(true);
    } finally {
      setBusy(null);
    }
  }

  async function runTest(conn: Connection, model: string): Promise<void> {
    const at = Date.now();
    const result = await testConnection(conn.id, model);
    if (!result?.ok) {
      setOutcome({ at, model, result: result ?? 'noReply' });
      return;
    }
    // 第一次测通：顺手把它设成默认模型、记进常用模型，用户不用再去别处点一遍（H1）
    let note: string | undefined;
    if (!settings.defaultModel) {
      const ok = await handle.set((s) => {
        const current = s.connections.find((c) => c.id === conn.id);
        if (!current || s.defaultModel) return s;
        const r = upsertConnection(s, toggleCommonModel(current, model, true));
        return setDefaultModel(r.settings, { connectionId: conn.id, model });
      });
      if (ok) note = S.test.setDefault;
    }
    setOutcome({ at, model, result, ...(note !== undefined ? { note } : {}) });
  }

  async function handleTest(): Promise<void> {
    const model = testModel.trim();
    if (model === '') {
      setFormError(S.conn.needModel);
      return;
    }
    setBusy('test');
    setOutcome(null);
    try {
      const saved = await save();
      if (saved) await runTest(saved, model);
    } finally {
      setBusy(null);
    }
  }

  /** 缺 /v1：改成后台探测出的地址，保存后重测 */
  async function handleApplySuggested(url: string): Promise<void> {
    const model = testModel.trim();
    setBusy('test');
    try {
      const saved = await save({ baseUrl: url });
      if (saved && model !== '') await runTest(saved, model);
    } finally {
      setBusy(null);
    }
  }

  async function handleList(): Promise<void> {
    setBusy('list');
    setListMessage(null);
    try {
      const saved = await save();
      if (!saved) return;
      const r = await listModels(saved.id);
      if (r.ok) {
        setFetched(r.models);
        setListMessage(S.conn.listed(r.models.length));
        if (testModel.trim() === '' && r.models[0] !== undefined) setTestModel(r.models[0]);
      } else {
        setListMessage(S.conn.listFailed);
      }
    } finally {
      setBusy(null);
    }
  }

  const hasStoredKey = (stored?.apiKey ?? '') !== '';

  return (
    <div class="opt-editor" data-testid="connection-editor">
      <div class="opt-editor__title">{props.isNew && !stored ? S.conn.editorNew : S.conn.editorEdit}</div>

      <Field label={S.conn.preset} for={`preset-${uid}`} help={S.conn.presetHelp}>
        <select
          id={`preset-${uid}`}
          class="opt-select opt-select--wide"
          value={preset ? draft.preset : 'custom'}
          onChange={(e) => {
            const next = applyPreset(draft, (e.target as HTMLSelectElement).value);
            setDraft(next);
            setSavedFlash(false);
          }}
        >
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label={S.conn.name} for={`name-${uid}`}>
        <input
          id={`name-${uid}`}
          class="opt-input"
          value={draft.name}
          onInput={(e) => patch({ name: (e.target as HTMLInputElement).value })}
        />
      </Field>

      <Field label={S.conn.baseUrl} for={`url-${uid}`} help={S.conn.baseUrlHelp}>
        <input
          id={`url-${uid}`}
          class="opt-input"
          placeholder="https://…/v1"
          value={draft.baseUrl}
          onInput={(e) => patch({ baseUrl: (e.target as HTMLInputElement).value })}
        />
      </Field>

      <Field
        label={S.conn.apiKey}
        for="connection-api-key"
        help={
          <>
            {S.conn.apiKeyHelp}
            {preset?.apiKeyUrl && (
              <>
                {' '}
                <a class="opt-link" href={preset.apiKeyUrl} target="_blank" rel="noreferrer">
                  {S.conn.getKey}
                </a>
              </>
            )}
          </>
        }
      >
        <div class="opt-inline">
          <SecretInput
            id="connection-api-key"
            shown={showKey}
            disabled={clearKey}
            placeholder={hasStoredKey ? S.conn.apiKeyPlaceholderSaved : S.conn.apiKeyPlaceholderNew}
            value={keyInput}
            onInput={(value) => {
              setKeyInput(value);
              setSavedFlash(false);
            }}
          />
          <button type="button" class="ra-btn" onClick={() => setShowKey((v) => !v)}>
            {showKey ? S.conn.apiKeyHide : S.conn.apiKeyShow}
          </button>
        </div>
        {hasStoredKey && !clearKey && keyInput === '' && (
          <button type="button" class="opt-link" onClick={() => setClearKey(true)}>
            {S.conn.apiKeyClear}
          </button>
        )}
        {clearKey && (
          <div class="opt-help">
            {S.conn.apiKeyWillClear}{' '}
            <button type="button" class="opt-link" onClick={() => setClearKey(false)}>
              {S.conn.apiKeyUndoClear}
            </button>
          </div>
        )}
      </Field>

      <div class="opt-field">
        <div class="opt-field__label">{S.conn.headers}</div>
        {headers.map((row, i) => (
          <div key={i} class="opt-inline opt-header-row">
            <input
              class="opt-input"
              aria-label={S.conn.headerNameLabel(i + 1)}
              placeholder={S.conn.headerName}
              value={row.name}
              onInput={(e) => {
                const name = (e.target as HTMLInputElement).value;
                setHeaders((rows) => rows.map((r, j) => (j === i ? { ...r, name } : r)));
              }}
            />
            <SecretInput
              shown={!SENSITIVE_HEADER.test(row.name)}
              label={S.conn.headerValueLabel(i + 1)}
              placeholder={S.conn.headerValue}
              value={row.value}
              onInput={(value) => setHeaders((rows) => rows.map((r, j) => (j === i ? { ...r, value } : r)))}
            />
            <button
              type="button"
              class="ra-btn"
              onClick={() => setHeaders((rows) => rows.filter((_, j) => j !== i))}
            >
              {S.conn.headerRemove}
            </button>
          </div>
        ))}
        <button
          type="button"
          class="ra-btn ra-btn--small"
          onClick={() => setHeaders((rows) => [...rows, { name: '', value: '' }])}
        >
          {S.conn.headerAdd}
        </button>
        <div class="opt-help">{S.conn.headersHelp}</div>
      </div>

      <div class="opt-field">
        <label class="opt-check">
          <input
            type="checkbox"
            checked={draft.stream}
            onChange={(e) => patch({ stream: (e.target as HTMLInputElement).checked })}
          />
          <span class="opt-field__label">{S.conn.stream}</span>
        </label>
        <div class="opt-help">{S.conn.streamHelp}</div>
      </div>

      <Field label={S.conn.extra} for={`extra-${uid}`} help={S.conn.extraHelp}>
        <textarea
          id={`extra-${uid}`}
          class="opt-input opt-textarea opt-mono"
          rows={3}
          spellcheck={false}
          placeholder='{"temperature": 0.3}'
          value={extraText}
          onInput={(e) => {
            setExtraText((e.target as HTMLTextAreaElement).value);
            setSavedFlash(false);
          }}
        />
        {!extra.ok && <div class="opt-error">{extra.error}</div>}
        {extra.ok && extra.ignored.length > 0 && (
          <div class="opt-warn" data-testid="extra-ignored">
            {S.conn.extraIgnored(extra.ignored)}
          </div>
        )}
      </Field>

      <Field label={S.conn.testModel} for={`test-model-${uid}`} help={S.conn.testModelHelp}>
        <input
          id={`test-model-${uid}`}
          class="opt-input"
          list={`models-${uid}`}
          value={testModel}
          onInput={(e) => setTestModel((e.target as HTMLInputElement).value)}
        />
        <datalist id={`models-${uid}`}>
          {[...new Set([...(stored?.models ?? []), ...fetched])].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Field>

      <div class="opt-editor__actions">
        <button
          type="button"
          class="ra-btn ra-btn--primary"
          disabled={busy !== null}
          onClick={() => void handleSave()}
        >
          {busy === 'save' ? S.conn.saving : S.conn.save}
        </button>
        <button type="button" class="ra-btn" disabled={busy !== null} onClick={() => void handleTest()}>
          {busy === 'test' ? S.conn.testing : S.conn.test}
        </button>
        <button type="button" class="ra-btn" disabled={busy !== null} onClick={() => void handleList()}>
          {busy === 'list' ? S.conn.listing : S.conn.listModels}
        </button>
        <button type="button" class="ra-btn" onClick={props.onClose}>
          {S.conn.close}
        </button>
        {savedFlash && <span class="opt-saved">{S.page.saved}</span>}
      </div>

      {formError && <div class="opt-error">{formError}</div>}
      {handle.saveError && <div class="opt-error">{handle.saveError}</div>}
      {listMessage && (
        <div class="opt-muted" role="status">
          {listMessage}
        </div>
      )}
      {outcome && stored && (
        <TestResultView
          outcome={outcome}
          conn={stored}
          busy={busy !== null}
          onApplySuggested={(url) => void handleApplySuggested(url)}
        />
      )}

      {stored && <CommonModels handle={handle} conn={stored} fetched={fetched} />}
    </div>
  );
}

/** 常用模型（H5）与能力覆盖（H11）：即点即存 */
function CommonModels(props: { handle: SettingsHandle; conn: Connection; fetched: readonly string[] }) {
  const { handle, conn } = props;
  const { settings } = handle;
  const [manual, setManual] = useState('');
  const chosen = conn.models ?? [];
  const available = [...new Set([...chosen, ...props.fetched])];
  const isDefault = (m: string) =>
    settings.defaultModel?.connectionId === conn.id && settings.defaultModel.model === m;

  const toggle = (model: string, on: boolean) =>
    void changeStored(handle, conn.id, (c) => toggleCommonModel(c, model, on));
  const override = (model: string, patch: CapabilityPatch) =>
    void changeStored(handle, conn.id, (c) => setCapabilityOverride(c, model, patch));

  function addManual(): void {
    const name = manual.trim();
    if (name === '') return;
    toggle(name, true);
    setManual('');
  }

  return (
    <div class="opt-subsection" data-testid="common-models">
      <div class="opt-subsection__title">
        {S.models.heading}
        <span class="opt-muted">{S.models.count(chosen.length, MAX_COMMON_MODELS)}</span>
      </div>
      <div class="opt-help">{S.models.help}</div>
      {available.length === 0 ? (
        <div class="opt-muted">{S.models.notFetched}</div>
      ) : (
        <ModelList
          models={available}
          mode="check"
          selected={chosen}
          max={MAX_COMMON_MODELS}
          onToggle={toggle}
        />
      )}
      <div class="opt-inline">
        <input
          class="opt-input"
          aria-label={S.models.manual}
          placeholder={S.models.manualPlaceholder}
          value={manual}
          onInput={(e) => setManual((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && addManual()}
        />
        <button type="button" class="ra-btn" onClick={addManual}>
          {S.models.manualAdd}
        </button>
      </div>

      {chosen.length > 0 && (
        <>
          <div class="opt-subsection__title">{S.cap.heading}</div>
          <div class="opt-help">{S.cap.help}</div>
          <ul class="opt-caps" data-testid="capability-table">
            {chosen.map((m) => {
              const row = capabilityRow(conn, m);
              const o = conn.capabilityOverrides?.[m];
              const changed =
                row.overridden.thinking || row.overridden.vision || row.overridden.contextWindow;
              return (
                <li key={m} class="opt-cap" data-model={m}>
                  <div class="opt-cap__head">
                    <span class="opt-mono opt-cap__name">{m}</span>
                    {isDefault(m) && <span class="opt-badge">{S.models.isDefault}</span>}
                    {changed && <span class="opt-badge opt-badge--muted">{S.cap.changed}</span>}
                    <span class="opt-cap__spacer" />
                    {!isDefault(m) && (
                      <button
                        type="button"
                        class="ra-btn ra-btn--small"
                        onClick={() =>
                          void handle.set((s) => setDefaultModel(s, { connectionId: conn.id, model: m }))
                        }
                      >
                        {S.models.setDefault}
                      </button>
                    )}
                    <button
                      type="button"
                      class="ra-btn ra-btn--small"
                      aria-label={S.models.removeLabel(m)}
                      onClick={() => toggle(m, false)}
                    >
                      {S.models.remove}
                    </button>
                  </div>
                  <div class="opt-cap__fields">
                    <label class="opt-cap__field">
                      <span>{S.cap.thinking}</span>
                      <select
                        class="opt-select"
                        aria-label={S.cap.thinkingLabel(m)}
                        value={o?.thinking ?? ''}
                        onChange={(e) => {
                          const v = (e.target as HTMLSelectElement).value;
                          override(m, {
                            thinking: v === '' ? undefined : (v as ModelCapabilities['thinking']),
                          });
                        }}
                      >
                        <option value="">{S.cap.builtin(S.cap.thinkingValue[row.builtin.thinking])}</option>
                        {THINKING_VALUES.map((v) => (
                          <option key={v} value={v}>
                            {S.cap.thinkingValue[v]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label class="opt-cap__field">
                      <span>{S.cap.vision}</span>
                      <select
                        class="opt-select"
                        aria-label={S.cap.visionLabel(m)}
                        value={o?.vision ?? ''}
                        onChange={(e) => {
                          const v = (e.target as HTMLSelectElement).value;
                          override(m, { vision: v === '' ? undefined : (v as Tri) });
                        }}
                      >
                        <option value="">{S.cap.builtin(S.cap.visionValue[row.builtin.vision])}</option>
                        {VISION_VALUES.map((v) => (
                          <option key={v} value={v}>
                            {S.cap.visionValue[v]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label class="opt-cap__field">
                      <span>{S.cap.context}</span>
                      <input
                        class="opt-input opt-input--num"
                        type="number"
                        min={1}
                        step={1000}
                        aria-label={S.cap.contextLabel(m)}
                        placeholder={S.cap.contextPlaceholder(row.builtin.contextWindow)}
                        value={o?.contextWindow ?? ''}
                        onChange={(e) => {
                          const n = Math.floor(Number((e.target as HTMLInputElement).value));
                          override(m, { contextWindow: Number.isFinite(n) && n >= 1 ? n : undefined });
                        }}
                      />
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
