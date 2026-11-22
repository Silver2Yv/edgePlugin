// 设置结构与迁移（5.11）。存 storage.local，带版本号；提示词只存改过的部分（I1）。
// storage.local 在写入 Key 前收紧为仅扩展自身可访问（5.11、AR-18），内容脚本读不到设置，
// 它需要的由后台按需下发（PageConfig）。
import type { ContextTier, LengthTier, ThinkingLevel } from '../context/plan';
import type { Connection, ModelRef } from '../llm/adapter';
import { type ActionDef, type ActionId, BUILTIN_ACTION_IDS, DEFAULT_TOOLBAR } from './actions';
import { FLOAT_LIMITS } from './float';
import { ID_PATTERN } from './ids';
import { arr, bool, int, jsonValue, lit, num, obj, oneOf, opt, rec, type Schema, str } from './schema';
import type { SiteRule } from './site-policy';

export const SETTINGS_VERSION = 2;

export interface Settings {
  version: typeof SETTINGS_VERSION;
  connections: readonly Connection[];
  defaultModel?: ModelRef;
  /** 辅助任务（问题建议、标题）用的模型；不填用默认模型 */
  auxModel?: ModelRef;
  sites: readonly SiteRule[];
  /** 自定义动作；内置动作不存 */
  customActions: readonly ActionDef[];
  /** 工具栏按钮顺序（A2、A3）；超过 TOOLBAR_MAX 的进「更多」 */
  toolbarActions: readonly ActionId[];
  /** 隐藏的动作，四个入口都不显示 */
  hiddenActions: readonly ActionId[];
  /** 提示词覆盖：键为提示词编号，删除即恢复默认 */
  promptOverrides: Readonly<Record<string, string>>;
  reply: {
    lengthTier: LengthTier;
    /** 回答语言（I5）：'zh' 默认中文；'auto' 跟随网页语言（没有页面语言信息退回中文）；否则是 BCP 47 语言标签 */
    language: string;
    /** 思考强度默认值（H6） */
    thinking: ThinkingLevel;
  };
  context: {
    /** 速度软预算占硬上限的比例 */
    speedSoftBudgetRatio: number;
    /** 总结读取占软预算的比例，对应需求 20%–40% */
    summaryReadRatio: number;
    /**
     * 提问时默认的页面上下文档位（contract-v1.3 增量）。小窗还没有档位切换界面，发问时按它填 contextTier；
     * 出厂 nearby：选区所在块前后若干段，比只发选区多了上下文，又比全文快、省
     */
    defaultTier: ContextTier;
  };
  float: {
    placement: 'nearSelection' | 'remembered';
    rect?: { x: number; y: number; w: number; h: number };
  };
  suggestions: { model: boolean; rules: boolean };
  updates: { autoCheck: boolean };
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  connections: [],
  sites: [],
  customActions: [],
  toolbarActions: DEFAULT_TOOLBAR,
  hiddenActions: [],
  promptOverrides: {},
  // 默认长度「简短」（决策 040）；默认语言「中文」（I5），'auto' 改义为「跟随网页语言」
  reply: { lengthTier: 'brief', language: 'zh', thinking: 'off' },
  context: { speedSoftBudgetRatio: 0.5, summaryReadRatio: 0.3, defaultTier: 'nearby' },
  float: { placement: 'nearSelection' },
  suggestions: { model: true, rules: true },
  updates: { autoCheck: false },
};

// ───────────── 校验 ─────────────

const id = str({ pattern: ID_PATTERN });
const customActionId = str({ pattern: /^custom:[a-z0-9-]{8,64}$/ }) as Schema<`custom:${string}`>;
const actionId = str({
  max: 80,
  pattern: new RegExp(`^(${BUILTIN_ACTION_IDS.join('|')}|custom:[a-z0-9-]{8,64})$`),
}) as Schema<ActionId>;
const modelRef = obj({ connectionId: id, model: str({ min: 1, max: 200 }) });

const connectionSchema = obj({
  id,
  name: str({ max: 200 }),
  preset: str({ max: 64 }),
  baseUrl: str({ max: 2_000 }),
  apiKey: str({ max: 4_000 }),
  headers: rec(str({ max: 4_000 })),
  interfaceType: oneOf(['chatCompletions', 'responses', 'anthropic', 'gemini']),
  stream: bool,
  extraParams: rec(jsonValue),
  configVersion: int({ min: 0 }),
});

const settingsSchema = obj({
  version: lit(SETTINGS_VERSION),
  connections: arr(connectionSchema, { max: 50 }),
  defaultModel: opt(modelRef),
  auxModel: opt(modelRef),
  sites: arr(obj({ host: str({ min: 1, max: 253 }), level: oneOf(['noToolbar', 'noRead']) }), { max: 2_000 }),
  customActions: arr(
    obj({
      id: customActionId,
      label: str({ min: 1, max: 40 }),
      kind: oneOf(['model', 'save']),
      needsInput: bool,
      scope: oneOf(['selection', 'page']),
      promptOverride: opt(str({ max: 20_000 })),
    }),
    { max: 100 },
  ),
  toolbarActions: arr(actionId, { max: 120 }),
  hiddenActions: arr(actionId, { max: 120 }),
  promptOverrides: rec(str({ max: 20_000 })),
  reply: obj({
    lengthTier: oneOf(['brief', 'normal', 'detailed']),
    language: str({ min: 1, max: 35 }),
    thinking: oneOf(['off', 'low', 'medium', 'high']),
  }),
  context: obj({
    speedSoftBudgetRatio: num({ min: 0.1, max: 1 }),
    summaryReadRatio: num({ min: 0.2, max: 0.4 }),
    defaultTier: oneOf(['selection', 'nearby', 'fullPage']),
  }),
  float: obj({
    placement: oneOf(['nearSelection', 'remembered']),
    rect: opt(
      obj({
        x: num(),
        y: num(),
        w: num({ min: FLOAT_LIMITS.minWidth }),
        h: num({ min: FLOAT_LIMITS.minHeight }),
      }),
    ),
  }),
  suggestions: obj({ model: bool, rules: bool }),
  updates: obj({ autoCheck: bool }),
});

// ───────────── 迁移 ─────────────

/** 第 n 项把版本 n 的数据升到 n + 1；版本 0 表示首次安装前无数据。缺的字段由迁移后的默认值合并补齐 */
type Migration = (old: Record<string, unknown>) => Record<string, unknown>;
const MIGRATIONS: readonly Migration[] = [
  // 0 → 1：首个版本
  (old) => ({ ...old, version: 1 }),
  // 1 → 2：回答默认值改为「简短」「中文」（I2、I5）。版本 1 的设置页不能改这两项，存下的 normal / auto
  // 只可能是旧出厂值，跟着新出厂值走；'auto' 从此表示「跟随网页语言」
  (old) => {
    const reply = isPlainObject(old.reply) ? { ...old.reply } : undefined;
    if (reply?.lengthTier === 'normal') reply.lengthTier = 'brief';
    if (reply?.language === 'auto') reply.language = 'zh';
    return { ...old, ...(reply ? { reply } : {}), version: 2 };
  },
];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 对象逐层合并，数组与标量以存储值为准；存储里多出的键保留（随后被校验拒绝） */
function withDefaults(
  defaults: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const [k, d] of Object.entries(defaults)) {
    const v = data[k];
    if (v === undefined) out[k] = structuredClone(d);
    else if (isPlainObject(d) && isPlainObject(v)) out[k] = withDefaults(d, v);
  }
  return out;
}

export type MigrateResult =
  | { ok: true; settings: Settings; migratedFrom: number }
  | { ok: false; error: 'newerVersion' | 'corrupt'; version?: number };

/**
 * 把存储里读到的原始值升到当前版本，补齐默认值，再整体校验。
 * 失败时调用方保留原值不覆盖（不静默损坏），界面提示设置损坏。
 */
export function migrateSettings(raw: unknown): MigrateResult {
  if (raw === undefined || raw === null)
    return { ok: true, settings: structuredClone(DEFAULT_SETTINGS), migratedFrom: 0 };
  if (!isPlainObject(raw)) return { ok: false, error: 'corrupt' };
  let data = raw;
  const from = typeof data.version === 'number' && Number.isInteger(data.version) ? data.version : 0;
  if (from > SETTINGS_VERSION) return { ok: false, error: 'newerVersion', version: from };
  for (let v = from; v < SETTINGS_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) return { ok: false, error: 'corrupt', version: v };
    data = step(data);
  }
  const r = settingsSchema.parse(withDefaults(DEFAULT_SETTINGS as unknown as Record<string, unknown>, data));
  if (!r.ok) return { ok: false, error: 'corrupt', version: SETTINGS_VERSION };
  // 这一行同时是编译期检查：校验结果的类型必须能赋给 Settings
  const settings: Settings = r.value;
  return { ok: true, settings, migratedFrom: from };
}

// ───────────── 导出 ─────────────

/** 名字像凭据的请求头与额外参数，导出时清空值 */
const SENSITIVE_NAME = /auth|key|token|secret|cookie/i;

/**
 * 导出设置（K6）。默认脱敏：清空 Key、名字像凭据的请求头与额外参数，去掉地址里的查询串与片段
 * （有的中转站把 Key 放在查询串里）。includeKeys 为真时原样导出。
 */
export function exportSettings(s: Settings, includeKeys = false): Settings {
  const copy = structuredClone(s);
  if (includeKeys) return copy;
  const blank = <T>(r: Readonly<Record<string, T>>, empty: T) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, SENSITIVE_NAME.test(k) ? empty : v]));
  return {
    ...copy,
    connections: copy.connections.map((c) => ({
      ...c,
      apiKey: '',
      baseUrl: c.baseUrl.split(/[?#]/)[0] ?? '',
      headers: blank(c.headers, ''),
      extraParams: blank<unknown>(c.extraParams, ''),
    })),
  };
}
