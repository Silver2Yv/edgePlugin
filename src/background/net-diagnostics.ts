// 只读网络诊断（H9、5.8「网络层诊断」）：webRequest 监听已登记的模型接口地址的请求错误，取浏览器
// 错误码（DNS、证书、代理、连接被拒等）备查。webRequest 监听器必须在后台顶层同步注册才能观察到
// Service Worker 自己发出的请求（prototypes/net-probe 实测过，T6c：fetch 本身只给「Failed to
// fetch」，浏览器错误码只能从 webRequest 拿）；这里用工厂函数而不是模块级副作用，注册时机由调用方
// （browser-deps.ts）决定，单测不传 webRequest 也能正常工作（返回 undefined，不是报错）。
// 按主机名（而不是某个请求编号）关联：fetch() 不返回网络层的 requestId，只能退而求其次按「这个主机
// 最近一次错误」归因（规则 6：只关注用户登记的连接地址，不是任意主机）。

export interface NetDiagnostics {
  /** 登记要关注的主机（来自正在使用的连接地址）；未登记的主机错误不记录 */
  watch(hosts: readonly string[]): void;
  /**
   * 发起请求前的时间戳作为下限；取同一主机在此之后发生的最近一次浏览器错误码。
   * webRequest 的事件是异步送达的，fetch() 的 reject 不保证等它先到（prototypes/net-probe
   * T6c 实测：两者各自独立，经验上留出几百毫秒的宽限期足够），所以这里短暂轮询一下，不是立等。
   */
  netErrorFor(url: string, sinceMs: number): Promise<string | undefined>;
}

interface ErrorEvent {
  url: string;
  error: string;
  timeStamp: number;
}

export interface WebRequestLike {
  onErrorOccurred: {
    addListener(cb: (d: ErrorEvent) => void, filter: { urls: string[] }): void;
  };
}

/** 超过这么久的错误不再视为「刚刚那次请求」的归因证据 */
const RECENT_MS = 10_000;
/** 等 webRequest 事件落进来的宽限期与轮询间隔 */
const GRACE_MS = 300;
const POLL_MS = 20;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export function createNetDiagnostics(webRequestApi: WebRequestLike | undefined): NetDiagnostics {
  const watched = new Set<string>();
  const recent = new Map<string, { error: string; at: number }>();
  webRequestApi?.onErrorOccurred.addListener(
    (d) => {
      const host = hostnameOf(d.url);
      if (host === undefined || !watched.has(host)) return;
      recent.set(host, { error: d.error, at: d.timeStamp });
    },
    { urls: ['<all_urls>'] },
  );
  const match = (host: string, sinceMs: number): string | undefined => {
    const hit = recent.get(host);
    return hit && hit.at >= sinceMs && Date.now() - hit.at <= RECENT_MS ? hit.error : undefined;
  };
  return {
    watch(hosts) {
      for (const h of hosts) watched.add(h);
    },
    async netErrorFor(url, sinceMs) {
      const host = hostnameOf(url);
      if (host === undefined) return undefined;
      const deadline = Date.now() + GRACE_MS;
      for (;;) {
        const hit = match(host, sinceMs);
        if (hit !== undefined || Date.now() >= deadline) return hit;
        await sleep(POLL_MS);
      }
    },
  };
}
