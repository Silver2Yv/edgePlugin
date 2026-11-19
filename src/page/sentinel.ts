// 哨兵（ARCHITECTURE 4.3 规则 3、5.1、5.2）：所有框架都会运行。
// 无第三方依赖；加载时只挂被动监听，不读写 DOM、不建观察器——工具栏等到第一次有效选区才建。
import { browser } from 'wxt/browser';
import type { ActionId } from '@/core/domain/actions';
import { truncateByJsonBytes } from '@/core/domain/bytes';
import { JOB_LIMITS } from '@/core/domain/job';
import type { ContentToBackground } from '@/core/domain/messages';
import { setLastSelectionRect } from './selection-bus';
import { evaluateSelection, lastLineRect, type SelectionDecision } from './selection-policy';
import { createToolbar, type ToolbarHost } from './toolbar';

/** 同一框架里只留一个哨兵：后台在安装或更新时会向已开网页再注入一次（L5） */
const INSTANCE = Symbol.for('readingAssistant.sentinel');

export function startSentinel(): void {
  const g = globalThis as unknown as Record<symbol, { dispose(): void } | undefined>;
  g[INSTANCE]?.dispose();
  let selectionRevision = 0;
  let pendingText = '';
  let pendingInCode = false;
  let toolbar: ToolbarHost | undefined;

  function getToolbar(): ToolbarHost {
    if (toolbar === undefined) {
      // 点「问」后只收起工具栏，选区矩形留给阅读器给小窗定位用（不在这里清掉）
      toolbar = createToolbar((actionId) => {
        sendActionClick(actionId);
        toolbar?.hide();
      });
    }
    return toolbar;
  }

  // 选区失效（折叠、点别处、Esc）时调用：收起工具栏，并清掉给小窗定位用的矩形
  function clearSelection(): void {
    toolbar?.hide();
    setLastSelectionRect(null);
  }

  function sendSelectionReady(decision: SelectionDecision): void {
    selectionRevision += 1;
    pendingText = decision.text;
    pendingInCode = decision.inCode;
    const msg: ContentToBackground = {
      type: 'selection/ready',
      selectionRevision,
      textLength: [...decision.text].length,
      inCode: decision.inCode,
    };
    void browser.runtime.sendMessage(msg);
  }

  function sendActionClick(actionId: ActionId): void {
    const { text, truncated } = truncateByJsonBytes(pendingText, JOB_LIMITS.maxFieldBytes);
    const msg: ContentToBackground = {
      type: 'action/click',
      actionId,
      selectionRevision,
      text,
      truncated,
      originalLength: [...pendingText].length,
      inCode: pendingInCode,
    };
    void browser.runtime.sendMessage(msg);
  }

  function onSelectionChange(): void {
    // 扩展被更新或重新加载后，旧哨兵和后台的联系就断了（runtime.id 变为 undefined）：退出，让新注入的接手
    if (!browser.runtime?.id) {
      dispose();
      return;
    }
    const sel = window.getSelection();
    const decision = evaluateSelection(sel);
    if (!decision.show || sel === null) {
      clearSelection();
      return;
    }
    const rect = lastLineRect(sel);
    if (rect === null) {
      clearSelection();
      return;
    }
    sendSelectionReady(decision);
    setLastSelectionRect(rect);
    getToolbar().show(rect);
  }

  const onMouseUp = (e: MouseEvent) => {
    if (e.isTrusted) onSelectionChange();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (!e.isTrusted) return;
    if (e.key === 'Escape') clearSelection();
    else onSelectionChange();
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.isTrusted && toolbar !== undefined && !toolbar.el.contains(e.target as Node)) clearSelection();
  };

  // 只挂 3 个被动监听：松开鼠标 / 键盘改变选区，Esc 隐藏，点别处隐藏。
  // 挂在 window 的捕获阶段：不少网页在冒泡阶段拦截 mouseup（stopPropagation），挂在 document 上就收不到
  const opts = { capture: true, passive: true } as const;
  window.addEventListener('mouseup', onMouseUp, opts);
  window.addEventListener('keyup', onKeyUp, opts);
  window.addEventListener('mousedown', onMouseDown, opts);

  function dispose(): void {
    window.removeEventListener('mouseup', onMouseUp, opts);
    window.removeEventListener('keyup', onKeyUp, opts);
    window.removeEventListener('mousedown', onMouseDown, opts);
    toolbar?.el.remove();
    toolbar = undefined;
    setLastSelectionRect(null);
    if (g[INSTANCE] === instance) g[INSTANCE] = undefined;
  }
  const instance = { dispose };
  g[INSTANCE] = instance;
}
