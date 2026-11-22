// 怪癖学习的存储（5.8 AR-09，V-07 未执行项）：独立的 storage.local 键，和 settings 分开存，
// 不占用设置版本号；纯粹的「一张表怎么增删查」在 core/llm/quirks.ts，这里只管读写 storage.local。
import { browser } from 'wxt/browser';
import type { Connection } from '@/core/llm/adapter';
import { EMPTY_QUIRKS, type QuirksTable, quirksFor, withQuirk } from '@/core/llm/quirks';

const STORAGE_KEY = 'gatewayQuirks';

async function readAll(): Promise<QuirksTable> {
  const got = await browser.storage.local.get(STORAGE_KEY);
  const v = got[STORAGE_KEY];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as QuirksTable) : EMPTY_QUIRKS;
}

/** 这个连接 + 接口类型 + 模型 + 配置版本已经学到的、应该预先不发的参数名 */
export async function loadQuirks(
  conn: Pick<Connection, 'id' | 'interfaceType' | 'configVersion'>,
  model: string,
): Promise<readonly string[]> {
  return quirksFor(await readAll(), conn, model);
}

/** 记一条新学到的怪癖；已经记过的不重复写 */
export async function recordQuirk(
  conn: Pick<Connection, 'id' | 'interfaceType' | 'configVersion'>,
  model: string,
  param: string,
): Promise<void> {
  const all = await readAll();
  const next = withQuirk(all, conn, model, param);
  if (next !== all) await browser.storage.local.set({ [STORAGE_KEY]: next });
}
