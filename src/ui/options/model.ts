// 设置页 / 配置向导的表单纯逻辑（K、H2、H5、H11、I1、A3、A4）：与界面状态无关，全部是「旧设置 → 新设置」的纯函数，
// 单测在 tests/unit/ui/options-model.test.ts。界面只负责收集输入、调用这里、把结果整份写回（5.11 的写入顺序见 persist.ts）。

import type { ThinkingLevel } from '@/core/context/plan';
import { type ActionDef, type ActionId, BUILTIN_ACTIONS, TOOLBAR_MAX } from '@/core/domain/actions';
import type { Settings } from '@/core/domain/settings';
import { normalizeSiteRule, type SiteRule } from '@/core/domain/site-policy';
import {
  type Connection,
  type ModelCapabilities,
  type ModelError,
  type ModelRef,
  PROTECTED_PARAMS,
} from '@/core/llm/adapter';
import { builtinCapabilities, effectiveCapabilities } from '@/core/llm/capabilities';
import { PROVIDER_PRESETS, type ProviderPreset } from '@/core/llm/presets';
import { PROMPT_REGISTRY, type PromptDef } from '@/core/prompt/ask';

// ───────────── 连接（H2、H7） ─────────────

export const NEW_CONNECTION_NAME = '新连接';
/** 设置结构里 Connection.models 的上限（settings.ts 的校验） */
export const MAX_COMMON_MODELS = 50;

export const presetOf = (id: string): ProviderPreset | undefined => PROVIDER_PRESETS.find((p) => p.id === id);

export function blankConnection(id: string, presetId = 'custom'): Connection {
  const base: Connection = {
    id,
    name: NEW_CONNECTION_NAME,
    preset: 'custom',
    baseUrl: '',
    apiKey: '',
    headers: {},
    interfaceType: 'chatCompletions',
    stream: true,
    extraParams: {},
    configVersion: 0,
  };
  return applyPreset(base, presetId);
}

/**
 * 换预设：地址、接口类型跟着预设走；名字只在还是自动起的名字（「新连接」或别的预设名）时跟着换，
 * 用户自己起的名字不动。选「自定义」不清空已填的地址（多半是想在预设地址上改）
 */
export function applyPreset(conn: Connection, presetId: string): Connection {
  const preset = presetOf(presetId);
  if (!preset) return conn;
  const autoNamed =
    conn.name.trim() === '' ||
    conn.name === NEW_CONNECTION_NAME ||
    PROVIDER_PRESETS.some((p) => p.name === conn.name);
  return {
    ...conn,
    preset: preset.id,
    interfaceType: preset.interfaceType,
    baseUrl: preset.baseUrl !== '' ? preset.baseUrl : conn.baseUrl,
    name: autoNamed ? (preset.id === 'custom' ? NEW_CONNECTION_NAME : preset.name) : conn.name,
  };
}

/** 地址只显示协议 + 主机 + 路径，不含查询串、片段（有的中转站把 Key 放在查询串里） */
export function displayBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return baseUrl.split(/[?#]/)[0] ?? '';
  }
}

/**
 * Key 输入框不回显已存的 Key：留空表示沿用已存的，填了就替换，点「清除」才清空。
 * stored 是存储里的 Key（新连接为空串）
 */
export function resolveApiKey(stored: string, input: string, clear: boolean): string {
  if (clear) return '';
  return input !== '' ? input : stored;
}

/** 这几类字段改了，这条连接学到的能力表才需要失效（5.8 能力学习绑定） */
export function protectedFieldsChanged(before: Connection, after: Connection): boolean {
  return (
    before.baseUrl !== after.baseUrl ||
    before.apiKey !== after.apiKey ||
    before.interfaceType !== after.interfaceType ||
    before.stream !== after.stream ||
    JSON.stringify(before.headers) !== JSON.stringify(after.headers) ||
    JSON.stringify(before.extraParams) !== JSON.stringify(after.extraParams)
  );
}

/** 连接编辑器里能改的字段；常用模型、能力覆盖在编辑器之外即时保存，不归这份草稿管 */
export type ConnectionForm = Pick<
  Connection,
  'name' | 'preset' | 'baseUrl' | 'apiKey' | 'headers' | 'interfaceType' | 'stream' | 'extraParams'
>;

/**
 * 保存编辑器草稿时，以存储里最新的那条连接为底，只盖上编辑器管的字段：
 * 打开编辑器之后勾选的常用模型、改过的能力覆盖不会被旧草稿冲掉。stored 没有（新连接）就以草稿为底
 */
export function mergeConnectionForm(stored: Connection | undefined, draft: Connection): Connection {
  const form: ConnectionForm = {
    name: draft.name,
    preset: draft.preset,
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey,
    headers: draft.headers,
    interfaceType: draft.interfaceType,
    stream: draft.stream,
    extraParams: draft.extraParams,
  };
  return { ...(stored ?? draft), ...form };
}

/** 把一条连接写进（或加进）settings.connections，按改动决定是否让 configVersion 失效 */
export function upsertConnection(
  base: Settings,
  draft: Connection,
): { settings: Settings; saved: Connection } {
  const prev = base.connections.find((c) => c.id === draft.id);
  const bump = prev ? protectedFieldsChanged(prev, draft) : false;
  const saved: Connection = {
    ...draft,
    name: draft.name.trim() === '' ? NEW_CONNECTION_NAME : draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    configVersion: (prev?.configVersion ?? 0) + (bump ? 1 : 0),
  };
  const connections = prev
    ? base.connections.map((c) => (c.id === saved.id ? saved : c))
    : [...base.connections, saved];
  return { settings: { ...base, connections }, saved };
}

/** 删除连接；默认模型、辅助模型指向它的一并清掉（界面随后回到「未设置」，提示重新选择） */
export function removeConnection(base: Settings, connectionId: string): Settings {
  const { defaultModel, auxModel, ...rest } = base;
  return {
    ...rest,
    connections: base.connections.filter((c) => c.id !== connectionId),
    ...(defaultModel && defaultModel.connectionId !== connectionId ? { defaultModel } : {}),
    ...(auxModel && auxModel.connectionId !== connectionId ? { auxModel } : {}),
  };
}

export function setDefaultModel(base: Settings, model: ModelRef): Settings {
  return { ...base, defaultModel: model };
}

// ───────────── 自定义请求头、额外请求参数（H7、5.8） ─────────────

export interface HeaderRow {
  name: string;
  value: string;
}

export const headerRows = (headers: Readonly<Record<string, string>>): HeaderRow[] =>
  Object.entries(headers).map(([name, value]) => ({ name, value }));

/** RFC 9110 的 token：请求头名字只能是这些字符 */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type HeadersResult = { ok: true; headers: Record<string, string> } | { ok: false; error: string };

/** 名字留空的行直接忽略（用户加了一行没填）；名字不合法或重复就报错，不悄悄丢掉 */
export function headersFromRows(rows: readonly HeaderRow[]): HeadersResult {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (name === '') continue;
    if (!HEADER_NAME.test(name)) return { ok: false, error: `请求头名字「${name}」不合法` };
    if (seen.has(name.toLowerCase())) return { ok: false, error: `请求头「${name}」重复了` };
    seen.add(name.toLowerCase());
    headers[name] = row.value;
  }
  return { ok: true, headers };
}

export type ExtraParamsResult =
  | { ok: true; value: Record<string, unknown>; ignored: string[] }
  | { ok: false; error: string };

/**
 * 额外请求参数（JSON 对象）。留空就是没有。受保护字段（model、messages、stream 等，按接口类型）由扩展决定，
 * 填了也会被忽略——这里不删掉它们，只报出来让界面提示（5.8 参数优先级）
 */
export function parseExtraParams(
  text: string,
  interfaceType: Connection['interfaceType'],
): ExtraParamsResult {
  if (text.trim() === '') return { ok: true, value: {}, ignored: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是合法的 JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { ok: false, error: '要写成一个 JSON 对象，例如 {"temperature": 0.3}' };
  const value = parsed as Record<string, unknown>;
  const ignored = PROTECTED_PARAMS[interfaceType].filter((k) => k in value);
  return { ok: true, value, ignored };
}

export const formatExtraParams = (params: Readonly<Record<string, unknown>>): string =>
  Object.keys(params).length === 0 ? '' : JSON.stringify(params, null, 2);

// ───────────── 常用模型与能力覆盖（H5、H11） ─────────────

/** 勾选 / 取消一个常用模型；满 50 个后不再加（返回原连接，界面按数量提示） */
export function toggleCommonModel(conn: Connection, model: string, on: boolean): Connection {
  const name = model.trim();
  const current = conn.models ?? [];
  if (name === '') return conn;
  if (on) {
    if (current.includes(name) || current.length >= MAX_COMMON_MODELS) return conn;
    return { ...conn, models: [...current, name] };
  }
  if (!current.includes(name)) return conn;
  return { ...conn, models: current.filter((m) => m !== name) };
}

/** 模型列表搜索：按空格分词，全部命中才算（不分大小写）；公司中转站有上百个模型 */
export function filterModels(models: readonly string[], query: string): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...models];
  return models.filter((m) => {
    const name = m.toLowerCase();
    return terms.every((t) => name.includes(t));
  });
}

export type CapabilityPatch = Partial<{
  thinking: ModelCapabilities['thinking'] | undefined;
  /** 「可调强度」模型自填的思考档位；undefined 表示按内置判断（决策 100） */
  thinkingLevels: readonly ThinkingLevel[] | undefined;
  vision: ModelCapabilities['vision'] | undefined;
  contextWindow: number | undefined;
}>;

/**
 * 手动覆盖一个模型的能力判断（H11）。patch 里值为 undefined 的字段表示「跟随内置判断」，删掉这一项覆盖；
 * 一个模型的覆盖删空了就整条去掉，全部删空就不留 capabilityOverrides 字段
 */
export function setCapabilityOverride(conn: Connection, model: string, patch: CapabilityPatch): Connection {
  const current = { ...(conn.capabilityOverrides?.[model] ?? {}) };
  for (const key of ['thinking', 'thinkingLevels', 'vision', 'contextWindow'] as const) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === undefined) delete current[key];
    else Object.assign(current, { [key]: v });
  }
  const { capabilityOverrides: _old, ...rest } = conn;
  const others = Object.fromEntries(
    Object.entries(conn.capabilityOverrides ?? {}).filter(([m]) => m !== model),
  );
  const next = Object.keys(current).length > 0 ? { ...others, [model]: current } : others;
  return Object.keys(next).length > 0 ? { ...rest, capabilityOverrides: next } : rest;
}

export interface CapabilityRow {
  model: string;
  builtin: ModelCapabilities;
  effective: ModelCapabilities;
  /** 哪些字段被手动改过 */
  overridden: { thinking: boolean; thinkingLevels: boolean; vision: boolean; contextWindow: boolean };
}

export function capabilityRow(conn: Connection, model: string): CapabilityRow {
  const o = conn.capabilityOverrides?.[model];
  return {
    model,
    builtin: builtinCapabilities(model),
    effective: effectiveCapabilities(conn, model),
    overridden: {
      thinking: o?.thinking !== undefined,
      thinkingLevels: o?.thinkingLevels !== undefined,
      vision: o?.vision !== undefined,
      contextWindow: o?.contextWindow !== undefined,
    },
  };
}

export interface ModelChoice extends ModelRef {
  label: string;
}

/** 默认模型下拉的候选：各连接勾选的常用模型，加上当前的默认模型（即使没勾选，也要能显示出来，J10） */
export function modelChoices(settings: Settings): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const conn of settings.connections) {
    const models = new Set(conn.models ?? []);
    if (settings.defaultModel?.connectionId === conn.id) models.add(settings.defaultModel.model);
    for (const model of models) out.push({ connectionId: conn.id, model, label: `${conn.name} · ${model}` });
  }
  return out;
}

// ───────────── 提示词（I1） ─────────────

export const promptText = (settings: Settings, def: PromptDef): string =>
  settings.promptOverrides[def.id] ?? def.defaultText;

export const isPromptOverridden = (settings: Settings, id: string): boolean => id in settings.promptOverrides;

/** 恢复默认：删掉覆盖（设置里只存改过的部分） */
export function resetPrompt(base: Settings, id: string): Settings {
  if (!(id in base.promptOverrides)) return base;
  const { [id]: _drop, ...rest } = base.promptOverrides;
  return { ...base, promptOverrides: rest };
}

/** 保存提示词：清空或改回和默认一样就等于恢复默认，不留一条和默认相同的覆盖；登记表里没有的编号不收 */
export function setPromptOverride(base: Settings, id: string, text: string): Settings {
  const def = PROMPT_REGISTRY.find((p) => p.id === id);
  if (!def) return base;
  if (text.trim() === '' || text === def.defaultText) return resetPrompt(base, id);
  return { ...base, promptOverrides: { ...base.promptOverrides, [id]: text } };
}

// ───────────── 动作与工具栏（A2、A3） ─────────────

export interface ActionRow {
  def: ActionDef;
  custom: boolean;
  /** 在工具栏按钮列表里（顺序即 toolbarIndex）；不在为 -1 */
  toolbarIndex: number;
  /** 停用：四个入口都不显示 */
  hidden: boolean;
}

/** 「解释代码」不参与排序：选区在代码里时它自动顶替第一个按钮（A6） */
const NOT_SORTABLE: readonly ActionId[] = ['explainCode'];

const allActionDefs = (settings: Settings): ActionDef[] => [
  ...BUILTIN_ACTIONS.filter((a) => !NOT_SORTABLE.includes(a.id)),
  ...settings.customActions,
];

/** 设置里的工具栏顺序，去掉已经不存在的动作（自定义动作删了之后留下的编号）与重复项 */
export function toolbarOrder(settings: Settings): ActionId[] {
  const known = new Set(allActionDefs(settings).map((a) => a.id));
  return [...new Set(settings.toolbarActions)].filter((id) => known.has(id));
}

/** 动作列表：先是工具栏上的（按顺序），再是其余的（内置在前，自定义在后） */
export function actionRows(settings: Settings): ActionRow[] {
  const order = toolbarOrder(settings);
  const hidden = new Set(settings.hiddenActions);
  const rows = allActionDefs(settings).map((def) => ({
    def,
    custom: def.id.startsWith('custom:'),
    toolbarIndex: order.indexOf(def.id),
    hidden: hidden.has(def.id),
  }));
  const on = rows.filter((r) => r.toolbarIndex >= 0).sort((a, b) => a.toolbarIndex - b.toolbarIndex);
  return [...on, ...rows.filter((r) => r.toolbarIndex < 0)];
}

/**
 * 工具栏上实际会怎么摆（A2，与 page/toolbar.ts 的 arrangeToolbar 同口径）：停用的不占位置；
 * 不超过 5 个全部显示，超过 5 个时显示前 4 个，其余进「更多」。position 从 1 开始
 */
export function toolbarPlacement(settings: Settings): Map<ActionId, { position: number; overflow: boolean }> {
  const hidden = new Set(settings.hiddenActions);
  const visible = toolbarOrder(settings).filter((id) => !hidden.has(id));
  const capacity = visible.length > TOOLBAR_MAX ? TOOLBAR_MAX - 1 : TOOLBAR_MAX;
  return new Map(visible.map((id, i) => [id, { position: i + 1, overflow: i >= capacity }]));
}

/** 放上 / 移出工具栏；放上时排在最后 */
export function setOnToolbar(base: Settings, id: ActionId, on: boolean): Settings {
  const order = toolbarOrder(base);
  if (on === order.includes(id)) return { ...base, toolbarActions: order };
  return { ...base, toolbarActions: on ? [...order, id] : order.filter((x) => x !== id) };
}

/** 工具栏按钮前移（-1）或后移（+1）一位；已经在头或尾就不动 */
export function moveToolbarAction(base: Settings, id: ActionId, delta: -1 | 1): Settings {
  const order = toolbarOrder(base);
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return { ...base, toolbarActions: order };
  const next = [...order];
  [next[i], next[j]] = [next[j] as ActionId, next[i] as ActionId];
  return { ...base, toolbarActions: next };
}

export function setActionHidden(base: Settings, id: ActionId, hidden: boolean): Settings {
  const rest = base.hiddenActions.filter((x) => x !== id);
  return { ...base, hiddenActions: hidden ? [...rest, id] : rest };
}

export interface CustomActionDraft {
  /** 编辑已有动作时带上；新建时没有 */
  id?: `custom:${string}`;
  label: string;
  prompt: string;
  scope: ActionDef['scope'];
  needsInput: boolean;
}

export const blankCustomAction = (): CustomActionDraft => ({
  label: '',
  prompt: '',
  scope: 'selection',
  needsInput: false,
});

export const customActionDraft = (def: ActionDef): CustomActionDraft => ({
  id: def.id as `custom:${string}`,
  label: def.label,
  prompt: def.promptOverride ?? '',
  scope: def.scope,
  needsInput: def.needsInput,
});

export const CUSTOM_ACTION_LIMITS = { label: 40, prompt: 20_000, count: 100 } as const;

export interface CustomActionErrors {
  label?: string;
  prompt?: string;
  count?: string;
}

/** 校验自定义动作（A3：名字、提示词、作用范围）。没有错误返回空对象 */
export function validateCustomAction(draft: CustomActionDraft, settings: Settings): CustomActionErrors {
  const errors: CustomActionErrors = {};
  const label = draft.label.trim();
  if (label === '') errors.label = '请给动作起个名字';
  else if ([...label].length > CUSTOM_ACTION_LIMITS.label)
    errors.label = `名字最多 ${CUSTOM_ACTION_LIMITS.label} 个字`;
  else if (
    BUILTIN_ACTIONS.some((a) => a.label === label) ||
    settings.customActions.some((a) => a.label === label && a.id !== draft.id)
  )
    errors.label = '已经有同名的动作了';
  if (draft.prompt.trim() === '') errors.prompt = '请写上提示词：点这个动作时要让模型做什么';
  else if (draft.prompt.length > CUSTOM_ACTION_LIMITS.prompt)
    errors.prompt = `提示词最多 ${CUSTOM_ACTION_LIMITS.prompt} 个字符`;
  if (draft.id === undefined && settings.customActions.length >= CUSTOM_ACTION_LIMITS.count)
    errors.count = `自定义动作最多 ${CUSTOM_ACTION_LIMITS.count} 个`;
  return errors;
}

/**
 * 新建或修改自定义动作；调用前先过 validateCustomAction。新建的排到工具栏最后（超过 5 个的自动进「更多」），
 * newId 由调用方给（crypto.randomUUID()），方便单测
 */
export function upsertCustomAction(base: Settings, draft: CustomActionDraft, newId: string): Settings {
  const id = draft.id ?? (`custom:${newId}` as const);
  const def: ActionDef = {
    id,
    label: draft.label.trim(),
    kind: 'model',
    needsInput: draft.needsInput,
    scope: draft.scope,
    promptOverride: draft.prompt.trim(),
  };
  const exists = base.customActions.some((a) => a.id === id);
  const customActions = exists
    ? base.customActions.map((a) => (a.id === id ? def : a))
    : [...base.customActions, def];
  const next = { ...base, customActions };
  return exists ? next : { ...next, toolbarActions: [...toolbarOrder(next), id] };
}

/** 删除自定义动作，连同它在工具栏顺序与停用表里的编号 */
export function removeCustomAction(base: Settings, id: ActionId): Settings {
  return {
    ...base,
    customActions: base.customActions.filter((a) => a.id !== id),
    toolbarActions: base.toolbarActions.filter((x) => x !== id),
    hiddenActions: base.hiddenActions.filter((x) => x !== id),
  };
}

// ───────────── 网站黑名单（A4） ─────────────

/** 加一条站点规则：主机名先归一（normalizeSiteRule），同一主机已有规则就改级别；不合法返回 undefined */
export function upsertSiteRule(
  sites: readonly SiteRule[],
  input: string,
  level: SiteRule['level'],
): SiteRule[] | undefined {
  const host = normalizeSiteRule(input);
  if (host === undefined) return undefined;
  const rest = sites.filter((r) => normalizeSiteRule(r.host) !== host);
  return [...rest, { host, level }];
}

export const removeSiteRule = (sites: readonly SiteRule[], host: string): SiteRule[] =>
  sites.filter((r) => r.host !== host);

/** IPv6 字面量写不进哨兵的排除名单（site-policy.ts）：「不弹工具栏」对它不生效，界面要提示 */
export const isIpv6Rule = (host: string): boolean => host.startsWith('[');

// ───────────── 后台应答的宽松解析（应答形状不对时返回 null，界面显示兜底文案） ─────────────

export function isLockedTrue(r: unknown): boolean {
  return typeof r === 'object' && r !== null && (r as { locked?: unknown }).locked === true;
}

function isModelError(v: unknown): v is ModelError {
  return typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string';
}

export type TestResult =
  | { ok: true; model: string; reply: string; elapsedMs: number; reasoning: boolean }
  | { ok: false; error: ModelError; elapsedMs: number; suggestedBaseUrl?: string };

export function asConnectionTestResult(r: unknown): TestResult | null {
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

export type ModelListResult =
  | { ok: true; models: string[] }
  | { ok: false; error?: ModelError; suggestedBaseUrl?: string };

export function asListModelsResult(r: unknown): ModelListResult {
  if (typeof r !== 'object' || r === null) return { ok: false };
  const o = r as Record<string, unknown>;
  if (o.ok === true && Array.isArray(o.models) && o.models.every((m) => typeof m === 'string'))
    return { ok: true, models: o.models as string[] };
  return {
    ok: false,
    ...(isModelError(o.error) ? { error: o.error } : {}),
    ...(typeof o.suggestedBaseUrl === 'string' ? { suggestedBaseUrl: o.suggestedBaseUrl } : {}),
  };
}

// ───────────── 快捷键（L4、J4） ─────────────

/** commands.getAll() 给的条目里用到的部分 */
export interface CommandLike {
  name?: string | undefined;
  shortcut?: string | undefined;
  description?: string | undefined;
}

export interface ShortcutRow {
  name: string;
  label: string;
  /** 当前实际生效的按键；没绑上为空串 */
  shortcut: string;
  /** 清单里的建议键位；第 4 个命令没有预设（J4） */
  suggested: string | undefined;
  /** 有建议键位却没绑上：多半与别的扩展或浏览器快捷键冲突（浏览器只在首次安装时分配） */
  unbound: boolean;
}

/** 清单 commands 里的四个命令（wxt.config.ts）。顺序即显示顺序 */
export const SHORTCUT_DEFS: readonly { name: string; label: string; suggested?: string }[] = [
  { name: 'open-float', label: '打开或关闭小窗（选中了文字会带上引用）', suggested: 'Alt+Shift+S' },
  { name: 'toggle-sidepanel', label: '打开或关闭侧边栏', suggested: 'Alt+Shift+D' },
  { name: 'capture-region', label: '框选截图', suggested: 'Alt+Shift+X' },
  { name: 'summarize-page', label: '总结当前页面（没有预设按键，可以自己绑一个）' },
];

export function shortcutRows(commands: readonly CommandLike[]): ShortcutRow[] {
  return SHORTCUT_DEFS.map((d) => {
    const shortcut = commands.find((c) => c.name === d.name)?.shortcut ?? '';
    return {
      name: d.name,
      label: d.label,
      shortcut,
      suggested: d.suggested,
      unbound: d.suggested !== undefined && shortcut === '',
    };
  });
}

/** 浏览器自带的快捷键设置页：Edge 用 edge://，其余 Chromium 用 chrome:// */
export function shortcutsPageUrl(userAgent: string): string {
  return /\bEdg\//.test(userAgent) ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
}
