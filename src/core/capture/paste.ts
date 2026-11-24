// 外部图片粘贴（决策 099，contract-v1.6 增量）：输入框粘贴的图片字节分片经对话端口交给后台。
// 单条消息不超过 64 KB（5.12），所以按 PASTE_CHUNK_BYTES 切片、base64 发送；后台按这里的规则重新拼好。
// 纯逻辑，不依赖扩展 API：界面（切片）与后台（拼装与校验）共用常量，单测直接测。后台不信界面——声明的大小、
// 分片个数、顺序、每片长度、文件头与声明的类型都要对得上，对不上整次丢弃。
import { base64ToBytes } from './data-url';

/** 接受的图片类型：系统截图与常见截图软件复制出来的格式 */
export const PASTE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'] as const;
export type PasteMime = (typeof PASTE_MIMES)[number];

/** 粘贴的原图最大字节数。4K 截图的 PNG 常见 5–10 MB；超过的在界面与后台都明确拒绝，不悄悄压缩 */
export const MAX_PASTE_BYTES = 16 * 1024 * 1024;
/** 每片的原始字节数：36 KB 的 base64 恰好 48 KB（无填充），加上字段开销仍小于 64 KB */
export const PASTE_CHUNK_BYTES = 36 * 1024;
/** 每片 base64 正文的字符上限（paste/chunk.data 的校验用） */
export const PASTE_CHUNK_CHARS = (PASTE_CHUNK_BYTES / 3) * 4;
/** 最多多少片（MAX_PASTE_BYTES 刚好切满） */
export const MAX_PASTE_CHUNKS = Math.ceil(MAX_PASTE_BYTES / PASTE_CHUNK_BYTES);

export const isPasteMime = (m: string): m is PasteMime => (PASTE_MIMES as readonly string[]).includes(m);

export const pasteChunkCount = (size: number): number => Math.ceil(size / PASTE_CHUNK_BYTES);

/** 按文件头判断真实类型；不认识返回 undefined（不信声明的类型） */
export function sniffImage(b: Uint8Array): PasteMime | undefined {
  const at = (i: number) => b[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp';
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return 'image/webp';
  return undefined;
}

export interface PasteBeginMsg {
  uploadId: string;
  mime: PasteMime;
  size: number;
  chunks: number;
}
export interface PasteChunkMsg {
  uploadId: string;
  index: number;
  data: string;
}

/**
 * 步骤结果。more：收到了，还没收齐；done：收齐且文件头对得上；
 * fail：tooLarge 超过上限、badImage 文件头不是声明的图片类型（都应告诉用户）、invalid 协议对不上（顺序、片长、编号，
 * 按拒绝处理）。fail 之后这次上传已丢弃
 */
export type PasteStep =
  | { kind: 'more' }
  | { kind: 'done'; bytes: Uint8Array; mime: PasteMime }
  | { kind: 'fail'; reason: 'tooLarge' | 'badImage' | 'invalid' };

const FAIL = (reason: 'tooLarge' | 'badImage' | 'invalid'): PasteStep => ({ kind: 'fail', reason });

/** 一个端口同一时刻只有一次上传；新的 begin 会丢掉没收完的旧上传 */
export function createPasteAssembler() {
  let cur:
    | { id: string; mime: PasteMime; size: number; chunks: number; next: number; buf: Uint8Array }
    | undefined;

  return {
    begin(m: PasteBeginMsg): PasteStep {
      cur = undefined;
      if (m.size > MAX_PASTE_BYTES) return FAIL('tooLarge');
      if (m.chunks !== pasteChunkCount(m.size)) return FAIL('invalid');
      cur = {
        id: m.uploadId,
        mime: m.mime,
        size: m.size,
        chunks: m.chunks,
        next: 0,
        buf: new Uint8Array(m.size),
      };
      return { kind: 'more' };
    },

    chunk(m: PasteChunkMsg): PasteStep {
      const c = cur;
      if (!c || c.id !== m.uploadId || m.index !== c.next) {
        cur = undefined;
        return FAIL('invalid');
      }
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(m.data);
      } catch {
        cur = undefined;
        return FAIL('invalid');
      }
      const last = m.index === c.chunks - 1;
      const expected = last ? c.size - m.index * PASTE_CHUNK_BYTES : PASTE_CHUNK_BYTES;
      if (bytes.length !== expected) {
        cur = undefined;
        return FAIL('invalid');
      }
      c.buf.set(bytes, m.index * PASTE_CHUNK_BYTES);
      c.next += 1;
      if (!last) return { kind: 'more' };
      cur = undefined;
      return sniffImage(c.buf) === c.mime ? { kind: 'done', bytes: c.buf, mime: c.mime } : FAIL('badImage');
    },

    abort(): void {
      cur = undefined;
    },
  };
}
