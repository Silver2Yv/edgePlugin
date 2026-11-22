// 截图的图片处理（5.13）：在后台（Service Worker）里用 createImageBitmap + OffscreenCanvas 裁剪、缩放、编码。
// 坐标换算是纯逻辑（core/capture/geometry.ts）；这里只做像素活，不碰扩展 API。单测不跑这里（Node 没有 OffscreenCanvas），
// 由端到端用例覆盖；后台单测换成假的（BackgroundDeps.captureImages）。
import { base64ToBytes, bytesToBase64, parseDataUrl } from '@/core/capture/data-url';
import {
  type CssRect,
  cropPixels,
  fitWithin,
  MAX_IMAGE_SIDE,
  type Size,
  THUMB_MAX_SIDE,
} from '@/core/capture/geometry';
import { CAPTURE_THUMB_MAX_CHARS } from '@/core/domain/messages';

export interface ProcessedCapture {
  /** 发给模型的图：data URL */
  dataUrl: string;
  mime: string;
  width: number;
  height: number;
  /** 预览缩略图：JPEG data URL，不超过 CAPTURE_THUMB_MAX_CHARS */
  thumb: string;
}

export interface CaptureImages {
  /**
   * 整张可见区域截图（captureVisibleTab 的 data URL）→ 按视口矩形裁剪、缩到最长边 MAX_IMAGE_SIDE、编码。
   * 图片尺寸与视口的横纵比例对不上（截的不是这个视口）返回 'mismatch'
   */
  process(shot: string, rect: CssRect, viewport: Size): Promise<ProcessedCapture | 'mismatch'>;
  /** 库里的图 → 缩略图（历史回看） */
  thumbnail(image: Blob): Promise<string>;
}

/** PNG 超过这么大就改用 JPEG：文字截图 PNG 更清楚，但大图会让请求体过大（中转站常见 10–20 MB 上限） */
const PNG_MAX_BYTES = 3 * 1024 * 1024;

const blobOfDataUrl = (url: string): Blob => {
  const p = parseDataUrl(url);
  if (!p) throw new Error('截图不是 base64 data URL');
  return new Blob([base64ToBytes(p.base64) as BlobPart], { type: p.mime });
};

const dataUrlOf = async (b: Blob): Promise<string> =>
  `data:${b.type};base64,${bytesToBase64(new Uint8Array(await b.arrayBuffer()))}`;

function draw(
  src: ImageBitmap,
  crop: { sx: number; sy: number; sw: number; sh: number },
  out: Size,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(out.w, out.h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, out.w, out.h);
  return canvas;
}

/** 缩略图：最长边 THUMB_MAX_SIDE 的 JPEG，超过上限就降质量、再缩小，直到放得下 */
async function thumbOf(src: ImageBitmap, crop: { sx: number; sy: number; sw: number; sh: number }) {
  let size = fitWithin({ w: crop.sw, h: crop.sh }, THUMB_MAX_SIDE);
  for (let i = 0; i < 8; i++) {
    const canvas = draw(src, crop, size);
    for (const quality of [0.8, 0.6, 0.45]) {
      const url = await dataUrlOf(await canvas.convertToBlob({ type: 'image/jpeg', quality }));
      if (url.length <= CAPTURE_THUMB_MAX_CHARS) return url;
    }
    size = { w: Math.max(1, Math.round(size.w * 0.7)), h: Math.max(1, Math.round(size.h * 0.7)) };
  }
  throw new Error('缩略图放不下');
}

export const offscreenCaptureImages: CaptureImages = {
  async process(shot, rect, viewport) {
    const bitmap = await createImageBitmap(blobOfDataUrl(shot));
    try {
      const crop = cropPixels(rect, viewport, { w: bitmap.width, h: bitmap.height });
      if (!crop) return 'mismatch';
      const size = fitWithin({ w: crop.sw, h: crop.sh }, MAX_IMAGE_SIDE);
      const canvas = draw(bitmap, crop, size);
      let blob = await canvas.convertToBlob({ type: 'image/png' });
      if (blob.size > PNG_MAX_BYTES) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      return {
        dataUrl: await dataUrlOf(blob),
        mime: blob.type,
        width: size.w,
        height: size.h,
        thumb: await thumbOf(bitmap, crop),
      };
    } finally {
      bitmap.close();
    }
  },

  async thumbnail(image) {
    const bitmap = await createImageBitmap(image);
    try {
      return await thumbOf(bitmap, { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height });
    } finally {
      bitmap.close();
    }
  },
};
