// 小窗就绪状态机（5.2）与握手令牌（5.3）、转接（5.3、6.4）。

export type FloatReadiness = 'unknown' | 'loading' | 'ready' | 'failedUnsupported' | 'failedTransient';

/** 点「问」时去哪：小窗，或同步打开侧边栏（仍在用户手势内） */
export type AskRoute = 'float' | 'sidepanel';

export function routeOnAsk(state: FloatReadiness): AskRoute {
  return state === 'failedUnsupported' || state === 'failedTransient' ? 'sidepanel' : 'float';
}

/**
 * 这一页能不能放小窗：要能注入阅读器。标签页地址看不到（没有主机权限，如浏览器内部页面）或不是网页时不能，
 * 快捷键、右键改走侧边栏（同步打开，规则 10）
 */
export function floatHostable(url: string | undefined): boolean {
  return url !== undefined && /^(https?|file):/i.test(url);
}

export const FLOAT_LIMITS = {
  /** loading 超过这么久未完成握手，转 failedTransient（D-02 初值） */
  loadTimeoutMs: 5_000,
  /** failedUnsupported 按站点缓存；浏览器大版本更新后失效 */
  unsupportedCacheMs: 30 * 24 * 3600 * 1000,
  /** 标签页隐藏多久销毁预热 iframe */
  idleDestroyMs: 10 * 60 * 1000,
  /** 小窗缩放的最小尺寸（5.3） */
  minWidth: 200,
  minHeight: 160,
} as const;

/** 按站点缓存的结构性失败；failedTransient 不缓存 */
export interface FloatUnsupportedEntry {
  host: string;
  browserMajor: number;
  at: number;
}

/**
 * 握手令牌：128 位随机、一次性、60 秒，存 storage.session（键见 session-keys.ts）。
 * 核对：令牌的 tabId 必须等于小窗的 sender.tab.id。documentId 是宿主页面的，只用于宿主导航后作废令牌。
 * 原子消费：后台在内存 Map 里同步读出即删，同一同步段内完成，两次 hello 不会都成功；storage.session 只作重启后的备份。
 */
export interface FloatToken {
  token: string;
  tabId: number;
  documentId: string;
  expiresAt: number;
}

export const TOKEN_TTL_MS = 60_000;
/** 128 位 = 32 个十六进制字符 */
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/**
 * 小窗绑定（断线重连，conv/resumeFloat）：helloFloat 成功后记下小窗文档，存 storage.session，每个标签页一份。
 * documentId 由浏览器给出，网页伪造不了；小窗 iframe 重新加载会换 documentId，绑定随之失效，需要新令牌。
 * 宿主导航、标签页关闭、预热 iframe 销毁时删除。
 */
export interface FloatBinding {
  tabId: number;
  frameId: number;
  /** 小窗自身的文档（sender.documentId） */
  floatDocumentId: string;
  /** 宿主页面的文档（取自令牌），宿主导航后作废 */
  hostDocumentId: string;
  boundAt: number;
}

/** 重连核对：三项都要对上；sender 没给 documentId 时一律拒绝（是否总会给出待 V-05 实测） */
export function bindingMatches(
  b: FloatBinding | undefined,
  sender: { tabId?: number; frameId?: number; documentId?: string },
): boolean {
  return (
    b !== undefined &&
    sender.documentId !== undefined &&
    b.tabId === sender.tabId &&
    b.frameId === sender.frameId &&
    b.floatDocumentId === sender.documentId
  );
}

/**
 * 转到侧边栏：侧边栏订阅成功后才收起小窗（AR-19）。存 storage.session（键见 session-keys.ts），短期有效。
 * conversationId 可选：还没发问的小窗也能转，侧边栏接手这个标签页（contract-v1.3 增量）
 */
export interface Handoff {
  handoffId: string;
  windowId: number;
  tabId: number;
  conversationId?: string;
  expiresAt: number;
}

/** 转接的有效期：侧边栏要在这段时间里连上并订阅，否则作废（小窗不收起，已提示用户） */
export const HANDOFF_TTL_MS = 30_000;

/** 侧边栏带 handoffId 订阅时核对：窗口、标签页、对话都要对上，且未过期 */
export function handoffMatches(
  h: Handoff | undefined,
  sub: { windowId: number; tabId: number; conversationId: string | undefined; now: number },
): boolean {
  return (
    h !== undefined &&
    h.expiresAt > sub.now &&
    h.windowId === sub.windowId &&
    h.tabId === sub.tabId &&
    (h.conversationId === undefined || h.conversationId === sub.conversationId)
  );
}
