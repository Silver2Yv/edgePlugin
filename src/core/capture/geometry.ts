// 框选截图的坐标换算（5.13）。纯逻辑：阅读器报的是视口坐标（CSS 像素），captureVisibleTab 给的是设备像素的整张可见区域。
// 换算按「实际图片尺寸 ÷ 视口尺寸」现算，不假定 devicePixelRatio（页面缩放、系统缩放、高 DPI 都由这个比例吸收）。
// 横纵比例对不上（视口在截图前后变了，如侧边栏开合导致重排）时不裁，调用方丢弃并请用户重选，绝不发错图。

/** 视口坐标里的矩形（CSS 像素） */
export interface CssRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** 图片上的裁剪区域（像素，整数） */
export interface PixelCrop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** 框选太小（任一边不到这么多 CSS 像素）按没选处理 */
export const MIN_SELECTION_CSS = 4;
/** 横纵比例允许的相对误差：取整与滚动条带来的误差远小于它，视口真的变了远大于它 */
export const SCALE_TOLERANCE = 0.02;
/** 发给模型的图片最长边（像素）：常见视觉模型在这个尺寸以内不再额外缩放 */
export const MAX_IMAGE_SIDE = 2048;
/** 预览缩略图最长边（像素） */
export const THUMB_MAX_SIDE = 480;

/** 拖动的起点与终点 → 规范化的矩形（任意方向拖都行） */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): CssRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** 夹进视口；完全在视口外或夹完太小返回 undefined */
export function clampToViewport(rect: CssRect, viewport: Size): CssRect | undefined {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(viewport.w, rect.x + rect.w);
  const y1 = Math.min(viewport.h, rect.y + rect.h);
  if (x1 - x0 < MIN_SELECTION_CSS || y1 - y0 < MIN_SELECTION_CSS) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 视口矩形 → 图片上的裁剪区域。比例 = 图片尺寸 ÷ 视口尺寸，横纵分别算；两者相差超过 SCALE_TOLERANCE
 * 说明这张图不是按这个视口截的（视口变了），返回 undefined。边界向外取整（不丢边上的像素），再夹进图片
 */
export function cropPixels(rect: CssRect, viewport: Size, image: Size): PixelCrop | undefined {
  if (viewport.w <= 0 || viewport.h <= 0 || image.w <= 0 || image.h <= 0) return undefined;
  const sx = image.w / viewport.w;
  const sy = image.h / viewport.h;
  if (Math.abs(sx - sy) / Math.max(sx, sy) > SCALE_TOLERANCE) return undefined;
  const r = clampToViewport(rect, viewport);
  if (!r) return undefined;
  const left = Math.max(0, Math.floor(r.x * sx));
  const top = Math.max(0, Math.floor(r.y * sy));
  const right = Math.min(image.w, Math.ceil((r.x + r.w) * sx));
  const bottom = Math.min(image.h, Math.ceil((r.y + r.h) * sy));
  if (right <= left || bottom <= top) return undefined;
  return { sx: left, sy: top, sw: right - left, sh: bottom - top };
}

/** 等比缩到最长边不超过 maxSide（不放大），至少 1 像素 */
export function fitWithin(size: Size, maxSide: number): Size {
  const longest = Math.max(size.w, size.h);
  if (longest <= maxSide) return { w: size.w, h: size.h };
  const k = maxSide / longest;
  return { w: Math.max(1, Math.round(size.w * k)), h: Math.max(1, Math.round(size.h * k)) };
}

/** 两次视口报告是同一个视口（尺寸相同，允许半个像素的取整差） */
export function sameViewport(a: Size, b: Size): boolean {
  return Math.abs(a.w - b.w) <= 0.5 && Math.abs(a.h - b.h) <= 0.5;
}
