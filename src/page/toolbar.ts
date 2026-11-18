// 工具栏（ARCHITECTURE 5.2）：封闭 Shadow DOM 宿主 + popover="manual" 顶层。
// 只放按钮，不放任何对话内容（规则 4）。
import { type ActionId, BUILTIN_ACTIONS, DEFAULT_TOOLBAR } from '@/core/domain/actions';

const MARGIN = 8;

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

/** 纯计算：放在选区最后一行矩形下方，放不下翻到上方；水平方向夹在视口内 */
export function computeToolbarPosition(
  rect: Rect,
  size: Size,
  viewport: Size,
): { left: number; top: number } {
  let top = rect.bottom + MARGIN;
  if (top + size.height > viewport.height) {
    const above = rect.top - size.height - MARGIN;
    top = above >= 0 ? above : Math.max(MARGIN, viewport.height - size.height - MARGIN);
  }
  const maxLeft = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  const left = Math.min(Math.max(rect.left, MARGIN), maxLeft);
  return { left, top };
}

export interface ToolbarHost {
  readonly el: HTMLElement;
  show(rect: Rect): void;
  hide(): void;
}

const LABEL_BY_ID = new Map<ActionId, string>(BUILTIN_ACTIONS.map((a) => [a.id, a.label]));

/** `onAction` 只在 isTrusted 的点击时调用 */
export function createToolbar(onAction: (actionId: ActionId) => void): ToolbarHost {
  const host = document.createElement('div');
  host.popover = 'manual';
  Object.assign(host.style, {
    position: 'fixed',
    margin: '0',
    padding: '0',
    border: 'none',
    background: 'transparent',
    inset: 'auto',
    overflow: 'visible',
    zIndex: '2147483647',
  });

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .bar { display: flex; gap: 4px; padding: 4px; background: #1f1f1f; border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); }
    button { all: unset; cursor: pointer; color: #fff; font-size: 13px; line-height: 20px;
      padding: 4px 10px; border-radius: 4px; }
    button:hover { background: rgba(255, 255, 255, 0.15); }
  `;
  const bar = document.createElement('div');
  bar.className = 'bar';
  for (const id of DEFAULT_TOOLBAR) {
    const label = LABEL_BY_ID.get(id) ?? id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.setAttribute('aria-label', label);
    // 点工具栏不清掉网页选区
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      onAction(id);
    });
    bar.append(btn);
  }
  shadow.append(style, bar);
  document.documentElement.append(host);

  let shown = false;
  return {
    el: host,
    show(rect) {
      if (!shown) {
        host.showPopover();
        shown = true;
      }
      const size = { width: bar.offsetWidth, height: bar.offsetHeight };
      const pos = computeToolbarPosition(rect, size, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      host.style.left = `${pos.left}px`;
      host.style.top = `${pos.top}px`;
    },
    hide() {
      if (shown) {
        host.hidePopover();
        shown = false;
      }
    },
  };
}
