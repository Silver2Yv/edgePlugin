// 回到某一页（jump/open，contract-v1.6 增量，决策 098）：侧边栏查看别的页面的对话时点「回到那一页」、
// 收藏列表点「回到原文」，共用这一条后台路径。
//
// | 步骤 | 依据 |
// | 谁能发 | 只有侧边栏（授权表）；窗口取自握手定下的 windowId，不取自消息（规则 7） |
// | 目标地址 | 后台按 pageKey / favoriteId 从库里取（PageRecord.url / FavoriteRecord.url）；消息里没有地址（规则 6）；只开 http / https / file |
// | 找标签页 | 本窗口里按地址找已打开的那一页（活动的优先），找到就切过去，没有就新开并等加载完成 |
// | 到了没有 | 加载超时、加载中途被关、打开后地址对不上记录（重定向到别处）都不继续，回原因 |
// | 回原文 | 收藏带锚点：站点不读取只打开页面；否则让阅读器按锚点定位并高亮（沿用引用跳回的三级降级，citations.locateAnchor） |
// 新开的页面正文可能还在渲染：定位没找到时隔一会儿再试一次。
import type { Anchor } from '@/core/anchor/anchor';
import { toPageKey } from '@/core/context/page-key';
import type { BackgroundToClient, CitationFailReason, ClientToBackground } from '@/core/domain/messages';
import { siteLevelForUrl } from '@/core/domain/site-policy';
import type { Citations } from './citations';
import type { BackgroundDeps } from './deps';

type JumpMsg = Extract<ClientToBackground, { type: 'jump/open' }>;
type Result = Extract<BackgroundToClient, { type: 'jump/result' }>;
type Reply = (msg: BackgroundToClient) => void;

/** 新开页面等加载完成的上限 */
export const JUMP_LOAD_TIMEOUT_MS = 15_000;
/** 新开页面定位没找到：隔这么久再试一次（单页应用渲染正文要时间） */
export const JUMP_RETRY_MS = 800;

/** 页面身份：http(s) 用 pageKey 规则，其他（file）去掉 # 之后按地址整体比 */
const keyOfUrl = (url: string): string => toPageKey(url) ?? url.split('#')[0] ?? url;

const openable = (url: string): boolean => {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:' || p === 'file:';
  } catch {
    return false;
  }
};

export type Jump = ReturnType<typeof createJump>;

export function createJump(deps: BackgroundDeps, citations: Pick<Citations, 'locateAnchor'>) {
  async function open(windowId: number, msg: JumpMsg, reply: Reply): Promise<void> {
    const fail = (reason: CitationFailReason): void => {
      deps.log('jump/failed', { reason });
      reply({ type: 'jump/result', requestId: msg.requestId, ok: false, reason });
    };
    const tabs = deps.tabs;
    if (!tabs) return fail('openFailed');

    // 目标地址只从库里取
    let url: string;
    let anchor: Anchor | undefined;
    try {
      if (msg.favoriteId !== undefined) {
        const f = await deps.db.getFavorite(msg.favoriteId);
        if (!f) return fail('noRecord');
        url = f.url;
        anchor = f.anchor;
      } else {
        const p = await deps.db.getPage(msg.pageKey as string);
        if (!p) return fail('noRecord');
        url = p.url;
      }
    } catch {
      return fail('noRecord');
    }
    if (!openable(url)) return fail('badUrl');
    const want = keyOfUrl(url);

    // 本窗口已经打开的那一页：活动的优先，没有活动的取第一个
    let tabId: number;
    let opened: 'existing' | 'new';
    try {
      const hits = (await tabs.list(windowId)).filter((t) => t.url !== undefined && keyOfUrl(t.url) === want);
      const hit = hits.find((t) => t.active) ?? hits[0];
      if (hit) {
        tabId = hit.id;
        opened = 'existing';
        if (!hit.active) await tabs.activate(tabId);
      } else {
        tabId = await tabs.create(windowId, url);
        opened = 'new';
      }
    } catch {
      return fail('openFailed');
    }

    const loaded = await tabs.waitLoaded(tabId, JUMP_LOAD_TIMEOUT_MS).catch(() => 'closed' as const);
    if (loaded === 'timeout') return fail('loadTimeout');
    if (loaded === 'closed') return fail('openFailed');
    const finalUrl = await deps.getTabUrl?.(tabId).catch(() => undefined);
    if (finalUrl === undefined || keyOfUrl(finalUrl) !== want) return fail('redirected');

    const done = (extra: Partial<Result> = {}): void => {
      deps.log('jump/result', { opened, level: extra.level, reason: extra.reason });
      reply({ type: 'jump/result', requestId: msg.requestId, ok: true, tabId, opened, ...extra });
    };
    // 页面的对话：到了就行；收藏没有锚点：只打开页面
    if (msg.favoriteId === undefined) return done();
    if (!anchor) return done({ reason: 'noAnchor' });
    const loadedSettings = await deps.loadSettings();
    if (loadedSettings.ok && siteLevelForUrl(finalUrl, loadedSettings.settings.sites) === 'noRead') {
      return done({ level: 'none', reason: 'siteBlocked' });
    }
    let r = await citations.locateAnchor(tabId, anchor);
    if (r.ok && r.level === 'none' && opened === 'new') {
      await new Promise<void>((resolve) => setTimeout(resolve, JUMP_RETRY_MS));
      r = await citations.locateAnchor(tabId, anchor);
    }
    if (!r.ok) return done({ level: 'none', reason: 'unavailable' });
    if (r.level === 'none') return done({ level: 'none', reason: 'notFound' });
    done({ level: r.level, ...(r.back ? { back: true } : {}) });
  }

  return { open };
}
