// 框选截图的界面部件（E1–E4、5.13，capture 块）：输入区的「截图」按钮与待确认截图的预览、
// 对话里用户消息附带的截图、回答下方的轻提示。小窗与侧边栏共用。
// 图片一律画在 <canvas> 上：扩展页面的 CSP 是 img-src 'self'（5.10，回答渲染不加载外部图片），
// data: 图片放不进 <img>；不为截图放宽 CSP。缩略图来自后台（JPEG data URL），原图不进界面。
import { useEffect, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { base64ToBytes, parseDataUrl } from '@/core/capture/data-url';
import type { ModelErrorKind, Tri } from '@/core/llm/adapter';
import { effectiveCapabilities } from '@/core/llm/capabilities';
import { loadSettings, SETTINGS_KEY } from '@/platform/settings-store';
import type { AnswerLike, UserImageView } from '../float/messages';
import type { CaptureView } from '../float/state';
import { T } from '../strings';
import { IconClose } from './Icons';
import { useImageThumb } from './image-thumbs';

/** 把 data URL 画到画布上（画布按图片原尺寸，显示尺寸由样式限制） */
function ThumbCanvas({ dataUrl, label, testId }: { dataUrl: string; label: string; testId: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let alive = true;
    const p = parseDataUrl(dataUrl);
    if (!p) return;
    void createImageBitmap(new Blob([base64ToBytes(p.base64) as BlobPart], { type: p.mime }))
      .then((bmp) => {
        const c = ref.current;
        if (alive && c) {
          c.width = bmp.width;
          c.height = bmp.height;
          c.getContext('2d')?.drawImage(bmp, 0, 0);
          c.dataset.ready = 'true';
        }
        bmp.close();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [dataUrl]);
  return <canvas ref={ref} role="img" aria-label={label} className="ra-thumb" data-testid={testId} />;
}

/** 当前默认模型能不能看图（能力表，E3）；还没读到设置或没有连接时为 null */
function useDefaultVision(): Tri | null {
  const [vision, setVision] = useState<Tri | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void loadSettings().then((r) => {
        if (!alive) return;
        const m = r.ok ? r.settings.defaultModel : undefined;
        const conn = r.ok && m ? r.settings.connections.find((c) => c.id === m.connectionId) : undefined;
        setVision(conn && m ? effectiveCapabilities(conn, m.model).vision : null);
      });
    load();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && SETTINGS_KEY in changes) load();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return vision;
}

const IconCapture = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" />
    <path d="M6 8h4M8 6v4" />
  </svg>
);

/** 输入区的「截图」按钮：后台在网页上显示遮罩，框好后预览回到这里 */
export function CaptureButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      className="ra-icon-btn"
      aria-label={T.capture.button}
      title={T.capture.buttonTitle}
      data-testid="capture-button"
      disabled={disabled}
      onClick={onClick}
    >
      <IconCapture />
    </button>
  );
}

/** 待确认的截图：像引用条一样一张缩略图，可以 × 去掉；提示自己确认图里没有敏感内容（5.13）。发问即确认（AR-16） */
export function CapturePreview({
  capture,
  onDismiss,
}: {
  capture: CaptureView;
  onDismiss: (() => void) | undefined;
}) {
  const vision = useDefaultVision();
  return (
    <div className="ra-capture" data-testid="capture-preview">
      <ThumbCanvas dataUrl={capture.thumb} label={T.capture.previewLabel} testId="capture-thumb" />
      <div className="ra-capture__body">
        <div className="ra-capture__label">
          {T.capture.previewLabel} · {T.capture.size(capture.width, capture.height)}
        </div>
        <p className="ra-capture__note">{T.capture.sensitive}</p>
        {vision === 'no' && (
          <p className="ra-capture__note ra-capture__note--warn" data-testid="capture-no-vision">
            {T.capture.noVision}
          </p>
        )}
      </div>
      <button
        type="button"
        className="ra-icon-btn"
        aria-label={T.capture.dismiss}
        title={T.capture.dismissTitle}
        onClick={onDismiss}
      >
        <IconClose />
      </button>
    </div>
  );
}

function MessageImage({ img }: { img: UserImageView }) {
  const fetched = useImageThumb(img.thumb === undefined ? img.messageId : undefined, img.index);
  const thumb = img.thumb ?? fetched;
  if (thumb === undefined)
    return (
      <span className="ra-thumb ra-thumb--empty" data-testid="message-image">
        {T.capture.imageUnavailable}
      </span>
    );
  return <ThumbCanvas dataUrl={thumb} label={T.capture.imageLabel} testId="message-image" />;
}

/** 用户消息里附带的截图（历史回看也有：缩略图向后台取） */
export function MessageImages({ images }: { images: readonly UserImageView[] | undefined }) {
  if (!images?.length) return null;
  return (
    <div className="ra-msg-images">
      {images.map((img) => (
        <MessageImage key={`${img.messageId ?? 'local'}-${img.index}`} img={img} />
      ))}
    </div>
  );
}

/** 这些失败可能是模型不支持看图（E3：能力表「未知」的模型照发，失败时提示）；网络、鉴权、超时类不提示 */
const MAYBE_NO_VISION: ReadonlySet<ModelErrorKind> = new Set<ModelErrorKind>([
  'paramRejected',
  'badResponse',
  'server',
  'notFound',
  'noContent',
]);

/** 回答下方的轻提示：附了图的回答答完时提醒核对原图（E4）；失败时提示可能是模型不支持看图（E3） */
export function ImageAnswerNote({ view }: { view: AnswerLike }) {
  if (!view.plan?.imageCount) return null;
  if (view.state === 'completed')
    return (
      <p className="ra-status" data-testid="image-note">
        {T.capture.accuracy}
      </p>
    );
  if (view.state === 'failed' && view.error && MAYBE_NO_VISION.has(view.error.kind))
    return (
      <p className="ra-status" data-testid="image-note">
        {T.capture.maybeNoVision}
      </p>
    );
  return null;
}
