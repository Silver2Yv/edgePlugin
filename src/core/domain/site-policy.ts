// 站点权限矩阵（4.1，唯一口径）与 D-01 的补充决定。

export type SiteLevel = 'normal' | 'noToolbar' | 'noRead';

/** 严格程度从低到高；子框架取「顶层站点与框架来源」更严的一级（AR-14） */
const STRICTNESS: Record<SiteLevel, number> = { normal: 0, noToolbar: 1, noRead: 2 };

export function stricter(a: SiteLevel, b: SiteLevel): SiteLevel {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

export interface SiteCapabilities {
  sentinelResident: boolean;
  autoToolbar: boolean;
  /** 快捷键 / 右键唤起（后两级按需注入阅读器） */
  manualInvoke: boolean;
  readExplicitSelection: boolean;
  /** 正文、前后块、标题链、实体回指 */
  readPageContent: boolean;
  cachePageContent: boolean;
  /** 用户主动框选截图 */
  screenshot: boolean;
  /** 提问前向模型请求问题建议 */
  modelSuggestions: boolean;
  /** 本地规则建议（D-01：不发请求、不需要正文，三级都允许） */
  ruleSuggestions: boolean;
  floatAndSidepanel: boolean;
  /** 「实际发送说明」只显示选中字数与「未读取页面」 */
  sendReportSelectionOnly: boolean;
}

export const SITE_MATRIX: Readonly<Record<SiteLevel, Readonly<SiteCapabilities>>> = {
  normal: {
    sentinelResident: true,
    autoToolbar: true,
    manualInvoke: true,
    readExplicitSelection: true,
    readPageContent: true,
    cachePageContent: true,
    screenshot: true,
    modelSuggestions: true,
    ruleSuggestions: true,
    floatAndSidepanel: true,
    sendReportSelectionOnly: false,
  },
  noToolbar: {
    sentinelResident: false,
    autoToolbar: false,
    manualInvoke: true,
    readExplicitSelection: true,
    readPageContent: true,
    cachePageContent: true,
    screenshot: true,
    modelSuggestions: true,
    ruleSuggestions: true,
    floatAndSidepanel: true,
    sendReportSelectionOnly: false,
  },
  noRead: {
    sentinelResident: false,
    autoToolbar: false,
    manualInvoke: true,
    readExplicitSelection: true,
    readPageContent: false,
    cachePageContent: false,
    screenshot: true,
    modelSuggestions: false,
    ruleSuggestions: true,
    floatAndSidepanel: true,
    sendReportSelectionOnly: true,
  },
};

/** 站点规则：按主机名匹配，含子域（D-01）。`example.com` 命中 `a.example.com`，不命中 `badexample.com` */
export interface SiteRule {
  host: string;
  level: Exclude<SiteLevel, 'normal'>;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const isIp = (host: string) => host.startsWith('[') || IPV4.test(host);

/**
 * 把用户输入的站点规则归一成主机名；不合法返回 undefined（设置页提示，匹配时跳过）。
 * 接受 `https://a.com/x`、`*.a.com`、`a.com:8080`、`例子.中国`（转成 punycode）。
 * 至少两段（`com` 这种会命中整个顶级域，拒绝），localhost 除外。
 * IP 地址只做精确匹配：IPv4 必须写全四段（URL 会把 `0.1` 解析成 `0.0.0.1`），IPv6 写成 `[::1]`。
 */
export function normalizeSiteRule(input: string): string | undefined {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0] ?? '';
  s = s.slice(s.lastIndexOf('@') + 1);
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return undefined;
    s = s.slice(0, end + 1);
  } else {
    s = s.replace(/:\d*$/, '');
  }
  s = s.replace(/^\*\./, '').replace(/\.$/, '');
  if (!s) return undefined;
  let host: string;
  try {
    host = new URL(`http://${s}/`).hostname;
  } catch {
    return undefined;
  }
  if (host.startsWith('[')) return host;
  if (IPV4.test(host)) return host === s ? host : undefined;
  if (host === 'localhost') return host;
  return host.includes('.') ? host : undefined;
}

export function siteLevelFor(hostname: string, rules: readonly SiteRule[]): SiteLevel {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  let level: SiteLevel = 'normal';
  for (const r of rules) {
    const host = normalizeSiteRule(r.host);
    if (host === undefined) continue;
    const hit = isIp(host) ? h === host : h === host || h.endsWith(`.${host}`);
    if (hit) level = stricter(level, r.level);
  }
  return level;
}

/** 按地址取站点级别；拿不到主机名（非 http(s)、地址非法）时按 normal（这类页面本来就不注入、不读取） */
export function siteLevelForUrl(url: string | undefined, rules: readonly SiteRule[]): SiteLevel {
  if (!url) return 'normal';
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'normal';
    host = u.hostname;
  } catch {
    return 'normal';
  }
  return siteLevelFor(host, rules);
}

/** 一个框架的实际级别：顶层站点与框架来源取更严（4.1、AR-14）。顶层框架两者相同 */
export function frameSiteLevel(
  topUrl: string | undefined,
  frameUrl: string | undefined,
  rules: readonly SiteRule[],
): SiteLevel {
  return stricter(siteLevelForUrl(topUrl, rules), siteLevelForUrl(frameUrl, rules));
}

/**
 * 哨兵动态注册的 excludeMatches（4.1：两级都不常驻）。域名规则写成 `*://*.host/*`，同时命中本域与子域；
 * IPv4 与 localhost 写成 `*://host/*`（匹配模式不含端口，任何端口都命中）。
 * IPv6 字面量不是合法的匹配模式主机，写进去会让整个注册失败，所以跳过：这类站点的哨兵照常常驻，
 * 但读取与发送仍由后台按策略拦截（不影响隐私，只影响「不自动弹工具栏」）。结果去重、排序，便于对账比较
 */
export function sentinelExcludeMatches(rules: readonly SiteRule[]): string[] {
  const out = new Set<string>();
  for (const r of rules) {
    const host = normalizeSiteRule(r.host);
    if (host === undefined || host.startsWith('[')) continue;
    out.add(isIp(host) || host === 'localhost' ? `*://${host}/*` : `*://*.${host}/*`);
  }
  return [...out].sort();
}

/**
 * 策略变更时在途任务的处理（D-01）：已发出网络请求的继续到终态；
 * 已接单但尚未发出的取消（终态 stopped，原因 policyChanged）。
 */
export type PolicyChangeEffect = 'continue' | 'cancel';
export function onPolicyChange(requestSent: boolean): PolicyChangeEffect {
  return requestSent ? 'continue' : 'cancel';
}
