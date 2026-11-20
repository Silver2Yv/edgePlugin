// 设置页（ARCHITECTURE 5.11「数据与存储 · 设置」、5.8「模型网关 · 测试连接」）。
// 只和后台通信（settings/ensureLocked、connection/test、connection/listModels），自己不做数据库写入，
// storage.local 的写入遵守 5.11 的顺序：先确认已收紧，再基于最新设置合并，整份 Settings 写回。
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { ContextTier } from '@/core/context/plan';
import type { OptionsToBackground } from '@/core/domain/messages';
import type { Settings } from '@/core/domain/settings';
import { normalizeSiteRule, type SiteRule } from '@/core/domain/site-policy';
import type { Connection, ModelError, ModelRef } from '@/core/llm/adapter';
import { loadSettings, SETTINGS_KEY } from '@/platform/settings-store';
import { ERROR_LABEL } from './error-labels';

// ───────────── 纯逻辑：与界面状态无关，方便单独看懂 ─────────────

function blankConnection(id: string): Connection {
  return {
    id,
    name: '新连接',
    preset: 'custom',
    baseUrl: '',
    apiKey: '',
    headers: {},
    interfaceType: 'chatCompletions',
    stream: true,
    extraParams: {},
    configVersion: 0,
  };
}

/** 地址只显示协议 + 主机 + 路径，不含查询串、片段，绝不显示 Key */
function displayBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return baseUrl.split(/[?#]/)[0] ?? '';
  }
}

/** 这几类字段改了，这条连接学到的能力表才需要失效（5.8 能力学习绑定） */
function protectedFieldsChanged(before: Connection, after: Connection): boolean {
  return (
    before.baseUrl !== after.baseUrl ||
    before.apiKey !== after.apiKey ||
    before.interfaceType !== after.interfaceType ||
    JSON.stringify(before.headers) !== JSON.stringify(after.headers) ||
    JSON.stringify(before.extraParams) !== JSON.stringify(after.extraParams)
  );
}

/** 把一条连接写进（或加进）settings.connections，按改动决定是否要让 configVersion 失效 */
function upsertConnection(base: Settings, draft: Connection): { settings: Settings; saved: Connection } {
  const prev = base.connections.find((c) => c.id === draft.id);
  const bump = prev ? protectedFieldsChanged(prev, draft) : false;
  const saved: Connection = { ...draft, configVersion: (prev?.configVersion ?? 0) + (bump ? 1 : 0) };
  const connections = prev
    ? base.connections.map((c) => (c.id === saved.id ? saved : c))
    : [...base.connections, saved];
  return { settings: { ...base, connections }, saved };
}

function isLockedTrue(r: unknown): boolean {
  return typeof r === 'object' && r !== null && (r as { locked?: unknown }).locked === true;
}

function isModelError(v: unknown): v is ModelError {
  return typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string';
}

/** 测试连接的应答：宽松校验，后台应答形状不对时返回 null（而不是抛错），界面据此显示兜底文案 */
function asConnectionTestResult(
  r: unknown,
):
  | { ok: true; model: string; reply: string; elapsedMs: number; reasoning: boolean }
  | { ok: false; error: ModelError; elapsedMs: number; suggestedBaseUrl?: string }
  | null {
  if (typeof r !== 'object' || r === null) return null;
  const o = r as Record<string, unknown>;
  if (
    o.ok === true &&
    typeof o.model === 'string' &&
    typeof o.reply === 'string' &&
    typeof o.elapsedMs === 'number' &&
    typeof o.reasoning === 'boolean'
  ) {
    return { ok: true, model: o.model, reply: o.reply, elapsedMs: o.elapsedMs, reasoning: o.reasoning };
  }
  if (o.ok === false && isModelError(o.error) && typeof o.elapsedMs === 'number') {
    return {
      ok: false,
      error: o.error,
      elapsedMs: o.elapsedMs,
      ...(typeof o.suggestedBaseUrl === 'string' ? { suggestedBaseUrl: o.suggestedBaseUrl } : {}),
    };
  }
  return null;
}

/** 拉取模型列表失败不细分原因，界面只提示「可以手填模型名」，所以这里只要能不能用 */
function listModelsOk(r: unknown): string[] | null {
  if (typeof r !== 'object' || r === null) return null;
  const o = r as Record<string, unknown>;
  if (o.ok === true && Array.isArray(o.models) && o.models.every((m) => typeof m === 'string')) {
    return o.models as string[];
  }
  return null;
}

function addKnownModel(
  map: Readonly<Record<string, readonly string[]>>,
  connId: string,
  model: string,
): Record<string, readonly string[]> {
  if (model === '') return map;
  const list = map[connId] ?? [];
  return list.includes(model) ? map : { ...map, [connId]: [...list, model] };
}

function mergeModels(existing: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([...existing, ...extra])];
}

function seedKnownModels(settings: Settings): Record<string, readonly string[]> {
  return settings.defaultModel ? { [settings.defaultModel.connectionId]: [settings.defaultModel.model] } : {};
}

interface ModelOption {
  connectionId: string;
  model: string;
  label: string;
}

function modelOptions(
  settings: Settings,
  knownModels: Readonly<Record<string, readonly string[]>>,
): ModelOption[] {
  const options: ModelOption[] = [];
  for (const conn of settings.connections) {
    const models = new Set(knownModels[conn.id] ?? []);
    if (settings.defaultModel?.connectionId === conn.id) models.add(settings.defaultModel.model);
    for (const model of models)
      options.push({ connectionId: conn.id, model, label: `${conn.name} · ${model}` });
  }
  return options;
}

/** 加一条站点规则：主机名先归一（normalizeSiteRule），同一主机已有规则就改级别；不合法返回 undefined */
function upsertSiteRule(
  sites: readonly SiteRule[],
  input: string,
  level: SiteRule['level'],
): SiteRule[] | undefined {
  const host = normalizeSiteRule(input);
  if (host === undefined) return undefined;
  const rest = sites.filter((r) => normalizeSiteRule(r.host) !== host);
  return [...rest, { host, level }];
}

const SITE_LEVEL_LABEL: Readonly<Record<SiteRule['level'], string>> = {
  noToolbar: '不弹工具栏',
  noRead: '不读取页面内容',
};

const TIER_LABEL: Readonly<Record<ContextTier, string>> = {
  selection: '只发选中的文字',
  nearby: '选中文字 + 前后几段',
  fullPage: '整页正文（放不下时以选区为中心截取）',
};

type TestView =
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string; suggestedBaseUrl?: string };

const inputStyle = { width: '100%', boxSizing: 'border-box' as const, marginTop: 2 };
const fieldStyle = { display: 'block', marginTop: 10 };

// ───────────── 界面 ─────────────

export function OptionsApp() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [knownModels, setKnownModels] = useState<Record<string, readonly string[]>>({});

  const [editing, setEditing] = useState<Connection | null>(null);
  const [editModel, setEditModel] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsMessage, setModelsMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<TestView | null>(null);
  const [siteInput, setSiteInput] = useState('');
  const [siteLevel, setSiteLevel] = useState<SiteRule['level']>('noRead');
  const [siteError, setSiteError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await loadSettings();
      if (!r.ok) {
        setLoadError('设置已损坏，无法编辑');
        return;
      }
      setSettings(r.settings);
      setKnownModels(seedKnownModels(r.settings));
    })();
  }, []);

  /**
   * 5.11 的写入顺序：先确认 storage 已收紧为仅扩展自身，再用 migrateSettings 读一份最新设置做合并，
   * 整份 Settings 写回。mutate 失败（存储未锁定 / 设置已损坏）时不落盘，返回 null。
   */
  async function persistSettings<T>(
    mutate: (base: Settings) => { settings: Settings; result: T },
  ): Promise<T | null> {
    const lockMsg: OptionsToBackground = { type: 'settings/ensureLocked' };
    const lockRes = await browser.runtime.sendMessage<OptionsToBackground, unknown>(lockMsg);
    if (!isLockedTrue(lockRes)) {
      setSaveError('存储未能锁定，为安全起见未保存 Key');
      return null;
    }
    const loaded = await loadSettings();
    if (!loaded.ok) {
      setSaveError('设置已损坏');
      return null;
    }
    const { settings: next, result } = mutate(loaded.settings);
    await browser.storage.local.set({ [SETTINGS_KEY]: next });
    setSettings(next);
    setSaveError(null);
    return result;
  }

  const saveConnection = (draft: Connection) =>
    persistSettings((base) => {
      const { settings: next, saved } = upsertConnection(base, draft);
      return { settings: next, result: saved };
    });

  const setDefaultModel = (model: ModelRef) =>
    persistSettings((base) => ({ settings: { ...base, defaultModel: model }, result: true as const }));

  async function handleDelete(conn: Connection): Promise<void> {
    const isDefault = settings?.defaultModel?.connectionId === conn.id;
    if (
      isDefault &&
      !window.confirm(`「${conn.name}」是默认连接所在的连接，删除后默认模型会被清空，确定删除吗？`)
    ) {
      return;
    }
    const ok = await persistSettings((base) => {
      const connections = base.connections.filter((c) => c.id !== conn.id);
      if (base.defaultModel?.connectionId !== conn.id) {
        return { settings: { ...base, connections }, result: true as const };
      }
      const { defaultModel: _drop, ...rest } = base;
      return { settings: { ...rest, connections }, result: true as const };
    });
    if (ok && editing?.id === conn.id) setEditing(null);
  }

  function startEdit(conn: Connection): void {
    setEditing(conn);
    setEditModel(
      settings?.defaultModel?.connectionId === conn.id
        ? settings.defaultModel.model
        : (knownModels[conn.id]?.[0] ?? ''),
    );
    setShowKey(false);
    setSaveError(null);
    setModelsMessage(null);
    setTestState(null);
  }

  function handleAddConnection(): void {
    setEditing(blankConnection(crypto.randomUUID()));
    setEditModel('');
    setShowKey(false);
    setSaveError(null);
    setModelsMessage(null);
    setTestState(null);
  }

  async function handleSave(): Promise<void> {
    if (!editing) return;
    setSaving(true);
    try {
      const saved = await saveConnection(editing);
      if (saved) {
        setEditing(saved);
        setKnownModels((m) => addKnownModel(m, saved.id, editModel.trim()));
      }
    } finally {
      setSaving(false);
    }
  }

  async function runTest(conn: Connection, model: string): Promise<void> {
    setTestState(null);
    const msg: OptionsToBackground = { type: 'connection/test', connectionId: conn.id, model };
    const res = await browser.runtime.sendMessage<OptionsToBackground, unknown>(msg);
    const result = asConnectionTestResult(res);
    if (!result) {
      setTestState({ kind: 'error', text: '后台没有正确应答这次测试，可能是扩展版本不一致' });
      return;
    }
    if (result.ok) {
      setKnownModels((m) => addKnownModel(m, conn.id, result.model));
      let text = `连接正常：${result.model} 回复了「${result.reply}」，用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒`;
      if (result.reasoning) text += '（模型开着思考）';
      if (!settings?.defaultModel) {
        const ok = await setDefaultModel({ connectionId: conn.id, model: result.model });
        if (ok) text += '；已设为默认模型';
      }
      setTestState({ kind: 'success', text });
      return;
    }
    const parts = [ERROR_LABEL[result.error.kind]];
    if (result.error.status !== undefined) parts.push(`状态码 ${result.error.status}`);
    if (result.error.serverMessage) parts.push(result.error.serverMessage);
    setTestState(
      result.suggestedBaseUrl !== undefined
        ? { kind: 'error', text: parts.join('；'), suggestedBaseUrl: result.suggestedBaseUrl }
        : { kind: 'error', text: parts.join('；') },
    );
  }

  async function handleTest(): Promise<void> {
    if (!editing) return;
    const model = editModel.trim();
    if (!model) {
      setTestState({ kind: 'error', text: '请先填模型' });
      return;
    }
    setTesting(true);
    try {
      const saved = await saveConnection(editing);
      if (!saved) return;
      setEditing(saved);
      await runTest(saved, model);
    } finally {
      setTesting(false);
    }
  }

  async function handleApplySuggestedAndRetest(url: string): Promise<void> {
    if (!editing) return;
    const model = editModel.trim();
    setTesting(true);
    try {
      const updated: Connection = { ...editing, baseUrl: url };
      setEditing(updated);
      const saved = await saveConnection(updated);
      if (!saved) return;
      setEditing(saved);
      if (model) await runTest(saved, model);
    } finally {
      setTesting(false);
    }
  }

  async function handleAddSite(): Promise<void> {
    if (upsertSiteRule([], siteInput, siteLevel) === undefined) {
      setSiteError('不是有效的站点，例如 example.com 或 https://example.com/page');
      return;
    }
    const ok = await persistSettings((base) => {
      const sites = upsertSiteRule(base.sites, siteInput, siteLevel) ?? base.sites;
      return { settings: { ...base, sites }, result: true as const };
    });
    if (ok) {
      setSiteInput('');
      setSiteError(null);
    }
  }

  const removeSite = (host: string) =>
    persistSettings((base) => ({
      settings: { ...base, sites: base.sites.filter((r) => r.host !== host) },
      result: true as const,
    }));

  const setDefaultTier = (tier: ContextTier) =>
    persistSettings((base) => ({
      settings: { ...base, context: { ...base.context, defaultTier: tier } },
      result: true as const,
    }));

  async function handleListModels(): Promise<void> {
    if (!editing) return;
    setFetchingModels(true);
    setModelsMessage(null);
    try {
      const saved = await saveConnection(editing);
      if (!saved) return;
      setEditing(saved);
      const msg: OptionsToBackground = { type: 'connection/listModels', connectionId: saved.id };
      const res = await browser.runtime.sendMessage<OptionsToBackground, unknown>(msg);
      const models = listModelsOk(res);
      if (models) {
        setKnownModels((m) => ({ ...m, [saved.id]: mergeModels(m[saved.id] ?? [], models) }));
      } else {
        setModelsMessage('拉取失败，可以手填模型名');
      }
    } finally {
      setFetchingModels(false);
    }
  }

  if (loadError) {
    return (
      <main style={{ padding: 16, fontSize: 13 }}>
        <p style={{ color: '#c33' }}>{loadError}</p>
      </main>
    );
  }
  if (!settings) {
    return (
      <main style={{ padding: 16, fontSize: 13 }}>
        <p>加载中…</p>
      </main>
    );
  }

  const options = modelOptions(settings, knownModels);
  const selectedIndex = settings.defaultModel
    ? options.findIndex(
        (o) =>
          o.connectionId === settings.defaultModel?.connectionId && o.model === settings.defaultModel?.model,
      )
    : -1;
  const suggestedBaseUrl = testState?.kind === 'error' ? testState.suggestedBaseUrl : undefined;
  const isNewConnection = editing ? !settings.connections.some((c) => c.id === editing.id) : false;

  return (
    <main style={{ padding: 16, fontSize: 13, maxWidth: 640 }}>
      <h1 style={{ fontSize: 16 }}>设置</h1>

      <section>
        <h2 style={{ fontSize: 14 }}>连接</h2>
        {settings.connections.length === 0 && <p style={{ color: '#999' }}>还没有连接</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {settings.connections.map((conn) => (
            <li key={conn.id} style={{ padding: '6px 0', borderBottom: '1px solid #eee' }}>
              <span>{conn.name}</span>
              <span style={{ color: '#999', marginLeft: 8 }}>{displayBaseUrl(conn.baseUrl)}</span>
              {settings.defaultModel?.connectionId === conn.id && (
                <span style={{ marginLeft: 8, color: '#2a7' }}>默认</span>
              )}
              <button type="button" style={{ marginLeft: 8 }} onClick={() => startEdit(conn)}>
                编辑
              </button>
              <button type="button" style={{ marginLeft: 4 }} onClick={() => void handleDelete(conn)}>
                删除
              </button>
            </li>
          ))}
        </ul>
        <button type="button" style={{ marginTop: 8 }} onClick={handleAddConnection}>
          添加连接
        </button>
      </section>

      {editing && (
        <section style={{ marginTop: 16, padding: 12, border: '1px solid #ddd', borderRadius: 4 }}>
          <h2 style={{ fontSize: 14, margin: 0 }}>{isNewConnection ? '新建连接' : '编辑连接'}</h2>

          <label style={fieldStyle}>
            名称
            <input
              style={inputStyle}
              value={editing.name}
              onInput={(e) => setEditing({ ...editing, name: (e.target as HTMLInputElement).value })}
            />
          </label>

          <label style={fieldStyle}>
            接口地址
            <input
              style={inputStyle}
              value={editing.baseUrl}
              onInput={(e) => setEditing({ ...editing, baseUrl: (e.target as HTMLInputElement).value })}
            />
          </label>
          <span style={{ color: '#999' }}>以 /v1 结尾</span>

          <div style={fieldStyle}>
            <label htmlFor="connection-api-key">
              Key
              {showKey ? (
                <input
                  id="connection-api-key"
                  type="text"
                  style={inputStyle}
                  value={editing.apiKey}
                  onInput={(e) => setEditing({ ...editing, apiKey: (e.target as HTMLInputElement).value })}
                />
              ) : (
                <input
                  id="connection-api-key"
                  type="password"
                  style={inputStyle}
                  value={editing.apiKey}
                  onInput={(e) => setEditing({ ...editing, apiKey: (e.target as HTMLInputElement).value })}
                />
              )}
            </label>
            <button type="button" style={{ marginTop: 4 }} onClick={() => setShowKey((v) => !v)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>

          <label style={fieldStyle}>
            模型
            <input
              style={inputStyle}
              list={`models-${editing.id}`}
              value={editModel}
              onInput={(e) => setEditModel((e.target as HTMLInputElement).value)}
            />
          </label>
          <datalist id={`models-${editing.id}`}>
            {(knownModels[editing.id] ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>

          <div style={{ marginTop: 12 }}>
            <button type="button" disabled={saving} onClick={() => void handleSave()}>
              保存
            </button>
            <button
              type="button"
              style={{ marginLeft: 6 }}
              disabled={fetchingModels}
              onClick={() => void handleListModels()}
            >
              拉取模型列表
            </button>
            <button
              type="button"
              style={{ marginLeft: 6 }}
              disabled={testing}
              onClick={() => void handleTest()}
            >
              测试连接
            </button>
          </div>

          {saveError && <p style={{ color: '#c33' }}>{saveError}</p>}
          {modelsMessage && <p style={{ color: '#c33' }}>{modelsMessage}</p>}
          {testState && (
            <p style={{ color: testState.kind === 'success' ? '#2a7' : '#c33' }}>
              {testState.text}
              {suggestedBaseUrl !== undefined && (
                <>
                  {' '}
                  <button type="button" onClick={() => void handleApplySuggestedAndRetest(suggestedBaseUrl)}>
                    改成 {suggestedBaseUrl} 并重测
                  </button>
                </>
              )}
            </p>
          )}
        </section>
      )}

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 14 }}>默认模型</h2>
        <select
          style={{ width: '100%', maxWidth: 320 }}
          value={selectedIndex}
          onChange={(e) => {
            const idx = Number((e.target as HTMLSelectElement).value);
            const opt = options[idx];
            if (opt) void setDefaultModel({ connectionId: opt.connectionId, model: opt.model });
          }}
        >
          <option value={-1}>未设置</option>
          {options.map((o, i) => (
            <option key={`${o.connectionId}:${o.model}`} value={i}>
              {o.label}
            </option>
          ))}
        </select>
      </section>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 14 }}>提问时附带的页面内容</h2>
        <select
          aria-label="默认档位"
          style={{ width: '100%', maxWidth: 320 }}
          value={settings.context.defaultTier}
          onChange={(e) => void setDefaultTier((e.target as HTMLSelectElement).value as ContextTier)}
        >
          {(Object.keys(TIER_LABEL) as ContextTier[]).map((t) => (
            <option key={t} value={t}>
              {TIER_LABEL[t]}
            </option>
          ))}
        </select>
      </section>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 14 }}>站点</h2>
        <p style={{ color: '#999', margin: '4px 0' }}>
          「不弹工具栏」：选中文字不再自动弹出工具栏，页面内容仍可读取。「不读取页面内容」：不读正文、不缓存，
          提问时只发送你选中的文字。改动立即生效；已打开的网页里的工具栏在刷新后才消失。包含子域名。
        </p>
        {settings.sites.length === 0 && <p style={{ color: '#999' }}>没有站点规则</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {settings.sites.map((r) => (
            <li key={r.host} style={{ padding: '6px 0', borderBottom: '1px solid #eee' }}>
              <span>{r.host}</span>
              <span style={{ color: '#999', marginLeft: 8 }}>{SITE_LEVEL_LABEL[r.level]}</span>
              <button
                type="button"
                style={{ marginLeft: 8 }}
                aria-label={`删除站点 ${r.host}`}
                onClick={() => void removeSite(r.host)}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
        <div style={{ marginTop: 8 }}>
          <input
            aria-label="站点"
            placeholder="example.com"
            style={{ width: 220 }}
            value={siteInput}
            onInput={(e) => setSiteInput((e.target as HTMLInputElement).value)}
          />
          <select
            aria-label="站点级别"
            style={{ marginLeft: 6 }}
            value={siteLevel}
            onChange={(e) => setSiteLevel((e.target as HTMLSelectElement).value as SiteRule['level'])}
          >
            <option value="noRead">{SITE_LEVEL_LABEL.noRead}</option>
            <option value="noToolbar">{SITE_LEVEL_LABEL.noToolbar}</option>
          </select>
          <button type="button" style={{ marginLeft: 6 }} onClick={() => void handleAddSite()}>
            添加站点
          </button>
        </div>
        {siteError && <p style={{ color: '#c33' }}>{siteError}</p>}
      </section>
    </main>
  );
}
