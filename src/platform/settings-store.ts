// 设置读取（5.11）：存 storage.local 的 SETTINGS_KEY 下，读出后统一走迁移与校验。
// 只给扩展页面和后台用；内容脚本不读设置，它需要的由后台下发。
import { browser } from 'wxt/browser';
import { type MigrateResult, migrateSettings } from '@/core/domain/settings';

export const SETTINGS_KEY = 'settings';

/** 失败（corrupt / newerVersion）时调用方不得用默认值覆盖存储里的原值 */
export async function loadSettings(): Promise<MigrateResult> {
  const got = await browser.storage.local.get(SETTINGS_KEY);
  return migrateSettings(got[SETTINGS_KEY]);
}
