import { browser } from 'wxt/browser';
import type { InstallOpenTabs } from '@/core/domain/session-keys';
import { DEFAULT_SETTINGS, type Settings } from '@/core/domain/settings';
import { sentinelExcludeMatches, siteLevelForUrl } from '@/core/domain/site-policy';
import { loadSettings } from '@/platform/settings-store';

const SENTINEL_ID = 'sentinel';
const SENTINEL_FILE = 'content-scripts/sentinel.js';

/** 设置读不出（损坏、版本更新）时按无黑名单处理：哨兵照常注册，读取与发送仍由后台按最新可读的策略拦截 */
async function currentSettings(): Promise<Settings> {
  const r = await loadSettings();
  return r.ok ? r.settings : DEFAULT_SETTINGS;
}

/** 对账排队执行：安装时的对账与设置变更的对账同时到达，各自先查到「未注册」再各注册一次会撞号失败（e2e 复现） */
let queue: Promise<void> = Promise.resolve();

/**
 * 对账哨兵的动态注册（5.1、4.1）：两级黑名单进 excludeMatches，站点上不常驻任何脚本。
 * 安装、启动、站点规则变更时调用；注册表与期望一致就不动。已打开的网页里的旧哨兵要到下次加载才移除——
 * 这只影响「自动弹出工具栏」，读取与发送由后台按最新策略立即拦截（4.1 生效时机）
 */
export function reconcileSentinel(settings?: Settings): Promise<void> {
  const run = queue.then(() => reconcileOnce(settings));
  queue = run.catch(() => undefined);
  return run;
}

async function reconcileOnce(settings?: Settings): Promise<void> {
  const [s, [registered]] = await Promise.all([
    settings ?? currentSettings(),
    browser.scripting.getRegisteredContentScripts({ ids: [SENTINEL_ID] }),
  ]);
  const exclude = sentinelExcludeMatches(s.sites);
  if (registered) {
    const now = [...(registered.excludeMatches ?? [])].sort();
    if (now.length === exclude.length && now.every((m, i) => m === exclude[i])) return;
    await browser.scripting.updateContentScripts([
      { id: SENTINEL_ID, js: [SENTINEL_FILE], excludeMatches: exclude },
    ]);
    return;
  }
  await browser.scripting.registerContentScripts([
    {
      id: SENTINEL_ID,
      js: [SENTINEL_FILE],
      matches: ['<all_urls>'],
      ...(exclude.length ? { excludeMatches: exclude } : {}),
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}

/**
 * 安装或更新时，向已经打开的普通网页注入哨兵（5.1、L5）：动态注册只对之后加载的网页生效，
 * 不注入的话用户得刷新网页才能划词。注入失败的页面（商店页、PDF 查看器等）跳过；
 * 网页里已有的旧哨兵由新哨兵替换（见 page/sentinel.ts）。顶层站点在黑名单里的标签页不注入（4.1 不常驻）；
 * 同一标签页里来源在黑名单的子框架无法单独排除，那里的哨兵会向后台问级别，不是正常级别就不弹工具栏。
 * 返回直接生效与没能注入的标签页数（黑名单里的不算），欢迎页据此提示刷新（L5）
 */
export async function injectSentinelIntoOpenTabs(): Promise<InstallOpenTabs> {
  const { sites } = await currentSettings();
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const results = await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined || siteLevelForUrl(tab.url, sites) !== 'normal'
        ? undefined
        : browser.scripting
            .executeScript({ target: { tabId: tab.id, allFrames: true }, files: [`/${SENTINEL_FILE}`] })
            .then(
              () => true,
              () => false,
            ),
    ),
  );
  return {
    injected: results.filter((r) => r === true).length,
    failed: results.filter((r) => r === false).length,
  };
}
