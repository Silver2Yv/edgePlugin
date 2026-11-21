// 小窗宿主（ARCHITECTURE 5.3）：阅读器在顶层框架创建的隐藏 iframe，承载扩展页面 float.html。
// 每个标签页最多一个；收起只隐藏不销毁；不用 window.postMessage。
//
// 拖动 / 缩放（用户试用后要求窗口尺寸可调）：指针事件在宿主侧（这里）捕获，不在 iframe 内捕获。
// 原设计想法（ARCHITECTURE 5.3 原文）是在 iframe 内捕获指针事件、经私有端口移动宿主；
// 实测验证（V-12）发现一旦指针移动到 iframe 渲染区域之外（缩放拖出、大幅拖动都会立刻发生），
// 浏览器不再把 pointermove 路由进 iframe——这是 pointer capture 跨 iframe 边界的已知限制
// （W3C pointerevents issue #493；Chromium 对跨源 frame 的 pointer capture 路由有同类问题），
// 不是实现 bug。5.3 原文已预留退路：“若跟手性不够，改为宿主侧不可见把手”，这里就是那个退路：
// 两个不可见的叠加元素（覆盖在 iframe 之上的拖动条、缩放角）在宿主侧捕获指针，直接挪动宿主 div；
// 手势结束后把最终位置尺寸经私有端口回报给小窗（float-port.ts 的 onRectSettled），小窗据此落盘
// settings.float.rect——存储写入必须发生在小窗（扩展页面，可信上下文），不能在这里直接写
// storage.local（5.11 收紧后内容脚本读不到）。
import { browser } from 'wxt/browser';
import { FLOAT_LIMITS } from '@/core/domain/float';
import { getLastSelectionRect } from './selection-bus';

const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 480;
const MARGIN = 16;
/** 不可见把手的命中区域尺寸（CSS 像素） */
const DRAG_STRIP_HEIGHT = 16;
const RESIZE_HANDLE_SIZE = 16;

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

/** 小窗当前位置与尺寸（CSS 像素，相对视口） */
export interface FloatRect {
  left: number;
  top: number;
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

/**
 * 纯计算：把一个位置 + 尺寸夹回视口内（拖动 / 缩放 / 视口变化后调用）。
 * 尺寸先夹到 [最小尺寸, 视口可用空间] 之间，再夹位置；视口小于最小尺寸时退回最小尺寸（会溢出，无法避免）。
 */
export function clampRect(rect: FloatRect, viewport: Size): FloatRect {
  const maxWidth = Math.max(FLOAT_LIMITS.minWidth, viewport.width - 2 * MARGIN);
  const maxHeight = Math.max(FLOAT_LIMITS.minHeight, viewport.height - 2 * MARGIN);
  const width = Math.min(Math.max(rect.width, FLOAT_LIMITS.minWidth), maxWidth);
  const height = Math.min(Math.max(rect.height, FLOAT_LIMITS.minHeight), maxHeight);
  const maxLeft = Math.max(MARGIN, viewport.width - width - MARGIN);
  const maxTop = Math.max(MARGIN, viewport.height - height - MARGIN);
  const left = Math.min(Math.max(rect.left, MARGIN), maxLeft);
  const top = Math.min(Math.max(rect.top, MARGIN), maxTop);
  return { left, top, width, height };
}

export type FloatLoadResult = 'ready' | 'failedTransient';

export interface FloatHostApi {
  prewarm(token: string): void;
  show(opts: { token: string | undefined; focusInput: boolean }): void;
  hide(): void;
  /** 事件是否发生在小窗外壳上（边框、拖动条、缩放把手）。「点网页别处收起」要排除这些 */
  owns(e: Event): boolean;
  /** 恢复记忆尺寸：绝对尺寸（连接时按持久化设置回放一次，见 restoreCommandsOnConnect） */
  resize(w: number, h: number): FloatRect | null;
  /** 恢复记忆位置：绝对坐标 */
  reposition(x: number, y: number): FloatRect | null;
  /** 当前位置与尺寸；小窗未建好时为 null */
  getRect(): FloatRect | null;
  /** 小窗私有端口握手完成（attachFloatPort 收到合法连接）时调用；纯标记，供 e2e 等待后再做拖动/缩放 */
  markPortReady(): void;
  /**
   * 一次拖动或缩放手势结束（宿主侧指针捕获，pointerup）时调用一次，带上最终 rect；
   * float-port.ts 订阅它，把结果经私有端口回报给小窗用于落盘（settled: true）。
   */
  onRectSettled(cb: (rect: FloatRect) => void): void;
}

/**
 * onUnavailable：用户要看小窗（点了「问」、快捷键唤起），小窗却用不了——加载超时、宿主被网页移除。
 * 阅读器据此在网页上提示改用侧边栏（M4，page/notice.ts）；同时上报 failedTransient，后台下次换新令牌重建
 */
export function createFloatHost(
  onLoadResult: (result: FloatLoadResult) => void,
  onUnavailable: () => void = () => undefined,
): FloatHostApi {
  let host: HTMLElement | null = null;
  let iframe: HTMLIFrameElement | null = null;
  let loaded = false;
  /** 这一个 iframe 加载超时了（之后迟到的 load 仍会把它改回可用） */
  let failed = false;
  /** 用户此刻想看到小窗（show 之后、hide 之前） */
  let wanted = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  // 显示时小窗还没加载完：等加载完再聚焦。加载中的 iframe 拿到焦点后，换成扩展页面时焦点会丢回网页
  let focusOnLoad = false;
  /** 当前位置与尺寸；build() 之后才有值 */
  let rect: FloatRect | null = null;
  let rectSettledCb: ((rect: FloatRect) => void) | null = null;
  /**
   * 位置是用户定的（这个页面里拖过小窗，或按「记住位置」恢复过）：之后再打开小窗保持这个位置，
   * 不再贴着选区重新摆放（用户在 Edge 实测：拖过之后收起再打开，位置回到了选区旁边）。新页面重新开始
   */
  let pinned = false;

  const viewport = (): Size => ({ width: window.innerWidth, height: window.innerHeight });

  function applyRect(r: FloatRect): void {
    rect = r;
    if (!host) return;
    host.style.left = `${r.left}px`;
    host.style.top = `${r.top}px`;
    host.style.width = `${r.width}px`;
    host.style.height = `${r.height}px`;
  }

  /** 不可见把手：宿主侧捕获指针，覆盖在 iframe 之上的小块命中区域，不进 iframe（见文件头注释） */
  function attachHandle(
    el: HTMLElement,
    onDrag: (dx: number, dy: number, startRect: FloatRect) => FloatRect,
    movesWindow: boolean,
  ): void {
    let start: { x: number; y: number; rect: FloatRect } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (!e.isTrusted || rect === null) return;
      el.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, rect };
      // 手势期间让小窗 iframe 不参与命中：指针一移到 iframe 上方，浏览器会把事件交给 iframe 所在的进程，
      // 宿主侧的指针捕获就收不到后续移动（往下拖拖动条、往里缩把手时必现）。手势结束再恢复
      if (iframe) iframe.style.pointerEvents = 'none';
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      applyRect(clampRect(onDrag(e.clientX - start.x, e.clientY - start.y, start.rect), viewport()));
    });
    const end = (): void => {
      if (!start) return;
      if (movesWindow && rect && (rect.left !== start.rect.left || rect.top !== start.rect.top))
        pinned = true;
      start = null;
      if (iframe) iframe.style.pointerEvents = '';
      if (rect) rectSettledCb?.(rect);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  function build(token: string): void {
    const h = document.createElement('div');
    h.popover = 'manual';
    // 纯标记，方便 e2e 定位宿主 div（它直接挂在 document.documentElement 下，不在 shadow 里）
    h.dataset.raFloatHost = 'true';
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
    });
    const shadow = h.attachShadow({ mode: 'closed' });
    const frame = document.createElement('iframe');
    frame.src = `${browser.runtime.getURL('/float.html')}#t=${token}`;
    frame.allow = 'clipboard-write';
    // iframe 放在拖动条下方，拖动条不盖住小窗内容
    Object.assign(frame.style, {
      position: 'absolute',
      top: `${DRAG_STRIP_HEIGHT}px`,
      left: '0',
      width: '100%',
      height: `calc(100% - ${DRAG_STRIP_HEIGHT}px)`,
      border: '0',
      display: 'block',
    });
    loaded = false;
    failed = false;
    frame.addEventListener('load', () => {
      loaded = true;
      failed = false;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (focusOnLoad && h.matches(':popover-open')) frame.focus();
      focusOnLoad = false;
      onLoadResult('ready');
    });
    shadow.append(frame);

    // 两个不可见把手，DOM 顺序在 iframe 之后（同层叠放时排在后面的在上面），覆盖在 iframe 对应区域上方，
    // 指针事件被这两个元素截获，不会穿透到 iframe 里——从根本上避开 pointer capture 跨 iframe 边界的限制
    const dragHandle = document.createElement('div');
    dragHandle.dataset.testid = 'float-drag-handle';
    Object.assign(dragHandle.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      right: '0',
      height: `${DRAG_STRIP_HEIGHT}px`,
      cursor: 'move',
      background: '#f3f3f3',
      borderBottom: '1px solid #e6e6e6',
      boxSizing: 'border-box',
    });
    // 拖动条中间一道短横线，提示这里可以拖（用户试用反馈：完全不可见时不知道能拖）
    const grip = document.createElement('div');
    Object.assign(grip.style, {
      position: 'absolute',
      top: '50%',
      left: '50%',
      width: '36px',
      height: '4px',
      margin: '-2px 0 0 -18px',
      borderRadius: '2px',
      background: '#c4c4c4',
      pointerEvents: 'none',
    });
    dragHandle.append(grip);
    attachHandle(
      dragHandle,
      (dx, dy, startRect) => ({
        ...startRect,
        left: startRect.left + dx,
        top: startRect.top + dy,
      }),
      true,
    );

    const resizeHandle = document.createElement('div');
    resizeHandle.dataset.testid = 'float-resize-handle';
    Object.assign(resizeHandle.style, {
      position: 'absolute',
      right: '0',
      bottom: '0',
      width: `${RESIZE_HANDLE_SIZE}px`,
      height: `${RESIZE_HANDLE_SIZE}px`,
      cursor: 'nwse-resize',
      // 右下角两道斜线，提示这里可以缩放
      background:
        'linear-gradient(135deg, transparent 0 52%, #b5b5b5 52% 60%, transparent 60% 72%, #b5b5b5 72% 80%, transparent 80%)',
    });
    attachHandle(
      resizeHandle,
      (dx, dy, startRect) => ({
        ...startRect,
        width: startRect.width + dx,
        height: startRect.height + dy,
      }),
      false,
    );

    shadow.append(dragHandle, resizeHandle);
    document.documentElement.append(h);
    host = h;
    iframe = frame;
    applyRect({ left: 0, top: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
    timeoutId = setTimeout(() => {
      if (loaded) return;
      failed = true;
      onLoadResult('failedTransient');
      // 用户正等着看小窗：收起空白的外壳，改在网页上提示怎么继续（不能替用户打开侧边栏：这时已不在点击的手势里）
      if (wanted) {
        hideHost();
        onUnavailable();
      }
    }, FLOAT_LIMITS.loadTimeoutMs);
  }

  function hideHost(): void {
    if (host?.isConnected && host.matches(':popover-open')) host.hidePopover();
  }

  /** 丢掉不可用的小窗（超时、被网页移除），下次带新令牌重建 */
  function discard(): void {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    host?.remove();
    host = null;
    iframe = null;
    loaded = false;
    failed = false;
  }

  /** 贴着最近一次选区重新定位；保留当前尺寸（用户缩放过也不被重置） */
  function reposition(): void {
    if (host === null || rect === null) return;
    const sel = getLastSelectionRect();
    const selRect =
      sel === null ? null : { left: sel.left, right: sel.right, top: sel.top, bottom: sel.bottom };
    const pos = computeFloatPosition(selRect, { width: rect.width, height: rect.height }, viewport());
    applyRect(clampRect({ ...rect, left: pos.left, top: pos.top }, viewport()));
  }

  // 视口变化（窗口缩放、浏览器缩放等）：把小窗夹回新视口内，不改变用户设定的相对大小
  window.addEventListener('resize', () => {
    if (host !== null && rect !== null) applyRect(clampRect(rect, viewport()));
  });

  return {
    prewarm(token) {
      // 每个标签页最多一个小窗。已有一个、后台却又带新令牌来预热：说明它不知道这个文档里有握手过的小窗
      // （握手失败、令牌过期），现有的用不了，换新令牌重建（与 show 同一规则）。不重建的话后台以为新令牌的小窗
      // 已经建好，下次显示不再带令牌，用户点「问」看到的一直是失效的那个。正显示着的重建后照样显示在原处
      if (host !== null) {
        const open = host.isConnected && host.matches(':popover-open');
        const prev = rect;
        discard();
        build(token);
        if (open && prev !== null) {
          applyRect(prev);
          host?.showPopover();
        }
        return;
      }
      build(token);
    },
    show({ token, focusInput }) {
      wanted = true;
      // 小窗用不了（加载超时，或宿主被网页移除了）：有新令牌就重建；没有就提示改用侧边栏，并上报失败让后台下次发令牌。
      // 后台带了新令牌说明它不知道这个文档有握手过的小窗（握手失败、令牌过期）：同样换新令牌重建
      if (host !== null && (failed || !host.isConnected || token !== undefined)) {
        const removed = !host.isConnected;
        discard();
        if (token === undefined) {
          if (removed) onLoadResult('failedTransient');
          onUnavailable();
          return;
        }
      }
      if (host === null) {
        if (token === undefined) return; // 没令牌造不出小窗
        build(token);
      }
      if (pinned) {
        // 位置由用户定过：留在原处，只夹回视口（窗口可能缩小过）
        if (rect !== null) applyRect(clampRect(rect, viewport()));
      } else {
        reposition();
      }
      if (host !== null && !host.matches(':popover-open')) host.showPopover();
      // 聚焦 iframe 元素而不是 contentWindow：元素 focus() 会先更新布局，刚显示出来的小窗也能拿到焦点；
      // 对刚从隐藏变为显示的 iframe 调 contentWindow.focus() 有时不生效，按键会落到网页里（e2e 复现）
      if (!focusInput) return;
      if (loaded) iframe?.focus();
      else focusOnLoad = true;
    },
    hide() {
      wanted = false;
      hideHost();
    },
    owns(e) {
      // 外壳在封闭 shadow root 里，网页文档上的监听器看到的目标是宿主元素本身
      return host !== null && e.composedPath().includes(host);
    },
    resize(w, h) {
      if (host === null || rect === null) return null;
      applyRect(clampRect({ ...rect, width: w, height: h }, viewport()));
      return rect;
    },
    reposition(x, y) {
      if (host === null || rect === null) return null;
      // 来自小窗按「记住位置」的恢复：同样算用户定的位置
      pinned = true;
      applyRect(clampRect({ ...rect, left: x, top: y }, viewport()));
      return rect;
    },
    getRect() {
      return rect;
    },
    markPortReady() {
      if (host) host.dataset.raFloatPortReady = 'true';
    },
    onRectSettled(cb) {
      rectSettledCb = cb;
    },
  };
}
