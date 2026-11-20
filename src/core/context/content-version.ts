// 内容指纹（5.6 contentVersion）与块摘要。纯逻辑：阅读器抽取后算一次，后台收到页面模型后按同一算法重算核对，
// 对不上就当作无效模型丢弃（阅读器自报的版本不直接采信）。
// 指纹只看标题与各块的类型和文字：URL、main 节点、总长度都不参与——「长度一致」不能当作「内容一致」（V-06）。
import type { ContentVersion } from '../domain/ids';

/** cyrb53：53 位非加密哈希，输出 base36。只用来判断「内容变没变」，不做安全用途 */
export function hash53(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 块文本摘要（锚点的 blockDigest 也用它）：只含 [0-9a-z] */
export const blockDigest = (text: string): string => hash53(text);

/** 指纹格式版本：改了算法就加一，旧缓存自然失效 */
const VERSION_PREFIX = 'v1-';

/** 内容指纹 = 标题 + 各块（类型 + 文字摘要）的哈希；两个种子拼起来，约 106 位 */
export function contentVersionOf(
  title: string,
  blocks: readonly { kind: string; text: string }[],
): ContentVersion {
  const parts = [title];
  for (const b of blocks) parts.push(`${b.kind}:${blockDigest(b.text)}`);
  const all = parts.join('\n');
  return `${VERSION_PREFIX}${hash53(all, 1)}${hash53(all, 2)}`;
}
