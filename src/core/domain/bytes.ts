// 字节口径（5.12）：跨进程单条消息上限按 JSON 序列化后的 UTF-8 字节算。
// 字段上限也用同一口径（字符串 JSON 编码后的字节数，不含两端引号），
// 这样「每个字段都在上限内」就能推出「整条消息不超过 64 KB」。

/** 单个字符（码点）在 JSON 字符串里占的 UTF-8 字节数，与 JSON.stringify 一致 */
function charCost(cp: number): number {
  if (cp === 0x22 || cp === 0x5c) return 2; // " \
  if (cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d) return 2;
  if (cp < 0x20) return 6; // \u00XX
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp >= 0xd800 && cp <= 0xdfff) return 6; // 孤立代理项被转义成 \udXXX
  if (cp < 0x10000) return 3;
  return 4;
}

/** 字符串 JSON 编码后的字节数（不含两端引号） */
export function jsonStringBytes(s: string): number {
  let n = 0;
  for (const ch of s) n += charCost(ch.codePointAt(0) ?? 0);
  return n;
}

/** 按 JSON 字节切分，每片不超过 maxBytes；按码点切，不切断代理对。maxBytes 至少 6 */
export function splitByJsonBytes(s: string, maxBytes: number): string[] {
  if (maxBytes < 6) throw new RangeError('maxBytes 至少为 6');
  const parts: string[] = [];
  let cur = '';
  let size = 0;
  for (const ch of s) {
    const c = charCost(ch.codePointAt(0) ?? 0);
    if (size + c > maxBytes) {
      parts.push(cur);
      cur = '';
      size = 0;
    }
    cur += ch;
    size += c;
  }
  if (cur || parts.length === 0) parts.push(cur);
  return parts;
}

/** 按 JSON 字节截断；truncated 为真时调用方须在「实际发送说明」里写明 */
export function truncateByJsonBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (jsonStringBytes(s) <= maxBytes) return { text: s, truncated: false };
  return { text: splitByJsonBytes(s, maxBytes)[0] ?? '', truncated: true };
}
