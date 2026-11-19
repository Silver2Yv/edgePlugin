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

/**
 * 安装或更新时，向已经打开的普通网页注入哨兵（5.1、L5）：动态注册只对之后加载的网页生效，
 * 不注入的话用户得刷新网页才能划词。注入失败的页面（商店页、PDF 查看器等）跳过；
 * 网页里已有的旧哨兵由新哨兵替换（见 page/sentinel.ts）
 */
export async function injectSentinelIntoOpenTabs(): Promise<void> {
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined
        ? undefined
        : browser.scripting
            .executeScript({ target: { tabId: tab.id, allFrames: true }, files: [`/${SENTINEL_FILE}`] })
            .catch(() => undefined),
    ),
  );
}
