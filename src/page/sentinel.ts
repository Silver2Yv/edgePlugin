// 哨兵（ARCHITECTURE 4.3 规则 3、5.1、5.2）：所有框架都会运行。
// 无第三方依赖；加载时只挂被动监听，不读写 DOM、不建观察器——工具栏等到第一次有效选区才建。
import { browser } from 'wxt/browser';
import { type ActionSummary, BUILTIN_ACTIONS, DEFAULT_TOOLBAR } from '@/core/domain/actions';
import { truncateByJsonBytes } from '@/core/domain/bytes';
import { JOB_LIMITS } from '@/core/domain/job';
import type { ContentToBackground, PageConfig } from '@/core/domain/messages';
import { setLastSelectionRect } from './selection-bus';
import {
  evaluateSelection,
  lastLineRect,
  readonlyInputRect,
  type SelectionDecision,
  selectionTop,
} from './selection-policy';
import { createToolbar, needsLongConfirm, type ToolbarHost } from './toolbar';

/** 同一框架里只留一个哨兵：后台在安装或更新时会向已开网页再注入一次（L5） */
const INSTANCE = Symbol.for('readingAssistant.sentinel');

/** 还没问到后台配置之前，先用出厂的默认工具栏（A2），拿到真实配置后下次选中就是准的 */
const FALLBACK_TOOLBAR: readonly ActionSummary[] = DEFAULT_TOOLBAR.flatMap((id) => {
  const d = BUILTIN_ACTIONS.find((a) => a.id === id);
  return d ? [{ id: d.id, label: d.label, kind: d.kind, needsInput: d.needsInput, scope: d.scope }] : [];
});

export function startSentinel(): void {
  const g = globalThis as unknown as Record<symbol, { dispose(): void } | undefined>;
  g[INSTANCE]?.dispose();
  let selectionRevision = 0;
  let pendingText = '';
  let pendingInCode = false;
  let pendingOriginalLength = 0;
  let toolbar: ToolbarHost | undefined;
  let toolbarActions: readonly ActionSummary[] = FALLBACK_TOOLBAR;
  /** live（contract-v1.5）：小窗/侧边栏开着并订阅了这个标签页时为真，新选中的文字才上报（D11、B5） */
  let liveEnabled = false;
  /** 防抖：和上一次上报的文字相同就不重发（同一段选区连续触发 mouseup/keyup 时常见） */
  let lastLiveText: string | undefined;
  /**
   * 页面侧配置只问一次（按需，第一次有效选区时）：工具栏按钮顺序/隐藏/自定义（A3）、子框架的站点级别（4.1、AR-14）。
   * 顶层框架不等它就先用出厂默认列表弹出工具栏，配置到了就存起来，下次选中起生效（不强求这一次立刻更新，简单优先）
   */
  const isTop = window === window.top;
  let configPromise: Promise<PageConfig | undefined> | undefined;
  const ensureConfig = (): Promise<PageConfig | undefined> => {
    configPromise ??= browser.runtime
      .sendMessage({ type: 'config/get' } satisfies ContentToBackground)
      .then((c: unknown) => {
        const cfg = c as PageConfig | undefined;
        if (cfg?.toolbarActions?.length) toolbarActions = cfg.toolbarActions;
        liveEnabled = cfg?.liveQuote === true;
        return cfg;
      })
      .catch(() => undefined);
    return configPromise;
  };

  function getToolbar(): ToolbarHost {
    if (toolbar === undefined) {
      toolbar = createToolbar((action) => {
        // 「存」落库后才提示「已存」（AR-17）；不等期间保留按钮与选区，点别处仍会照常收起
        if (action.kind === 'save') {
          sendSave(action.id);
          return;
        }
        // 长选区先确认一次（A7）；「问」也算（长选区会作为引用发出去）
        if (needsLongConfirm(action, pendingOriginalLength)) {
          toolbar?.confirm(`选中约 ${pendingOriginalLength} 字，确定要发送吗？`, () => {
            sendActionClick(action.id);
            toolbar?.hide();
          });
          return;
        }
        sendActionClick(action.id);
        toolbar?.hide();
      });
    }
    return toolbar;
  }

  // 选区失效（折叠、点别处、Esc、滚动、复制、开始输入）时调用：收起工具栏，矩形留给阅读器给小窗定位用（不在这里清掉）
  function clearSelection(): void {
    toolbar?.hide();
    setLastSelectionRect(null);
    lastLiveText = undefined; // 折叠不清引用条（D11），但去抖的「上一次」要清，免得之后重新选中同一段文字被当成重复
  }

  function sendSelectionReady(decision: SelectionDecision): void {
    selectionRevision += 1;
    pendingText = decision.text;
    pendingInCode = decision.inCode;
    pendingOriginalLength = [...decision.text].length;
    const msg: ContentToBackground = {
      type: 'selection/ready',
      selectionRevision,
      textLength: pendingOriginalLength,
      inCode: decision.inCode,
    };
    void browser.runtime.sendMessage(msg);
  }

  function sendActionClick(actionId: ActionSummary['id']): void {
    const { text, truncated } = truncateByJsonBytes(pendingText, JOB_LIMITS.maxFieldBytes);
    const msg: ContentToBackground = {
      type: 'action/click',
      actionId,
      selectionRevision,
      text,
      truncated,
      originalLength: pendingOriginalLength,
      inCode: pendingInCode,
    };
    void browser.runtime.sendMessage(msg);
  }

  /**
   * 「存」（G1、G3）：事务提交后才显示「已存」（AR-17），失败给非模态提示；两者都复用工具栏的
   * `tip`（一句话，几秒后自动恢复成按钮）。工具栏在这期间可能已经被别的操作收起，`tip` 自己会判断。
   */
  function sendSave(actionId: ActionSummary['id']): void {
    const { text, truncated } = truncateByJsonBytes(pendingText, JOB_LIMITS.maxFieldBytes);
    const msg: ContentToBackground = {
      type: 'action/click',
      actionId,
      selectionRevision,
      text,
      truncated,
      originalLength: pendingOriginalLength,
      inCode: pendingInCode,
    };
    browser.runtime.sendMessage(msg).then(
      (res: unknown) => {
        const ok = typeof res === 'object' && res !== null && (res as { ok?: boolean }).ok === true;
        toolbar?.tip(ok ? '已存' : '收藏失败，请再试一次');
      },
      () => toolbar?.tip('收藏失败，请再试一次'),
    );
  }

  /** live（contract-v1.5）：选区稳定（mouseup/keyup）时，有界面在看着就把这次选中的文字也报一份，换引用条 */
  function sendLiveSelection(): void {
    if (pendingText === lastLiveText) return; // 防抖：同一段文字不重发
    lastLiveText = pendingText;
    const { text, truncated } = truncateByJsonBytes(pendingText, JOB_LIMITS.maxFieldBytes);
    const msg: ContentToBackground = {
      type: 'selection/live',
      selectionRevision,
      text,
      truncated,
      originalLength: pendingOriginalLength,
      inCode: pendingInCode,
    };
    void browser.runtime.sendMessage(msg);
  }

  function showFor(decision: SelectionDecision, rect: DOMRect, anchorTop: number): void {
    sendSelectionReady(decision);
    if (liveEnabled) sendLiveSelection();
    setLastSelectionRect(rect, selectionRevision);
    getToolbar().show(rect, toolbarActions, decision.inCode, anchorTop);
  }

  function onSelectionChange(pointer?: { x: number; y: number }): void {
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
    // 只读输入框里拿不到文字矩形（A1）：用松开鼠标的位置或输入框位置
    const rect =
      lastLineRect(sel) ??
      (decision.readonlyInput ? readonlyInputRect(decision.readonlyInput, pointer) : null);
    if (rect === null) {
      clearSelection();
      return;
    }
    // 整个选区的上沿（A5）：翻到上方时贴着它，不贴最后一行，免得盖住多行选区前面几行；
    // 只读输入框用的是松开鼠标处拼出来的矩形，没有「选区第一行」的概念，直接用这个矩形自己的上沿
    const anchorTop = (decision.readonlyInput ? null : selectionTop(sel)) ?? rect.top;
    if (isTop) {
      // 不等配置到了再弹，先用已知的列表（出厂默认或上次问到的）；配置到了存起来，下次选中生效
      void ensureConfig();
      showFor(decision, rect, anchorTop);
      return;
    }
    void ensureConfig().then((c) => {
      if (c?.siteLevel === 'normal') showFor(decision, rect, anchorTop);
    });
  }

  const onMouseUp = (e: MouseEvent) => {
    if (e.isTrusted) onSelectionChange({ x: e.clientX, y: e.clientY });
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (!e.isTrusted) return;
    if (e.key === 'Escape') clearSelection();
    else onSelectionChange();
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.isTrusted && toolbar !== undefined && !toolbar.el.contains(e.target as Node)) clearSelection();
  };
  const onScroll = (e: Event) => {
    if (e.isTrusted) clearSelection();
  };
  const onCopy = (e: ClipboardEvent) => {
    if (e.isTrusted) clearSelection();
  };
  // live（contract-v1.5）：后台广播的开关指令（没有订阅者时撤回）。不经 backgroundToContent 整张表校验
  // （那张表体积不小，哨兵有 10 KB gzip 的硬门槛），手写最小校验；判断「来自后台」同阅读器（reader.ts）的写法
  const onBgMessage = (raw: unknown, sender: { id?: string; tab?: unknown }) => {
    if (sender.id !== browser.runtime.id || sender.tab !== undefined) return;
    if (
      typeof raw === 'object' &&
      raw !== null &&
      (raw as { type?: unknown }).type === 'live/toggle' &&
      typeof (raw as { enabled?: unknown }).enabled === 'boolean'
    )
      liveEnabled = (raw as { enabled: boolean }).enabled;
  };

  // 只挂被动监听：松开鼠标 / 键盘改变选区，Esc 隐藏，点别处隐藏，滚动 / 复制后消失（A5）。
  // 挂在 window 的捕获阶段：不少网页在冒泡阶段拦截事件（stopPropagation），挂在 document 上就收不到。
  // 「滚动」只认页面本身的滚动，不用捕获阶段——scroll 不冒泡，捕获阶段会连带收到网页内部可滚动容器
  // （代码块、textarea 内部因选中而回滚）自己的 scroll，把刚弹出的工具栏误收起（选中只读代码框全选会触发）
  const opts = { capture: true, passive: true } as const;
  const passiveOpts: AddEventListenerOptions = { passive: true };
  window.addEventListener('mouseup', onMouseUp, opts);
  window.addEventListener('keyup', onKeyUp, opts);
  window.addEventListener('mousedown', onMouseDown, opts);
  window.addEventListener('scroll', onScroll, passiveOpts);
  window.addEventListener('copy', onCopy, opts);
  browser.runtime.onMessage.addListener(onBgMessage);

  function dispose(): void {
    window.removeEventListener('mouseup', onMouseUp, opts);
    window.removeEventListener('keyup', onKeyUp, opts);
    window.removeEventListener('mousedown', onMouseDown, opts);
    window.removeEventListener('scroll', onScroll, passiveOpts);
    window.removeEventListener('copy', onCopy, opts);
    browser.runtime.onMessage.removeListener(onBgMessage);
    toolbar?.el.remove();
    toolbar = undefined;
    setLastSelectionRect(null);
    if (g[INSTANCE] === instance) g[INSTANCE] = undefined;
  }
  const instance = { dispose };
  g[INSTANCE] = instance;
}
