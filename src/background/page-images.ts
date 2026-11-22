// 页面图片（E2、ARCHITECTURE 5.14「页面图片（可选）」，contract-v1.5 增量）：设置开着、且这次请求带了选区所在块时，
// 经阅读器的 page/images 指令要这些块里已经加载出来的图片地址（只收页面自己已经渲染出的图，见 page/page-read.ts），
// 后台直接 fetch 图片字节（不带凭据、不带任何自定义请求头、手动处理重定向），按与框选截图相同的上限缩放编码
// （capture-image.ts 的 encodeImage），作为本轮用户消息的图片部分。
//
// 重定向：fetch 用 redirect:'manual'，拿到的是 opaqueredirect，分不出重定向目标是不是同一主机——
// 比 ARCHITECTURE 5.14 写的「跨主机重定向拦截」更严（同主机的重定向也一并跳过）。两者取舍见 HANDOFF 的建议决策。
//
// 失败（跨主机重定向、非图片、超限、解码失败）只跳过这一张、写一句 note，不影响这次请求的其余部分与其他图片。
import { MAX_PAGE_IMAGES, parsePageImagesReply } from '@/core/domain/messages';
import type { BackgroundDeps } from './deps';

export interface FetchedPageImage {
  url: string;
  dataUrl: string;
  mime: string;
  width: number;
  height: number;
}

export interface PageImagesResult {
  images: readonly FetchedPageImage[];
  /** 跳过的图片或没能取到的原因，原样写进计划 notes（规则 8：地址在发送说明里可见，不是在这里） */
  notes: readonly string[];
}

/** 单张图片超过这么大就跳过（5.14「超过大小上限」） */
const MAX_BYTES = 5 * 1024 * 1024;

async function fetchOne(
  deps: BackgroundDeps,
  url: string,
): Promise<{ img?: FetchedPageImage; note?: string }> {
  let res: Response;
  try {
    res = await deps.fetch(url, { credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer' });
  } catch {
    return { note: `页面图片没能取到，已跳过：${url}` };
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400))
    return { note: `页面图片发生了重定向，已跳过：${url}` };
  if (!res.ok) return { note: `页面图片取不到（状态 ${res.status}），已跳过：${url}` };
  if (!/^image\//i.test(res.headers.get('content-type') ?? ''))
    return { note: `地址不是图片，已跳过：${url}` };
  const len = res.headers.get('content-length');
  if (len !== null && Number(len) > MAX_BYTES) return { note: `页面图片超过大小上限，已跳过：${url}` };
  const buf = await res.arrayBuffer().catch(() => undefined);
  if (!buf) return { note: `页面图片读取失败，已跳过：${url}` };
  if (buf.byteLength > MAX_BYTES) return { note: `页面图片超过大小上限，已跳过：${url}` };
  if (!deps.captureImages) return { note: `页面图片没能处理，已跳过：${url}` };
  try {
    const encoded = await deps.captureImages.encodeImage(new Blob([buf]));
    return { img: { url, ...encoded } };
  } catch {
    return { note: `页面图片无法读取（格式不支持或已损坏），已跳过：${url}` };
  }
}

export type PageImages = ReturnType<typeof createPageImages>;

export function createPageImages(deps: BackgroundDeps) {
  return {
    /**
     * 取选区所在块里已加载的图片（最多 MAX_PAGE_IMAGES 张）并逐张 fetch、编码。阅读器没有应答、
     * 请求号或内容版本对不上（页面在这之间变了）时视为没有图，不算错误
     */
    async collect(
      tabId: number,
      documentId: string,
      blockIds: readonly string[],
      contentVersion: string,
    ): Promise<PageImagesResult> {
      if (blockIds.length === 0 || !deps.requestFrame) return { images: [], notes: [] };
      const requestId = deps.newId();
      const raw = await deps
        .requestFrame(tabId, 0, documentId, {
          type: 'page/images',
          requestId,
          blockIds: blockIds.slice(0, 200),
          contentVersion,
        })
        .catch(() => undefined);
      const parsed = parsePageImagesReply(raw);
      if (
        !parsed.ok ||
        parsed.value.requestId !== requestId ||
        parsed.value.contentVersion !== contentVersion
      )
        return { images: [], notes: [] };
      const images: FetchedPageImage[] = [];
      const notes: string[] = [];
      for (const url of parsed.value.urls.slice(0, MAX_PAGE_IMAGES)) {
        const r = await fetchOne(deps, url);
        if (r.img) images.push(r.img);
        if (r.note) notes.push(r.note);
      }
      return { images, notes };
    },
  };
}
