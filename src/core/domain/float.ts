// 小窗就绪状态机（5.2）与握手令牌（5.3）、转接（5.3、6.4）。

export type FloatReadiness = 'unknown' | 'loading' | 'ready' | 'failedUnsupported' | 'failedTransient';

/** 点「问」时去哪：小窗，或同步打开侧边栏（仍在用户手势内） */
export type AskRoute = 'float' | 'sidepanel';

export function routeOnAsk(state: FloatReadiness): AskRoute {
  return state === 'failedUnsupported' || state === 'failedTransient' ? 'sidepanel' : 'float';
}

export const FLOAT_LIMITS = {
  /** loading 超过这么久未完成握手，转 failedTransient（D-02 初值） */
  loadTimeoutMs: 5_000,
  /** failedUnsupported 按站点缓存；浏览器大版本更新后失效 */
  unsupportedCacheMs: 30 * 24 * 3600 * 1000,
  /** 标签页隐藏多久销毁预热 iframe */
  idleDestroyMs: 10 * 60 * 1000,
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

/** 转到侧边栏：侧边栏订阅成功后才收起小窗（AR-19） */
export interface Handoff {
  handoffId: string;
  windowId: number;
  tabId: number;
  conversationId: string;
  expiresAt: number;
}
