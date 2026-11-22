// 设置页 / 向导与外界打交道的几件事：写设置（5.11 的写入顺序）、让后台测试连接与拉模型列表（规则 1：
// 只有后台发模型请求，Key 不经消息）。界面组件只调这里，不直接碰 storage 与 runtime 消息。
import { browser } from 'wxt/browser';
import type { OptionsToBackground } from '@/core/domain/messages';
import type { Settings } from '@/core/domain/settings';
import { loadSettings, SETTINGS_KEY } from '@/platform/settings-store';
import {
  asConnectionTestResult,
  asListModelsResult,
  isLockedTrue,
  type ModelListResult,
  type TestResult,
} from './model';

const send = (msg: OptionsToBackground): Promise<unknown> =>
  browser.runtime.sendMessage<OptionsToBackground, unknown>(msg);

export type PersistResult<T> =
  | { ok: true; settings: Settings; result: T }
  | { ok: false; error: 'locked' | 'corrupt' | 'failed' };

/**
 * 5.11 的写入顺序：先向后台确认 storage 已收紧为仅扩展自身（settings/ensureLocked），再读一份最新设置做合并，
 * 整份 Settings 写回。存储没锁定、设置已损坏时不落盘。mutate 拿到的是存储里最新的那份（不是界面上可能过期的）
 */
export async function persistSettings<T>(
  mutate: (base: Settings) => { settings: Settings; result: T },
): Promise<PersistResult<T>> {
  try {
    if (!isLockedTrue(await send({ type: 'settings/ensureLocked' }))) return { ok: false, error: 'locked' };
    const loaded = await loadSettings();
    if (!loaded.ok) return { ok: false, error: 'corrupt' };
    const { settings, result } = mutate(loaded.settings);
    await browser.storage.local.set({ [SETTINGS_KEY]: settings });
    return { ok: true, settings, result };
  } catch {
    return { ok: false, error: 'failed' };
  }
}

/** 测试已保存的连接；后台应答形状不对（扩展版本不一致等）返回 null */
export async function testConnection(connectionId: string, model: string): Promise<TestResult | null> {
  try {
    return asConnectionTestResult(await send({ type: 'connection/test', connectionId, model }));
  } catch {
    return null;
  }
}

export async function listModels(connectionId: string): Promise<ModelListResult> {
  try {
    return asListModelsResult(await send({ type: 'connection/listModels', connectionId }));
  } catch {
    return { ok: false };
  }
}

/** 复制到剪贴板：先用 Clipboard API，不行退回 execCommand（扩展页面里点击后调用，两条路都有用户手势） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
