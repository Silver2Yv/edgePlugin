// 设置导出与导入（K6）的纯逻辑：生成导出文件、解析导入文件、校验 / 迁移、把本机保留的 Key 与
// 像凭据的请求头合进导入的设置。界面只负责选文件、显示摘要、确认后整份写回（api.ts 的 persistSettings）。
// 解析与校验复用 core/domain/settings.ts 的 migrateSettings，和 settings-store.ts 的 loadSettings 同一套。
import { exportSettings, migrateSettings, SENSITIVE_NAME, type Settings } from '@/core/domain/settings';

export const EXPORT_FORMAT = 'reading-assistant-settings';
export const EXPORT_FORMAT_VERSION = 1;

/** 导出文件名：reading-assistant-settings-20261124.json（本地日期） */
export function settingsFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `reading-assistant-settings-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.json`;
}

/** 导出文件内容：格式标记 + 格式版本 + 设置（默认脱敏，includeKeys 时原样） */
export function buildSettingsExport(settings: Settings, includeKeys: boolean): string {
  return `${JSON.stringify(
    {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      settings: exportSettings(settings, includeKeys),
    },
    null,
    2,
  )}\n`;
}

export type ImportError =
  | 'notJson'
  | 'notSettingsFile'
  | 'newerFormat'
  | 'missingSettings'
  | 'newerVersion'
  | 'corrupt';

export type ImportParseResult =
  | { ok: true; settings: Settings; migratedFrom: number }
  | { ok: false; error: ImportError; version?: number };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 解析设置文件：格式标记对不对、格式版本与设置版本是不是比当前新、设置能不能通过迁移与校验 */
export function parseSettingsFile(text: string): ImportParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'notJson' };
  }
  if (!isPlainObject(raw)) return { ok: false, error: 'notSettingsFile' };
  if (raw.format !== EXPORT_FORMAT) return { ok: false, error: 'notSettingsFile' };
  const fv = raw.formatVersion;
  if (typeof fv !== 'number' || !Number.isInteger(fv) || fv < 1)
    return { ok: false, error: 'notSettingsFile' };
  if (fv > EXPORT_FORMAT_VERSION) return { ok: false, error: 'newerFormat', version: fv };
  if (!('settings' in raw)) return { ok: false, error: 'missingSettings' };
  const r = migrateSettings(raw.settings);
  if (!r.ok) {
    if (r.error === 'newerVersion')
      return { ok: false, error: 'newerVersion', ...(r.version !== undefined ? { version: r.version } : {}) };
    return { ok: false, error: 'corrupt' };
  }
  return { ok: true, settings: r.settings, migratedFrom: r.migratedFrom };
}

const isBlank = (v: unknown): boolean => v === '';

/**
 * 脱敏时被清空的值：只补名字像凭据的项（Key、认证头、额外参数里的 token 等）。
 * 本机同一 id 的连接里有同名且非空的值就沿用，否则留空
 */
function mergeSensitive<T>(
  file: Readonly<Record<string, T>>,
  local: Readonly<Record<string, T>>,
): Record<string, T> {
  const out: Record<string, T> = { ...file };
  for (const [name, value] of Object.entries(file)) {
    if (!isBlank(value) || !SENSITIVE_NAME.test(name)) continue;
    const mine = local[name];
    if (mine !== undefined && !isBlank(mine)) out[name] = mine;
  }
  return out;
}

export interface ImportMerge {
  settings: Settings;
  /** 本机有同一 id 的连接，Key 被保留的（连接名字） */
  keptKeys: string[];
  /** 导入后仍然没有 Key 的（连接名字），提示去填 */
  missingKeys: string[];
}

/**
 * 把导入的设置与本机当前设置合并：导入文件里的连接 Key 为空、本机有同一 id 的连接时保留本机的 Key；
 * 被脱敏掉的请求头与额外参数同理。其余一律以文件为准
 */
export function mergeImportedSettings(current: Settings, imported: Settings): ImportMerge {
  const keptKeys: string[] = [];
  const missingKeys: string[] = [];
  const connections = imported.connections.map((c) => {
    const local = current.connections.find((x) => x.id === c.id);
    let apiKey = c.apiKey;
    if (apiKey === '' && local !== undefined && local.apiKey !== '') {
      apiKey = local.apiKey;
      keptKeys.push(c.name);
    } else if (apiKey === '') {
      missingKeys.push(c.name);
    }
    return {
      ...c,
      apiKey,
      headers: mergeSensitive(c.headers, local?.headers ?? {}),
      extraParams: mergeSensitive(c.extraParams, local?.extraParams ?? {}),
    };
  });
  return { settings: { ...imported, connections }, keptKeys, missingKeys };
}

export interface ImportSummary {
  connections: number;
  customActions: number;
  sites: number;
  /** 默认模型的显示名；没设置时没有 */
  defaultModel?: string;
}

export function summarizeSettings(s: Settings): ImportSummary {
  const conn =
    s.defaultModel !== undefined
      ? s.connections.find((c) => c.id === s.defaultModel?.connectionId)
      : undefined;
  return {
    connections: s.connections.length,
    customActions: s.customActions.length,
    sites: s.sites.length,
    ...(s.defaultModel !== undefined
      ? { defaultModel: conn !== undefined ? `${conn.name} · ${s.defaultModel.model}` : s.defaultModel.model }
      : {}),
  };
}
