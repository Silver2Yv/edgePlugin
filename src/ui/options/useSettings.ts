// 设置的读取、订阅与写入（设置页、向导、欢迎页共用）。别处改了设置（小窗记位置、另一个设置页标签）
// 经 storage.onChanged 同步过来，界面始终显示存储里的那一份。
import { useCallback, useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { migrateSettings, type Settings } from '@/core/domain/settings';
import { loadSettings, SETTINGS_KEY } from '@/platform/settings-store';
import { persistSettings } from './api';
import { S } from './strings';

export interface SettingsHandle {
  settings: Settings;
  /** 写设置并取回 mutate 的结果；没写成（存储没锁定、设置损坏）返回 undefined，原因显示在 saveError */
  update<T>(mutate: (base: Settings) => { settings: Settings; result: T }): Promise<T | undefined>;
  /** 只改不取结果的简写；返回是否写成 */
  set(mutate: (base: Settings) => Settings): Promise<boolean>;
  saveError: string | null;
}

export type SettingsState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | ({ phase: 'ready' } & SettingsHandle);

const SAVE_ERROR = {
  locked: S.page.saveLocked,
  corrupt: S.page.saveCorrupt,
  failed: S.page.saveFailed,
} as const;

export function useSettings(): SettingsState {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings().then((r) => {
      if (r.ok) setSettings(r.settings);
      else setLoadError(r.error === 'newerVersion' ? S.page.newerVersion : S.page.corrupt);
    });
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      const c = area === 'local' ? changes[SETTINGS_KEY] : undefined;
      if (!c) return;
      const r = migrateSettings(c.newValue);
      if (r.ok) setSettings(r.settings);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  const update = useCallback(async function update<T>(
    mutate: (base: Settings) => { settings: Settings; result: T },
  ): Promise<T | undefined> {
    const r = await persistSettings(mutate);
    if (!r.ok) {
      setSaveError(SAVE_ERROR[r.error]);
      return undefined;
    }
    setSaveError(null);
    setSettings(r.settings);
    return r.result;
  }, []);

  const set = useCallback(
    async (mutate: (base: Settings) => Settings) =>
      (await update((base) => ({ settings: mutate(base), result: true as const }))) === true,
    [update],
  );

  if (loadError) return { phase: 'error', message: loadError };
  if (!settings) return { phase: 'loading' };
  return { phase: 'ready', settings, update, set, saveError };
}
