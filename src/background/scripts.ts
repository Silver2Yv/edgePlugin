import { browser } from 'wxt/browser';

const SENTINEL_ID = 'sentinel';
const SENTINEL_FILE = 'content-scripts/sentinel.js';

// 对账哨兵的动态注册（5.1）。站点黑名单进 excludeMatches 留到设置契约落地后接入。
export async function reconcileSentinel(): Promise<void> {
  const registered = await browser.scripting.getRegisteredContentScripts({ ids: [SENTINEL_ID] });
  if (registered.length > 0) return;
  await browser.scripting.registerContentScripts([
    {
      id: SENTINEL_ID,
      js: [SENTINEL_FILE],
      matches: ['<all_urls>'],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}
