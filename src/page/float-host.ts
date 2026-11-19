// 小窗宿主（ARCHITECTURE 5.3）：阅读器在顶层框架创建的隐藏 iframe，承载扩展页面 float.html。
// 每个标签页最多一个；收起只隐藏不销毁；不用 window.postMessage。
import { browser } from 'wxt/browser';
import { FLOAT_LIMITS } from '@/core/domain/float';
import { getLastSelectionRect } from './selection-bus';

const WIDTH = 380;
const HEIGHT = 480;
const MARGIN = 16;

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
interface Size {
  width: number;
  height: number;
}

/** 纯计算：贴着最近一次选区定位，放不下翻到上方并夹在视口内；没有选区就放右下角 */
export function computeFloatPosition(
  selectionRect: Rect | null,
  size: Size,
  viewport: Size,
): { left: number; top: number } {
  if (selectionRect === null) {
    return {
      left: Math.max(MARGIN, viewport.width - size.width - MARGIN),
      top: Math.max(MARGIN, viewport.height - size.height - MARGIN),
    };
  }
  const maxLeft = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  const left = Math.min(Math.max(selectionRect.left, MARGIN), maxLeft);
  let top = selectionRect.bottom + MARGIN;
  if (top + size.height > viewport.height) top = selectionRect.top - size.height - MARGIN;
  const maxTop = Math.max(MARGIN, viewport.height - size.height - MARGIN);
  top = Math.min(Math.max(top, MARGIN), maxTop);
  return { left, top };
}

export type FloatLoadResult = 'ready' | 'failedTransient';

export interface FloatHostApi {
  prewarm(token: string): void;
  show(opts: { token: string | undefined; focusInput: boolean }): void;
  hide(): void;
}

export function createFloatHost(onLoadResult: (result: FloatLoadResult) => void): FloatHostApi {
  let host: HTMLElement | null = null;
  let iframe: HTMLIFrameElement | null = null;
  let loaded = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  // 显示时小窗还没加载完：等加载完再聚焦。加载中的 iframe 拿到焦点后，换成扩展页面时焦点会丢回网页
  let focusOnLoad = false;

  function build(token: string): void {
    const h = document.createElement('div');
    h.popover = 'manual';
    Object.assign(h.style, {
      position: 'fixed',
      margin: '0',
      padding: '0',
      // 有边框和阴影，回答变长时也和网页正文分得开
      border: '1px solid #d0d0d0',
      borderRadius: '8px',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)',
      background: '#fff',
      boxSizing: 'border-box',
      inset: 'auto',
      overflow: 'hidden',
      zIndex: '2147483647',
      width: `${WIDTH}px`,
      height: `${HEIGHT}px`,
    });
    const shadow = h.attachShadow({ mode: 'closed' });
    const frame = document.createElement('iframe');
    frame.src = `${browser.runtime.getURL('/float.html')}#t=${token}`;
    frame.allow = 'clipboard-write';
    Object.assign(frame.style, { width: '100%', height: '100%', border: '0' });
    loaded = false;
    frame.addEventListener('load', () => {
      loaded = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (focusOnLoad && h.matches(':popover-open')) frame.focus();
      focusOnLoad = false;
      onLoadResult('ready');
    });
    shadow.append(frame);
    document.documentElement.append(h);
    host = h;
    iframe = frame;
    timeoutId = setTimeout(() => {
      if (!loaded) onLoadResult('failedTransient');
    }, FLOAT_LIMITS.loadTimeoutMs);
  }

  function reposition(): void {
    if (host === null) return;
    const sel = getLastSelectionRect();
    const rect = sel === null ? null : { left: sel.left, right: sel.right, top: sel.top, bottom: sel.bottom };
    const pos = computeFloatPosition(
      rect,
      { width: WIDTH, height: HEIGHT },
      { width: window.innerWidth, height: window.innerHeight },
    );
    host.style.left = `${pos.left}px`;
    host.style.top = `${pos.top}px`;
  }

  return {
    prewarm(token) {
      if (host !== null) return; // 每个标签页最多一个预热实例
      build(token);
    },
    show({ token, focusInput }) {
      if (host === null) {
        if (token === undefined) return; // 没令牌造不出小窗
        build(token);
      }
      reposition();
      if (host !== null && !host.matches(':popover-open')) host.showPopover();
      // 聚焦 iframe 元素而不是 contentWindow：元素 focus() 会先更新布局，刚显示出来的小窗也能拿到焦点；
      // 对刚从隐藏变为显示的 iframe 调 contentWindow.focus() 有时不生效，按键会落到网页里（e2e 复现）
      if (!focusInput) return;
      if (loaded) iframe?.focus();
      else focusOnLoad = true;
    },
    hide() {
      if (host?.matches(':popover-open')) host.hidePopover();
    },
  };
}
