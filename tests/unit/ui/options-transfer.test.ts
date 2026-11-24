// 设置导出导入的纯逻辑（src/ui/options/transfer.ts）：导出脱敏与包含 Key、导入的各类失败原因、
// Key 与本机凭据的保留合并、导入摘要。导入后的设置必须能通过设置结构的整体校验。
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migrateSettings, SETTINGS_VERSION, type Settings } from '@/core/domain/settings';
import type { Connection } from '@/core/llm/adapter';
import { blankConnection } from '@/ui/options/model';
import {
  buildSettingsExport,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  mergeImportedSettings,
  parseSettingsFile,
  settingsFileName,
  summarizeSettings,
} from '@/ui/options/transfer';

const conn = (id: string, over: Partial<Connection> = {}): Connection => ({
  ...blankConnection(id),
  name: `连接 ${id}`,
  baseUrl: 'https://relay.test/v1',
  apiKey: 'sk-test',
  ...over,
});

const settingsWith = (connections: Connection[], over: Partial<Settings> = {}): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  connections,
  ...over,
});

describe('导出（K6）', () => {
  it('带格式标记与设置版本；默认清空 Key 与像凭据的请求头 / 额外参数，去掉地址查询串', () => {
    const s = settingsWith([
      conn('conn-aaaa-0001', {
        apiKey: 'sk-secret',
        baseUrl: 'https://relay.test/v1?key=sk-in-url#frag',
        headers: { 'X-Api-Key': 'header-secret', 'X-Team': 'reading' },
        extraParams: { token: 'token-secret', temperature: 0.3 },
      }),
    ]);
    const text = buildSettingsExport(s, false);
    const file = JSON.parse(text) as { format: string; formatVersion: number; settings: Settings };
    expect(file.format).toBe(EXPORT_FORMAT);
    expect(file.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(file.settings.version).toBe(SETTINGS_VERSION);
    const c = file.settings.connections[0];
    expect(c?.apiKey).toBe('');
    expect(c?.baseUrl).toBe('https://relay.test/v1');
    expect(c?.headers).toEqual({ 'X-Api-Key': '', 'X-Team': 'reading' });
    expect(c?.extraParams).toEqual({ token: '', temperature: 0.3 });
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('header-secret');
    expect(text).not.toContain('token-secret');
  });

  it('勾选包含 Key 时原样导出', () => {
    const s = settingsWith([
      conn('conn-aaaa-0001', {
        apiKey: 'sk-secret',
        headers: { 'X-Api-Key': 'header-secret' },
        extraParams: { token: 'token-secret' },
      }),
    ]);
    const c = (JSON.parse(buildSettingsExport(s, true)) as { settings: Settings }).settings.connections[0];
    expect(c?.apiKey).toBe('sk-secret');
    expect(c?.headers).toEqual({ 'X-Api-Key': 'header-secret' });
    expect(c?.extraParams).toEqual({ token: 'token-secret' });
  });

  it('文件名按本地日期', () => {
    expect(settingsFileName(new Date(2026, 10, 24))).toBe('reading-assistant-settings-20261124.json');
    expect(settingsFileName(new Date(2026, 0, 5))).toBe('reading-assistant-settings-20260105.json');
  });
});

describe('导入文件的解析与各种失败原因', () => {
  const valid = settingsWith([conn('conn-aaaa-0001')]);

  it('正常文件解析回同一份设置，走迁移与校验', () => {
    const r = parseSettingsFile(buildSettingsExport(valid, true));
    expect(r).toMatchObject({ ok: true, migratedFrom: SETTINGS_VERSION });
    if (r.ok) {
      expect(r.settings).toEqual(valid);
      expect(migrateSettings(structuredClone(r.settings)).ok).toBe(true);
    }
  });

  it('不是 JSON、不是本扩展的设置文件、格式版本或设置版本更新、缺设置内容、设置校验失败', () => {
    expect(parseSettingsFile('{不是 json')).toEqual({ ok: false, error: 'notJson' });
    expect(parseSettingsFile('[]')).toEqual({ ok: false, error: 'notSettingsFile' });
    expect(parseSettingsFile(JSON.stringify({ format: 'other', formatVersion: 1, settings: valid }))).toEqual(
      {
        ok: false,
        error: 'notSettingsFile',
      },
    );
    expect(
      parseSettingsFile(JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 2, settings: valid })),
    ).toEqual({ ok: false, error: 'newerFormat', version: 2 });
    expect(parseSettingsFile(JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 1 }))).toEqual({
      ok: false,
      error: 'missingSettings',
    });
    expect(
      parseSettingsFile(
        JSON.stringify({
          format: EXPORT_FORMAT,
          formatVersion: 1,
          settings: { version: SETTINGS_VERSION + 1 },
        }),
      ),
    ).toEqual({ ok: false, error: 'newerVersion', version: SETTINGS_VERSION + 1 });
    expect(
      parseSettingsFile(
        JSON.stringify({
          format: EXPORT_FORMAT,
          formatVersion: 1,
          settings: { version: SETTINGS_VERSION, connections: '不是数组' },
        }),
      ),
    ).toEqual({ ok: false, error: 'corrupt' });
  });
});

describe('导入时的 Key 与凭据保留', () => {
  const local = settingsWith([
    conn('conn-aaaa-0001', {
      name: '连接 A',
      apiKey: 'sk-mine',
      headers: { 'X-Api-Key': 'mine', 'X-Team': 'old' },
      extraParams: { token: 'mine', temperature: 0.1 },
    }),
    conn('conn-bbbb-0002', { name: '连接 B' }),
  ]);

  it('本机有同一 id 的连接：Key 与被脱敏的请求头 / 额外参数沿用本机的；其余以文件为准', () => {
    const imported = settingsWith([
      conn('conn-aaaa-0001', {
        name: '连接 A',
        apiKey: '',
        headers: { 'X-Api-Key': '', 'X-Team': 'reading' },
        extraParams: { token: '', temperature: 0.3 },
      }),
      conn('conn-cccc-0003', { name: '连接 C', apiKey: '' }),
    ]);
    const r = mergeImportedSettings(local, imported);
    const a = r.settings.connections[0];
    expect(a?.apiKey).toBe('sk-mine');
    expect(a?.headers).toEqual({ 'X-Api-Key': 'mine', 'X-Team': 'reading' });
    expect(a?.extraParams).toEqual({ token: 'mine', temperature: 0.3 });
    expect(r.keptKeys).toEqual(['连接 A']);
    // 本机没有的连接留空，并在提示里点名
    expect(r.settings.connections[1]?.apiKey).toBe('');
    expect(r.missingKeys).toEqual(['连接 C']);
    expect(migrateSettings(structuredClone(r.settings)).ok).toBe(true);
  });

  it('文件里带了 Key 就以文件为准', () => {
    const r = mergeImportedSettings(
      local,
      settingsWith([conn('conn-aaaa-0001', { name: '连接 A', apiKey: 'sk-file' })]),
    );
    expect(r.settings.connections[0]?.apiKey).toBe('sk-file');
    expect(r.keptKeys).toEqual([]);
    expect(r.missingKeys).toEqual([]);
  });

  it('本机同一 id 的连接 Key 也是空的：仍然留空并提示', () => {
    const bare = settingsWith([conn('conn-aaaa-0001', { name: '连接 A', apiKey: '' })]);
    const r = mergeImportedSettings(
      bare,
      settingsWith([conn('conn-aaaa-0001', { name: '连接 A', apiKey: '' })]),
    );
    expect(r.settings.connections[0]?.apiKey).toBe('');
    expect(r.keptKeys).toEqual([]);
    expect(r.missingKeys).toEqual(['连接 A']);
  });
});

describe('导入摘要', () => {
  it('列出连接、自定义动作、网站规则的数量与默认模型', () => {
    const s = settingsWith([conn('conn-aaaa-0001', { name: '主连接' }), conn('conn-bbbb-0002')], {
      defaultModel: { connectionId: 'conn-aaaa-0001', model: 'mock-flash' },
      customActions: [
        {
          id: 'custom:abcdef12-3456-7890-abcd-ef1234567890',
          label: '大白话',
          kind: 'model',
          needsInput: false,
          scope: 'selection',
          promptOverride: '改写',
        },
      ],
      sites: [{ host: 'example.com', level: 'noRead' }],
    });
    expect(summarizeSettings(s)).toEqual({
      connections: 2,
      customActions: 1,
      sites: 1,
      defaultModel: '主连接 · mock-flash',
    });
    expect(summarizeSettings(settingsWith([]))).toEqual({
      connections: 0,
      customActions: 0,
      sites: 0,
    });
  });
});
