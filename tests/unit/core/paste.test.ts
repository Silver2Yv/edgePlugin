// 外部图片粘贴的协议与拼装（决策 099，contract-v1.6 增量）：分片拼装的校验、消息体大小、授权表。
import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '@/core/capture/data-url';
import {
  createPasteAssembler,
  MAX_PASTE_BYTES,
  MAX_PASTE_CHUNKS,
  PASTE_CHUNK_BYTES,
  pasteChunkCount,
  sniffImage,
} from '@/core/capture/paste';
import { clientToBackground, messageBytes, parseFrom } from '@/core/domain/messages';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 以 PNG 文件头开头的字节串 */
function png(size: number): Uint8Array {
  const b = new Uint8Array(size);
  b.set(PNG_HEAD.slice(0, Math.min(size, PNG_HEAD.length)));
  for (let i = PNG_HEAD.length; i < size; i++) b[i] = i % 251;
  return b;
}

const UP = 'up-00000001';

function chunksOf(bytes: Uint8Array) {
  return Array.from({ length: pasteChunkCount(bytes.length) }, (_, i) => ({
    uploadId: UP,
    index: i,
    data: bytesToBase64(bytes.subarray(i * PASTE_CHUNK_BYTES, (i + 1) * PASTE_CHUNK_BYTES)),
  }));
}

const begin = (size: number, extra: Record<string, unknown> = {}) => ({
  uploadId: UP,
  mime: 'image/png' as const,
  size,
  chunks: pasteChunkCount(size),
  ...extra,
});

describe('sniffImage', () => {
  it('按文件头认类型', () => {
    expect(sniffImage(png(16))).toBe('image/png');
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
    expect(sniffImage(Uint8Array.from([0x42, 0x4d, 0, 0]))).toBe('image/bmp');
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImage(webp)).toBe('image/webp');
    expect(sniffImage(new TextEncoder().encode('<svg></svg>'))).toBeUndefined();
    expect(sniffImage(new Uint8Array(0))).toBeUndefined();
  });
});

describe('分片拼装', () => {
  it('多片：按序收齐，字节逐位一致', () => {
    const bytes = png(PASTE_CHUNK_BYTES * 2 + 123);
    const a = createPasteAssembler();
    expect(a.begin(begin(bytes.length))).toEqual({ kind: 'more' });
    const cs = chunksOf(bytes);
    expect(cs).toHaveLength(3);
    expect(a.chunk(cs[0] as never)).toEqual({ kind: 'more' });
    expect(a.chunk(cs[1] as never)).toEqual({ kind: 'more' });
    const done = a.chunk(cs[2] as never);
    expect(done.kind).toBe('done');
    if (done.kind === 'done') {
      expect(done.mime).toBe('image/png');
      expect(Array.from(done.bytes)).toEqual(Array.from(bytes));
    }
  });

  it('刚好整片、很小的图都行', () => {
    for (const n of [PASTE_CHUNK_BYTES, 9]) {
      const a = createPasteAssembler();
      a.begin(begin(n));
      const steps = chunksOf(png(n)).map((c) => a.chunk(c));
      expect(steps.at(-1)?.kind).toBe('done');
    }
  });

  it('超过上限：begin 就回 tooLarge；上限本身可以', () => {
    const a = createPasteAssembler();
    expect(a.begin(begin(MAX_PASTE_BYTES + 1))).toEqual({ kind: 'fail', reason: 'tooLarge' });
    expect(a.begin(begin(MAX_PASTE_BYTES)).kind).toBe('more');
    expect(pasteChunkCount(MAX_PASTE_BYTES)).toBe(MAX_PASTE_CHUNKS);
  });

  it('声明的片数对不上大小：invalid', () => {
    const a = createPasteAssembler();
    expect(a.begin(begin(100, { chunks: 2 }))).toEqual({ kind: 'fail', reason: 'invalid' });
  });

  it('顺序不对、跳片、重复片、没 begin、uploadId 不同：invalid，且整次丢弃', () => {
    const bytes = png(PASTE_CHUNK_BYTES * 2);
    const cs = chunksOf(bytes);
    const a = createPasteAssembler();
    expect(a.chunk(cs[0] as never)).toEqual({ kind: 'fail', reason: 'invalid' });
    a.begin(begin(bytes.length));
    expect(a.chunk(cs[1] as never)).toEqual({ kind: 'fail', reason: 'invalid' });
    // 已丢弃：再发第 0 片也不行
    expect(a.chunk(cs[0] as never)).toEqual({ kind: 'fail', reason: 'invalid' });
    a.begin(begin(bytes.length));
    a.chunk(cs[0] as never);
    expect(a.chunk(cs[0] as never)).toEqual({ kind: 'fail', reason: 'invalid' });
    a.begin(begin(bytes.length));
    expect(a.chunk({ ...(cs[0] as object), uploadId: 'up-other001' } as never)).toEqual({
      kind: 'fail',
      reason: 'invalid',
    });
  });

  it('某一片的长度与声明对不上（偏长、偏短、末片多发）：invalid', () => {
    const bytes = png(PASTE_CHUNK_BYTES + 10);
    const cs = chunksOf(bytes);
    const a = createPasteAssembler();
    a.begin(begin(bytes.length));
    const short = { ...(cs[0] as object), data: bytesToBase64(bytes.subarray(0, 100)) };
    expect(a.chunk(short as never)).toEqual({ kind: 'fail', reason: 'invalid' });
    a.begin(begin(bytes.length));
    a.chunk(cs[0] as never);
    const long = { ...(cs[1] as object), data: bytesToBase64(bytes.subarray(0, 50)) };
    expect(a.chunk(long as never)).toEqual({ kind: 'fail', reason: 'invalid' });
  });

  it('base64 不合法：invalid（不抛）', () => {
    const a = createPasteAssembler();
    a.begin(begin(10));
    expect(a.chunk({ uploadId: UP, index: 0, data: 'a' }).kind).toBe('fail');
  });

  it('文件头不是声明的类型（把别的东西说成 PNG）：badImage', () => {
    const bytes = new TextEncoder().encode('<html>not an image</html>');
    const a = createPasteAssembler();
    a.begin(begin(bytes.length));
    expect(a.chunk(chunksOf(bytes)[0] as never)).toEqual({ kind: 'fail', reason: 'badImage' });
    // 声明 JPEG、实际是 PNG 也不行
    a.begin(begin(16, { mime: 'image/jpeg' }));
    expect(a.chunk(chunksOf(png(16))[0] as never)).toEqual({ kind: 'fail', reason: 'badImage' });
  });

  it('新的 begin 丢掉没收完的旧上传', () => {
    const a = createPasteAssembler();
    const old = png(PASTE_CHUNK_BYTES * 2);
    a.begin(begin(old.length));
    a.chunk(chunksOf(old)[0] as never);
    const fresh = png(20);
    a.begin(begin(fresh.length));
    expect(a.chunk(chunksOf(old)[1] as never).kind).toBe('fail');
  });
});

describe('协议（contract-v1.6）', () => {
  const parse = (role: 'float' | 'sidepanel' | 'content' | 'options', raw: unknown) =>
    parseFrom(role, clientToBackground, raw);

  it('小窗与侧边栏可以发，网页内容脚本、设置页不行', () => {
    const msg = { type: 'paste/begin', uploadId: UP, mime: 'image/png', size: 10, chunks: 1 };
    expect(parse('float', msg).ok).toBe(true);
    expect(parse('sidepanel', msg).ok).toBe(true);
    expect(parse('content', msg)).toMatchObject({ ok: false, reason: 'notAllowed' });
    expect(parse('options', msg)).toMatchObject({ ok: false, reason: 'notAllowed' });
  });

  it('paste/begin：类型限白名单，未知字段、非法数字被拒；超大 size 不在这里拒（后台回 tooLarge）', () => {
    const ok = { type: 'paste/begin', uploadId: UP, mime: 'image/png', size: 10, chunks: 1 };
    expect(parse('float', { ...ok, mime: 'image/svg+xml' }).ok).toBe(false);
    expect(parse('float', { ...ok, size: 0 }).ok).toBe(false);
    expect(parse('float', { ...ok, size: 1.5 }).ok).toBe(false);
    expect(parse('float', { ...ok, extra: 1 }).ok).toBe(false);
    expect(parse('float', { ...ok, size: MAX_PASTE_BYTES * 2, chunks: MAX_PASTE_CHUNKS * 2 }).ok).toBe(true);
  });

  it('paste/chunk：每片填满上限，整条消息仍小于 64 KB；不是 base64 的被拒', () => {
    const full = bytesToBase64(new Uint8Array(PASTE_CHUNK_BYTES).fill(255));
    const msg = { type: 'paste/chunk', uploadId: UP, index: MAX_PASTE_CHUNKS - 1, data: full };
    expect(messageBytes(msg)).toBeLessThan(64 * 1024);
    expect(parse('float', msg).ok).toBe(true);
    expect(parse('float', { ...msg, data: `${full}AAAA` }).ok).toBe(false);
    expect(parse('float', { ...msg, data: '<script>' }).ok).toBe(false);
    expect(parse('float', { ...msg, index: -1 }).ok).toBe(false);
  });
});
