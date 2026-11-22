// data: URL 与字节之间的转换（截图在后台、数据库、请求之间流转用）。纯逻辑，只用语言内置的 atob / btoa。

/** 拆出 data: URL 的类型与 base64 正文；不是 base64 的 data: URL 返回 undefined */
export function parseDataUrl(url: string): { mime: string; base64: string } | undefined {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]*)$/.exec(url);
  return m ? { mime: m[1] as string, base64: m[2] as string } : undefined;
}

export function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  // 分段拼，避免 String.fromCharCode 参数过多
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  return btoa(bin);
}

export const toDataUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${bytesToBase64(bytes)}`;
