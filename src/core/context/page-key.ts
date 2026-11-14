// pageKey 规范化（5.6、D-04）：去锚点与明确的跟踪参数；`#/`、`#!` 路由保留锚点。
import type { PageKey } from '../domain/ids';

/** 规则版本：改动下面的规则就加一，旧 pageKey 按需迁移 */
export const PAGE_KEY_VERSION = 1;

/**
 * 明确的跟踪参数（D-04）。前缀匹配的以 `*` 结尾。
 * 只收确定不影响页面内容的参数；像小红书的 xsec_token 是访问凭据，去掉会打不开页面，不能加进来。
 */
export const TRACKING_PARAMS: readonly string[] = [
  'utm_*',
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'srsltid',
  '_gl',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  '_hsenc',
  '_hsmi',
  'igshid',
  'ttclid',
  'twclid',
  'li_fat_id',
  'spm',
  'scm',
  'spm_id_from',
  'from_source',
  'share_source',
  'share_medium',
  'vd_source',
];

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.some((p) => (p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p));
}

/** 查询串里的参数名（按 application/x-www-form-urlencoded 解码）；解码失败按原样比较 */
function paramName(pair: string): string {
  const raw = pair.split('=', 1)[0] ?? '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/**
 * 只对 http(s) 页面有意义；其他协议返回 undefined（不归档）。
 * 保留的参数不重新编码：URLSearchParams 会把 `%20` 改成 `+`，同一页面就会有两个 key。
 */
export function toPageKey(url: string): PageKey | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.search) {
    const pairs = u.search.slice(1).split('&');
    const kept = pairs.filter((p) => !isTracking(paramName(p)));
    if (kept.length !== pairs.length) u.search = kept.length ? `?${kept.join('&')}` : '';
  }
  if (!u.hash.startsWith('#/') && !u.hash.startsWith('#!')) u.hash = '';
  return u.toString();
}
