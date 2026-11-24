// 导出与导入（K6）：导出成 JSON 文件（默认脱敏，可勾选包含 Key）；导入前解析、校验、迁移，
// 先显示摘要再确认替换。写入走设置页统一的 useSettings / persistSettings。
import { useState } from 'preact/hooks';
import type { Settings } from '@/core/domain/settings';
import { Row } from './parts';
import { S } from './strings';
import {
  buildSettingsExport,
  type ImportParseResult,
  type ImportSummary,
  mergeImportedSettings,
  parseSettingsFile,
  settingsFileName,
  summarizeSettings,
} from './transfer';
import type { SettingsHandle } from './useSettings';

const errorText = (r: Extract<ImportParseResult, { ok: false }>): string => {
  switch (r.error) {
    case 'notJson':
      return S.transfer.notJson;
    case 'notSettingsFile':
      return S.transfer.notSettingsFile;
    case 'newerFormat':
      return S.transfer.newerFormat(r.version ?? 0);
    case 'missingSettings':
      return S.transfer.missingSettings;
    case 'newerVersion':
      return S.transfer.newerVersion(r.version ?? 0);
    case 'corrupt':
      return S.transfer.corrupt;
  }
};

interface Pending {
  imported: Settings;
  summary: ImportSummary;
  keptKeys: string[];
  missingKeys: string[];
}

export function TransferSection({ handle }: { handle: SettingsHandle }) {
  const [includeKeys, setIncludeKeys] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [imported, setImported] = useState(false);
  const [busy, setBusy] = useState(false);

  function download(): void {
    const name = settingsFileName(new Date());
    const blob = new Blob([buildSettingsExport(handle.settings, includeKeys)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setExported(name);
  }

  async function pick(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setError(null);
    setExported(null);
    setImported(false);
    setPending(null);
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError(S.transfer.notJson);
      return;
    }
    const parsed = parseSettingsFile(text);
    if (!parsed.ok) {
      setError(errorText(parsed));
      return;
    }
    const merged = mergeImportedSettings(handle.settings, parsed.settings);
    setPending({
      imported: parsed.settings,
      summary: summarizeSettings(parsed.settings),
      keptKeys: merged.keptKeys,
      missingKeys: merged.missingKeys,
    });
  }

  async function apply(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    try {
      const ok = await handle.set((base) => mergeImportedSettings(base, pending.imported).settings);
      if (ok) {
        setPending(null);
        setImported(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="opt-transfer">
      <Row
        label={S.transfer.export}
        help={
          <>
            {S.transfer.help}
            <label class="opt-check">
              <input
                type="checkbox"
                aria-label={S.transfer.includeKeys}
                checked={includeKeys}
                onChange={(e) => setIncludeKeys((e.target as HTMLInputElement).checked)}
              />
              {S.transfer.includeKeys}
            </label>
            {includeKeys ? (
              <div class="opt-warn">{S.transfer.includeKeysWarn}</div>
            ) : (
              <div class="opt-help">{S.transfer.includeKeysHelp}</div>
            )}
          </>
        }
      >
        <button type="button" class="ra-btn" onClick={download}>
          {S.transfer.export}
        </button>
      </Row>
      {exported !== null && (
        <div class="opt-saved" role="status">
          {S.transfer.exported(exported)}
        </div>
      )}

      <Row label={S.transfer.import} help={S.transfer.importHelp}>
        <input
          type="file"
          accept=".json,application/json"
          aria-label={S.transfer.selectFile}
          onChange={(e) => void pick(e)}
        />
      </Row>
      {error !== null && (
        <div class="opt-error" role="alert">
          {error}
        </div>
      )}
      {imported && (
        <div class="opt-saved" role="status">
          {S.transfer.imported}
        </div>
      )}

      {pending !== null && (
        <div class="opt-editor" data-testid="import-preview">
          <div class="opt-editor__title">{S.transfer.preview}</div>
          <ul class="opt-list">
            <li class="opt-list__item">
              <div class="opt-list__main">
                <div>{S.transfer.countConnections(pending.summary.connections)}</div>
                <div>{S.transfer.countActions(pending.summary.customActions)}</div>
                <div>{S.transfer.countSites(pending.summary.sites)}</div>
                <div>
                  {pending.summary.defaultModel !== undefined
                    ? S.transfer.defaultModel(pending.summary.defaultModel)
                    : S.transfer.defaultModelUnset}
                </div>
              </div>
            </li>
          </ul>
          {pending.keptKeys.length > 0 && <div class="opt-help">{S.transfer.keptKeys(pending.keptKeys)}</div>}
          {pending.missingKeys.length > 0 && (
            <div class="opt-warn">{S.transfer.missingKeys(pending.missingKeys)}</div>
          )}
          <div class="opt-editor__actions">
            <button type="button" class="ra-btn ra-btn--primary" disabled={busy} onClick={() => void apply()}>
              {S.transfer.apply}
            </button>
            <button type="button" class="ra-btn" disabled={busy} onClick={() => setPending(null)}>
              {S.transfer.cancel}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
