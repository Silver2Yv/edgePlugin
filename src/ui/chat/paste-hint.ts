// 粘贴外部图片时的提示「不再提醒」（决策 099）。记在 storage.local 的独立键，不放进设置（settings）：
// 1) 它是界面提示的个人偏好，不是配置；设置有版本号与迁移、设置导入导出也要照它的结构走，多一个字段会牵动那两处；
// 2) 小窗与侧边栏是两个页面，都靠 storage.onChanged 同步（和 quirk-store 的独立键同一做法）；
// 3) 导入别人导出的设置时，不该顺带替用户关掉（或打开）提示。
// 存储接口收成最小的一小块，单测传假的。
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';

export const PASTE_HINT_OFF_KEY = 'pasteHintOff';

export interface HintStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** 用户点过「不再提醒」吗；读不出来按「没点过」（多提醒一次比悄悄吞掉提示好） */
export async function loadPasteHintOff(area: HintStorage): Promise<boolean> {
  try {
    return (await area.get(PASTE_HINT_OFF_KEY))[PASTE_HINT_OFF_KEY] === true;
  } catch {
    return false;
  }
}

export async function savePasteHintOff(area: HintStorage): Promise<void> {
  await area.set({ [PASTE_HINT_OFF_KEY]: true });
}

/** 界面用：当前是否不再提醒，与另一个页面的改动同步；off() 记住用户的选择 */
export function usePasteHintOff(): { hintOff: boolean; turnOff: () => void } {
  const [hintOff, setHintOff] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadPasteHintOff(browser.storage.local).then((v) => alive && setHintOff(v));
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes[PASTE_HINT_OFF_KEY])
        setHintOff(changes[PASTE_HINT_OFF_KEY]?.newValue === true);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return {
    hintOff,
    turnOff: () => {
      setHintOff(true);
      void savePasteHintOff(browser.storage.local).catch(() => undefined);
    },
  };
}
