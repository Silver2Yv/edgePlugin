// 工具栏（ARCHITECTURE 5.2）：封闭 Shadow DOM 宿主 + popover="manual" 顶层。
// 只放按钮、确认提示、「更多」面板，不放任何对话内容（规则 4）。
import {
  type ActionSummary,
  BUILTIN_ACTIONS,
  LONG_SELECTION_CHARS,
  TOOLBAR_MAX,
} from '@/core/domain/actions';

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

/** 纯计算：放在选区最后一行矩形下方，放不下翻到上方；选区本身（上下都）不在视口内时夹回视口底部（A5）；
 * 水平方向夹在视口内 */
export function computeToolbarPosition(
  rect: Rect,
  size: Size,
  viewport: Size,
): { left: number; top: number } {
  const maxTop = Math.max(MARGIN, viewport.height - size.height - MARGIN);
  let top = rect.bottom + MARGIN;
  if (top + size.height > viewport.height) {
    const above = rect.top - size.height - MARGIN;
    // 上方也放不下（选区本身在视口外，如超长选区的最后一行远在屏幕下方）：夹到视口内，不跟着超出
    top = above >= 0 && above <= maxTop ? above : maxTop;
  }
  const maxLeft = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  const left = Math.min(Math.max(rect.left, MARGIN), maxLeft);
  return { left, top: Math.min(Math.max(top, MARGIN), maxTop) };
}

const EXPLAIN_CODE_DEF = BUILTIN_ACTIONS.find((a) => a.id === 'explainCode');

function explainCodeAction(): ActionSummary {
  const d = EXPLAIN_CODE_DEF;
  if (!d) throw new Error('explainCode 未在 BUILTIN_ACTIONS 中定义');
  return { id: d.id, label: d.label, kind: d.kind, needsInput: d.needsInput, scope: d.scope };
}

/**
 * 选区在代码里时第一个按钮换成「解释代码」（A6，替换位置 0，不管原来是什么）；
 * 超过 TOOLBAR_MAX 个时，余下收进「更多」（A2）
 */
export function arrangeToolbar(
  actions: readonly ActionSummary[],
  inCode: boolean,
): { shown: ActionSummary[]; overflow: ActionSummary[] } {
  const list =
    inCode && actions.length > 0
      ? [explainCodeAction(), ...actions.slice(1).filter((a) => a.id !== 'explainCode')]
      : [...actions];
  const capacity = list.length > TOOLBAR_MAX ? TOOLBAR_MAX - 1 : TOOLBAR_MAX;
  return { shown: list.slice(0, capacity), overflow: list.slice(capacity) };
}

/** 选中内容过长时，发给模型前先确认一次（A7）；只对会发请求、且作用在选区上的动作生效 */
export function needsLongConfirm(action: ActionSummary, originalLength: number): boolean {
  return action.kind === 'model' && action.scope === 'selection' && originalLength > LONG_SELECTION_CHARS;
}

export interface ToolbarHost {
  readonly el: HTMLElement;
  /** 显示按钮（或代码/更多的变体），`actions` 是后台下发、按用户设置排好序的完整列表 */
  show(rect: Rect, actions: readonly ActionSummary[], inCode: boolean): void;
  hide(): void;
  /** 一行小字提示，几秒后自动恢复成按钮（如「存」的占位提示） */
  tip(message: string): void;
  /** 一行小字 + 确认按钮，非模态（A7、M4）；点确认才回调 */
  confirm(message: string, onConfirm: () => void): void;
}

const TIP_MS = 2_000;

/** `onAction` 只在 isTrusted 的点击时调用 */
export function createToolbar(onAction: (action: ActionSummary) => void): ToolbarHost {
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
    .bar { position: relative; }
    .row { display: flex; gap: 4px; padding: 4px; background: #1f1f1f; border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); }
    button { all: unset; cursor: pointer; color: #fff; font-size: 13px; line-height: 20px;
      padding: 4px 10px; border-radius: 4px; white-space: nowrap; }
    button:hover { background: rgba(255, 255, 255, 0.15); }
    .panel { position: absolute; top: 100%; left: 0; margin-top: 4px; display: flex;
      flex-direction: column; gap: 2px; padding: 4px; background: #1f1f1f; border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); }
    .msg { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #1f1f1f;
      border-radius: 6px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); color: #fff; font-size: 12px;
      white-space: nowrap; }
    .msg button { color: #7dd3fc; padding: 4px 8px; }
    [hidden] { display: none !important; }
  `;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const row = document.createElement('div');
  row.className = 'row';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.hidden = true;
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.hidden = true;
  bar.append(row, panel);
  shadow.append(style, bar, msg);
  document.documentElement.append(host);

  function mkButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.setAttribute('aria-label', label);
    // 点工具栏不清掉网页选区
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      onClick();
    });
    return btn;
  }

  function closePanel(): void {
    panel.hidden = true;
    panel.replaceChildren();
  }

  let currentActions: readonly ActionSummary[] = [];
  let currentInCode = false;

  function renderButtons(): void {
    msg.hidden = true;
    bar.hidden = false;
    closePanel();
    const { shown, overflow } = arrangeToolbar(currentActions, currentInCode);
    const buttons = shown.map((a) =>
      mkButton(a.label, () => {
        closePanel();
        onAction(a);
      }),
    );
    if (overflow.length > 0) {
      buttons.push(
        mkButton('更多', () => {
          if (panel.hidden) {
            panel.replaceChildren(
              ...overflow.map((a) =>
                mkButton(a.label, () => {
                  closePanel();
                  onAction(a);
                }),
              ),
            );
            panel.hidden = false;
          } else closePanel();
        }),
      );
    }
    row.replaceChildren(...buttons);
  }

  function showMessage(text: string, actionLabel?: string, onClick?: () => void): void {
    closePanel();
    bar.hidden = true;
    msg.hidden = false;
    const span = document.createElement('span');
    span.textContent = text;
    const children: Node[] = [span];
    if (actionLabel && onClick) children.push(mkButton(actionLabel, onClick));
    msg.replaceChildren(...children);
  }

  let shown = false;
  let lastRect: Rect | undefined;
  let tipTimer: ReturnType<typeof setTimeout> | undefined;

  function reposition(rect: Rect): void {
    const target = bar.hidden ? msg : bar;
    const size = { width: target.offsetWidth, height: target.offsetHeight };
    const pos = computeToolbarPosition(rect, size, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    host.style.left = `${pos.left}px`;
    host.style.top = `${pos.top}px`;
  }

  function sameActions(a: readonly ActionSummary[], b: readonly ActionSummary[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i]?.id !== b[i]?.id) return false;
    return true;
  }

  return {
    el: host,
    show(rect, actions, inCode) {
      if (tipTimer !== undefined) {
        clearTimeout(tipTimer);
        tipTimer = undefined;
      }
      lastRect = rect;
      // 选区没变时后台会重复收到 selection/ready（比如点工具栏自己的按钮也会触发一次 mouseup），
      // 这时按钮列表和上次一样：跳过重建 DOM，只重新定位。按钮点到一半被替换成新节点，
      // 原生的 click 合成（要求 mousedown 与 mouseup 落在同一个节点上）就会丢（这里曾经复现过）
      const needsRebuild = bar.hidden || currentInCode !== inCode || !sameActions(currentActions, actions);
      currentActions = actions;
      currentInCode = inCode;
      if (!shown) {
        host.showPopover();
        shown = true;
      }
      if (needsRebuild) renderButtons();
      reposition(rect);
    },
    hide() {
      if (tipTimer !== undefined) {
        clearTimeout(tipTimer);
        tipTimer = undefined;
      }
      if (shown) {
        host.hidePopover();
        shown = false;
      }
      closePanel();
    },
    tip(message) {
      if (!shown || !lastRect) return;
      showMessage(message);
      reposition(lastRect);
      if (tipTimer !== undefined) clearTimeout(tipTimer);
      tipTimer = setTimeout(() => {
        tipTimer = undefined;
        if (!shown || !lastRect) return;
        renderButtons();
        reposition(lastRect);
      }, TIP_MS);
    },
    confirm(message, onConfirm) {
      if (!shown || !lastRect) return;
      showMessage(message, '确认', onConfirm);
      reposition(lastRect);
    },
  };
}
