/**
 * 链接协议白名单（5.10）：http、https、mailto。
 * 必须能抵御大小写混淆、空白字符（包括 tab/换行拆散协议名）、
 * 以及十进制/十六进制 HTML 实体编码变体（如 &#106;avascript:）。
 *
 * 判定策略（比规格更严，取"宁可误判成纯文本，不可放过危险协议"）：
 * 1. 解码数字字符引用（&#106; / &#x6A;），避免实体编码绕过。
 * 2. 删除字符串中任意位置的 TAB / LF / CR（浏览器解析 URL 时的同类规则），
 *    防止 "java\tscript:" 这类插入空白拆散协议名的写法。
 * 3. 去除首尾空白与 ASCII 控制字符。
 * 4. 用正则提取协议名并转小写比较；提取不到合法协议名（相对地址、
 *    协议相对地址 "//" 等）一律视为不在白名单内，交由上层转成纯文本。
 *
 * 移植自 prototypes/v10-render/src/render/protocol.ts（V-10 原型已验证，见 RESULT.md）。
 */

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto']);

function decodeNumericEntities(input: string): string {
  return input.replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_m, body: string) => {
    try {
      const code = body.charAt(0).toLowerCase() === 'x' ? parseInt(body.slice(1), 16) : parseInt(body, 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  });
}

function stripUrlNoiseChars(input: string): string {
  // 对齐浏览器 URL 解析对 TAB(0x09)/LF(0x0A)/CR(0x0D) 的“任意位置删除”规则。
  return input.replace(/[\t\n\r]/g, '');
}

export function extractScheme(rawHref: string): string | null {
  const decoded = decodeNumericEntities(rawHref);
  const stripped = stripUrlNoiseChars(decoded);
  // 去掉首尾空白与 ASCII 控制字符（含 0x00-0x1F、0x7F）：安全相关的既定行为，故意匹配控制字符
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 协议白名单需要剥离首尾控制字符，见上方注释
  const trimmed = stripped.replace(/^[\x00-\x20\x7f]+/, '').replace(/[\x00-\x20\x7f]+$/, '');
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  return m ? (m[1] ?? '').toLowerCase() : null;
}

export function isAllowedLinkProtocol(rawHref: string): boolean {
  const scheme = extractScheme(rawHref);
  return scheme !== null && ALLOWED_SCHEMES.has(scheme);
}
