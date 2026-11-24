// 输入框粘贴图片（决策 099，contract-v1.6 增量），小窗与侧边栏共用。
// 界面这边只做三件事：认出「粘贴的是图片」、把字节切片经对话端口交给后台、报告没发出去的原因。
// 缩放编码、预览缩略图、存成待确认的图都在后台（background/capture.ts），界面不保留原图：字节切完发出就丢，
// 预览只用后台推回来的缩略图（conv/capture）。

import { bytesToBase64 } from '@/core/capture/data-url';
import { isPasteMime, MAX_PASTE_BYTES, PASTE_CHUNK_BYTES, pasteChunkCount } from '@/core/capture/paste';
import type { ClientToBackground } from '@/core/domain/messages';
import { T } from '../strings';

/** paste 事件里用得到的那一小块剪贴板接口（单测用假对象） */
export interface PasteData {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>;
  files?: ArrayLike<File>;
  getData(format: string): string;
}

/**
 * 剪贴板里要接管的图片：只取第一张。有非空的纯文字时不接管——从表格、文档里复制常常同时带一张渲染出来的图，
 * 这时用户要的是文字；系统截图、截图软件复制出来的只有图片，从网页「复制图片」只带 text/html，都会被接管。
 * 没有图片返回 null（调用方什么都不做，文字粘贴照旧）
 */
export function pickPastedImage(data: PasteData | null | undefined): File | null {
  if (!data) return null;
  if (data.getData('text/plain').trim() !== '') return null;
  for (const it of Array.from(data.items ?? [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  for (const f of Array.from(data.files ?? [])) if (f.type.startsWith('image/')) return f;
  return null;
}

/** 一张图的全部消息：paste/begin，随后按序的 paste/chunk。bytes 不超过 MAX_PASTE_BYTES、mime 在白名单里（调用方保证） */
export function* pasteMessages(
  uploadId: string,
  mime: string,
  bytes: Uint8Array,
): Generator<ClientToBackground> {
  if (!isPasteMime(mime)) throw new RangeError('不支持的图片类型');
  const chunks = pasteChunkCount(bytes.length);
  yield { type: 'paste/begin', uploadId, mime, size: bytes.length, chunks };
  // 逐片生成：一张几 MB 的图不必先整个转成 base64 放在内存里
  for (let i = 0; i < chunks; i++)
    yield {
      type: 'paste/chunk',
      uploadId,
      index: i,
      data: bytesToBase64(bytes.subarray(i * PASTE_CHUNK_BYTES, (i + 1) * PASTE_CHUNK_BYTES)),
    };
}

export interface PasteDeps {
  /** 连接已就绪、能发 */
  ready: () => boolean;
  post: (msg: ClientToBackground) => void;
  /** 在输入区上方提示一行（没发出去的原因） */
  fail: (message: string) => void;
  /** 连接闲着时叫醒重连 */
  wake: () => void;
  newId?: () => string;
}

/**
 * 处理粘贴来的图片文件：先在本地拦下超限、不支持的类型与空文件（明确提示，不发任何消息），其余分片发给后台。
 * 后台还会按自己的规则再核对一遍（不信界面）
 */
export async function sendPastedImage(file: File, deps: PasteDeps): Promise<void> {
  if (!deps.ready()) {
    deps.fail(T.error.notReady);
    deps.wake();
    return;
  }
  if (file.size > MAX_PASTE_BYTES) return deps.fail(T.capture.failed.tooLarge);
  if (file.size === 0 || !isPasteMime(file.type)) return deps.fail(T.capture.failed.badImage);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return deps.fail(T.capture.failed.badImage);
  }
  try {
    for (const m of pasteMessages((deps.newId ?? (() => crypto.randomUUID()))(), file.type, bytes))
      deps.post(m);
  } catch {
    deps.fail(T.error.notReady);
  }
}
