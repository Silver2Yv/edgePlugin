// 框选截图的遮罩（5.13、E1）：阅读器在顶层框架里显示，用户拖出矩形后把视口坐标交给后台，后台截图、裁剪。
// 遮罩只放固定文案，不放任何对话内容与图片（规则 4）；只响应 isTrusted 的指针与按键（规则 12）。
//
// 视口修订号：开始框选后监听滚动（含页面里各元素的滚动）、窗口尺寸变化（浏览器缩放、侧边栏开合导致的重排）、
// 双指缩放、窗口失焦与页面隐藏（切窗、切页），任何一个发生就加一。capture/rect 报的是按下鼠标那一刻的修订号，
// 后台在隐藏遮罩后、截图后各要一次当前值（capture/hideOverlay、capture/end 的应答），对不上就丢弃。
// 拖动期间滚轮被拦下（遮罩盖着整页，滚轮本会滚动网页），免得一不小心就把这次框选作废。

import { type CssRect, MIN_SELECTION_CSS, rectFromPoints, type Size } from '@/core/capture/geometry';
import type { CaptureFrameReply, ContentToBackground } from '@/core/domain/messages';

export interface CaptureOverlay {
  /** 正在框选（遮罩在、或等后台截图中）：阅读器据此不把这期间的点击与 Esc 当作「收起小窗」 */
  active(): boolean;
  start(captureId: string): void;
  /** 隐藏遮罩与小窗，等两帧，报当前修订号 */
  hide(captureId: string): Promise<CaptureFrameReply>;
  /** 结束：移除遮罩、恢复小窗，报当前修订号 */
  end(captureId: string): CaptureFrameReply;
}

export interface CaptureOverlayDeps {
  send(msg: ContentToBackground): void;
  /** 小窗：截图期间藏起来（只改可见性） */
  setFloatHidden(on: boolean): void;
}

/** 后台迟迟不来 hideOverlay / end（后台被回收等）：等这么久就自己撤掉遮罩、恢复小窗 */
const WAIT_BACKEND_MS = 15_000;

const HINT = '拖动鼠标框选要提问的区域（图里不要有敏感信息） · Esc 或右键取消';

/**
 * 当前视口：框选坐标与截图都以它为准。没有双指缩放时就是整个窗口（innerWidth / innerHeight，含滚动条，与截图一致）；
 * 双指缩放时截到的是可见视口，坐标要减去它的偏移
 */
function viewportNow(): { offset: { x: number; y: number }; size: Size } {
  const vv = window.visualViewport;
  if (vv && Math.abs(vv.scale - 1) > 0.01)
    return { offset: { x: vv.offsetLeft, y: vv.offsetTop }, size: { w: vv.width, h: vv.height } };
  return { offset: { x: 0, y: 0 }, size: { w: window.innerWidth, h: window.innerHeight } };
}

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    // 页面在后台时 rAF 不走：兜底定时器（那时修订号也已因页面隐藏而变，后台会丢弃）
    const timer = setTimeout(resolve, 200);
    const step = (left: number) =>
      requestAnimationFrame(() => {
        if (left <= 1) {
          clearTimeout(timer);
          resolve();
        } else step(left - 1);
      });
    step(n);
  });
}

export function createCaptureOverlay(deps: CaptureOverlayDeps): CaptureOverlay {
  let revision = 0;
  let current:
    | {
        id: string;
        phase: 'selecting' | 'waiting';
        host: HTMLElement;
        unlisten: () => void;
        timer: ReturnType<typeof setTimeout> | undefined;
      }
    | undefined;

  const bump = () => {
    revision++;
  };

  function reply(captureId: string): CaptureFrameReply {
    return { captureId, viewportRevision: revision, viewport: viewportNow().size };
  }

  function teardown(): void {
    if (!current) return;
    const c = current;
    current = undefined;
    if (c.timer !== undefined) clearTimeout(c.timer);
    c.unlisten();
    c.host.remove();
    deps.setFloatHidden(false);
  }

  function cancel(): void {
    if (!current) return;
    const id = current.id;
    teardown();
    deps.send({ type: 'capture/cancel', captureId: id });
  }

  function build(captureId: string): void {
    const host = document.createElement('div');
    host.popover = 'manual';
    host.dataset.raCaptureOverlay = 'true';
    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      maxWidth: 'none',
      maxHeight: 'none',
      margin: '0',
      padding: '0',
      border: 'none',
      background: 'transparent',
      overflow: 'hidden',
      cursor: 'crosshair',
      zIndex: '2147483647',
      userSelect: 'none',
      touchAction: 'none',
    });
    const shadow = host.attachShadow({ mode: 'closed' });
    const dim = document.createElement('div');
    Object.assign(dim.style, { position: 'absolute', inset: '0', background: 'rgba(15, 23, 42, 0.28)' });
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      display: 'none',
      boxSizing: 'border-box',
      border: '1px solid #fff',
      outline: '1px dashed rgba(15, 23, 42, 0.7)',
      boxShadow: '0 0 0 100000px rgba(15, 23, 42, 0.28)',
      pointerEvents: 'none',
    });
    const hint = document.createElement('div');
    hint.setAttribute('role', 'status');
    Object.assign(hint.style, {
      position: 'absolute',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '6px 8px 6px 14px',
      borderRadius: '6px',
      background: '#1f1f1f',
      color: '#fff',
      font: '13px/20px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
      cursor: 'default',
      whiteSpace: 'nowrap',
    });
    const label = document.createElement('span');
    label.textContent = HINT;
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '取消';
    Object.assign(cancelBtn.style, {
      font: 'inherit',
      color: '#fff',
      background: 'rgba(255, 255, 255, 0.16)',
      border: '1px solid rgba(255, 255, 255, 0.35)',
      borderRadius: '4px',
      padding: '0 10px',
      cursor: 'pointer',
    });
    cancelBtn.addEventListener('click', (e) => {
      if (e.isTrusted) cancel();
    });
    hint.append(label, cancelBtn);
    shadow.append(dim, box, hint);

    let origin: { x: number; y: number; revision: number; pointerId: number } | undefined;
    const point = (e: PointerEvent) => {
      const v = viewportNow();
      return { x: e.clientX - v.offset.x, y: e.clientY - v.offset.y };
    };
    const show = (r: CssRect) => {
      const v = viewportNow();
      Object.assign(box.style, {
        display: 'block',
        left: `${r.x + v.offset.x}px`,
        top: `${r.y + v.offset.y}px`,
        width: `${r.w}px`,
        height: `${r.h}px`,
      });
      dim.style.display = 'none';
    };
    host.addEventListener('pointerdown', (e) => {
      if (!e.isTrusted || e.button !== 0 || current?.phase !== 'selecting') return;
      if (e.composedPath().includes(hint)) return;
      e.preventDefault();
      host.setPointerCapture(e.pointerId);
      origin = { ...point(e), revision, pointerId: e.pointerId };
    });
    host.addEventListener('pointermove', (e) => {
      if (!e.isTrusted || !origin || e.pointerId !== origin.pointerId) return;
      show(rectFromPoints(origin, point(e)));
    });
    host.addEventListener('pointerup', (e) => {
      if (!e.isTrusted || !origin || e.pointerId !== origin.pointerId || !current) return;
      const start = origin;
      origin = undefined;
      const rect = rectFromPoints(start, point(e));
      if (rect.w < MIN_SELECTION_CSS || rect.h < MIN_SELECTION_CSS) {
        // 只是点了一下：不算框选，接着等
        box.style.display = 'none';
        dim.style.display = 'block';
        return;
      }
      current.phase = 'waiting';
      hint.style.display = 'none';
      current.timer = setTimeout(teardown, WAIT_BACKEND_MS);
      // 报按下鼠标那一刻的修订号：拖动期间视口变了，后台核对时就对不上
      deps.send({
        type: 'capture/rect',
        captureId,
        viewportRevision: start.revision,
        rect,
        viewport: viewportNow().size,
      });
    });
    host.addEventListener('contextmenu', (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      cancel();
    });
    host.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

    // 视口变化监听（见文件头）；Esc 取消
    const onKey = (e: KeyboardEvent) => {
      if (!e.isTrusted || e.key !== 'Escape' || current?.phase !== 'selecting') return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    const vv = window.visualViewport;
    document.addEventListener('scroll', bump, { capture: true, passive: true });
    window.addEventListener('resize', bump, { passive: true });
    window.addEventListener('blur', bump);
    document.addEventListener('visibilitychange', bump);
    vv?.addEventListener('resize', bump);
    vv?.addEventListener('scroll', bump);
    window.addEventListener('keydown', onKey, { capture: true });
    const unlisten = () => {
      document.removeEventListener('scroll', bump, { capture: true });
      window.removeEventListener('resize', bump);
      window.removeEventListener('blur', bump);
      document.removeEventListener('visibilitychange', bump);
      vv?.removeEventListener('resize', bump);
      vv?.removeEventListener('scroll', bump);
      window.removeEventListener('keydown', onKey, { capture: true });
    };

    document.documentElement.append(host);
    host.showPopover();
    current = { id: captureId, phase: 'selecting', host, unlisten, timer: undefined };
  }

  return {
    active: () => current !== undefined,

    start(captureId) {
      // 同一页又来一次（再按一次快捷键）：换成新的这次
      teardown();
      deps.setFloatHidden(true);
      build(captureId);
    },

    async hide(captureId) {
      if (current?.id === captureId) {
        if (current.host.matches(':popover-open')) current.host.hidePopover();
        current.host.style.display = 'none';
        deps.setFloatHidden(true);
      }
      await nextFrames(2);
      return reply(captureId);
    },

    end(captureId) {
      const r = reply(captureId);
      if (current?.id === captureId) teardown();
      return r;
    },
  };
}
