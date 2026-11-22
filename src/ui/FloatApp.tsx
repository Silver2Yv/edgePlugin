// 小窗（5.3）：从地址片段取令牌握手、订阅对话、发问、逐字渲染增量，断线后自动重连（5.5）。
// 界面（B1–B3、B5、B8、C1）：顶栏（新对话、转到侧边栏、图钉、收起）→ 一行提示 → 对话列表 → 输入区
// （引用条、输入框、上下文档位与思考强度）。样式与组件和侧边栏共用（theme.css、chat/）；逻辑共用 float/state.ts 的归约器。
// 回答区的 Markdown/公式/高亮/引用渲染交给 src/ui/render（5.10）；对话内容只用文本节点或
// 该模块产出的 DOM 渲染，不经过 window.postMessage（规则 4、5）。
//
// 拖动 / 缩放不在这里处理：V-12 实测发现 iframe 内指针捕获一旦移出 iframe 渲染区域（缩放拖出、
// 大幅拖动都会立刻发生）就收不到后续 pointermove，这是 pointer capture 跨 iframe 边界的已知限制
// （不是实现 bug），按 5.3 原文的退路改为宿主侧不可见把手直接处理（page/float-host.ts）。
// 这里只做两件事：连接时按持久化设置回放一次记忆的位置/尺寸；收到手势结束后的最终 rect 时落盘。
//
// 图钉（B3、B5）：钉住时点网页别处不收起。「点别处收起」是阅读器在网页文档上判断的，所以图钉状态经私有端口
// 告诉阅读器（float/pin）。打开时的状态取设置里的默认关闭方式（settings.float.closeMode），点图钉只临时切换。
//
// 转到侧边栏（6.4、AR-19）：小窗是扩展页面，在这里点按钮是扩展页面上的用户手势，点击处理里同步
// sidePanel.open（窗口在加载时就取好，点击时不 await，规则 10），再发 handoff/start；侧边栏订阅并收到
// 初始推送后后台回 handoff/done，小窗这时才经私有端口收起。迟迟没接上就不收起，提示一行。
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import {
  type BackgroundToClient,
  type ClientToBackground,
  CONV_PORT,
  FLOAT_PORT,
  type FloatToReader,
  type ReaderToFloat,
} from '@/core/domain/messages';
import { isReadCoverageNote } from '@/core/prompt/ask';
import { loadSettings, SETTINGS_KEY } from '@/platform/settings-store';
import { EXPAND_QUESTION, NO_CONNECTION } from './ask-defaults';
import { type AskDeps, flushQueuedAsk, submitAsk, useComposerDefaults } from './chat/ask';
import { Composer } from './chat/Composer';
import { IconClose, IconPanel, IconPin, IconPlus } from './chat/Icons';
import { MessageList } from './chat/MessageList';
import { resummarize, SummaryCard, summaryCardVisible, useLastSummary } from './cite/SummaryCard';
import { CiteNote, useCite } from './cite/useCite';
import { displayItems } from './float/messages';
import {
  type FloatRectValue,
  type FloatState,
  floatReducer,
  HANDOFF_SLOW_MS,
  initialFloatState,
  isGenerating,
  parseTokenFromHash,
  restoreCommandsOnConnect,
  subscribeMessage,
} from './float/state';
import { T } from './strings';
import './theme.css';

type Port = Browser.runtime.Port;

/** 从地址片段读令牌（#t=<32 位十六进制>），读到即清掉片段，避免片段留在 performance 资源条目里 */
function takeToken(): string | null {
  const token = parseTokenFromHash(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return token;
}

const CONN_MESSAGE: Readonly<Record<FloatState['connPhase'], string | null>> = {
  noToken: T.conn.float.noToken,
  connecting: T.conn.float.connecting,
  ready: null,
  versionMismatch: T.conn.float.versionMismatch,
  reconnecting: T.conn.float.reconnecting,
  idle: null,
  expired: T.conn.float.expired,
};

export function FloatApp() {
  const [token] = useState(takeToken);
  const [state, dispatch] = useReducer(floatReducer, initialFloatState(token !== null));
  const [question, setQuestion] = useState('');
  // 图钉：null 表示还没读到设置里的默认关闭方式（读到之前不向阅读器报状态）
  const [pinned, setPinned] = useState<boolean | null>(null);
  // 私有端口每连上一次加一：连上后要把图钉状态报给阅读器
  const [floatPortSeq, setFloatPortSeq] = useState(0);
  const defaults = useComposerDefaults();
  const portRef = useRef<Port | null>(null);
  // 异步操作（loadSettings）resolve 之后要读最新状态，不能用闭包里那份
  const stateRef = useRef(state);
  stateRef.current = state;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // 小窗私有端口（恢复位置尺寸 / 图钉 / 收起，5.3）；与所在标签页的阅读器直连，不经后台
  const floatPortRef = useRef<Port | null>(null);
  // 所在窗口：加载时取好，点「转到侧边栏」时同步 open 要用（规则 10，点击处理里不能 await）
  const windowIdRef = useRef<number | null>(null);

  // 建端口：helloFloat（首次）或 resumeFloat（重连）
  const connect = (hello: ClientToBackground) => {
    const port = browser.runtime.connect({ name: CONV_PORT });
    portRef.current = port;
    port.onMessage.addListener((raw: BackgroundToClient) => {
      dispatch({ kind: 'server', msg: raw });
      // cite 块：引用跳回的结果、上次总结
      cite.onMessage(raw);
      lastSummary.onMessage(raw);
    });
    port.onDisconnect.addListener(() => dispatch({ kind: 'disconnected' }));
    port.postMessage(hello);
  };

  /** 从 idle 唤醒重连；其余状态下是空操作（onWake 只在 idle 时改变状态） */
  const wake = () => dispatch({ kind: 'wake' });

  const askDeps: AskDeps = {
    getState: () => stateRef.current,
    post: (msg) => portRef.current?.postMessage(msg),
    dispatch,
    canSendNow: (s) => s.connPhase === 'ready',
    wake,
  };

  // cite 块：引用跳回原文（F1、F4）与上次总结（6.2）
  const canSendNow = () => stateRef.current.connPhase === 'ready';
  const post = (msg: ClientToBackground) => portRef.current?.postMessage(msg);
  const cite = useCite({ post, canSendNow, wake }, state.job?.jobId ?? '');
  const lastSummary = useLastSummary({ post, canSendNow }, '', state.job?.jobId ?? null);

  useEffect(() => {
    if (token !== null) connect({ type: 'conv/helloFloat', token });
    // 只在挂载时建立首次连接；重连由下面按 connPhase 变化触发
  }, []);

  // tabs.getCurrent() 在扩展页面的 iframe 里拿到宿主所在的标签页（按帧树判定），从它取窗口
  useEffect(() => {
    void browser.tabs.getCurrent().then((tab) => {
      if (tab?.windowId !== undefined) windowIdRef.current = tab.windowId;
    });
  }, []);

  /** 手势结束后的最终 rect（settled: true）落盘到 settings.float.rect */
  async function persistRect(rect: FloatRectValue): Promise<void> {
    const loaded = await loadSettings();
    if (!loaded.ok) return;
    const next = { ...loaded.settings, float: { ...loaded.settings.float, rect } };
    await browser.storage.local.set({ [SETTINGS_KEY]: next });
  }

  // 小窗私有端口：连上所在标签页的阅读器（5.3）。tabs.getCurrent() 在扩展页面的 iframe 里能拿到
  // 宿主所在的标签页（浏览器按帧树判定，不是“当前激活标签页”那个概念），frameId: 0 精确指向顶层
  // 框架的阅读器——同一时刻只会有一个。连接后先收一次当前 rect，再按持久化设置决定要不要恢复；
  // 之后每次收到 settled: true 的 rect（宿主侧把手完成一次拖动/缩放手势）就落盘。
  useEffect(() => {
    if (token === null) return;
    let disposed = false;
    let port: Port | null = null;
    let settingsLoaded: Parameters<typeof restoreCommandsOnConnect>[1] | null = null;
    let restored = false;
    let lastRect: FloatRectValue | null = null;

    const tryRestore = () => {
      if (restored || settingsLoaded === null || lastRect === null || port === null) return;
      restored = true;
      for (const cmd of restoreCommandsOnConnect(lastRect, settingsLoaded)) port.postMessage(cmd);
    };

    void loadSettings().then((r) => {
      if (disposed) return;
      settingsLoaded = r.ok ? r.settings.float : { placement: 'nearSelection' };
      // 打开时钉不钉住取设置里的默认关闭方式（B3）；用户已经点过图钉就不覆盖
      const pinnedByDefault = r.ok && r.settings.float.closeMode === 'pinned';
      setPinned((cur) => cur ?? pinnedByDefault);
      tryRestore();
    });

    void browser.tabs.getCurrent().then((tab) => {
      if (disposed || tab?.id === undefined) return;
      const p = browser.tabs.connect(tab.id, { name: FLOAT_PORT, frameId: 0 });
      port = p;
      floatPortRef.current = p;
      setFloatPortSeq((n) => n + 1);
      p.onMessage.addListener((raw: ReaderToFloat) => {
        if (raw.type !== 'float/rect') return;
        lastRect = { x: raw.x, y: raw.y, w: raw.w, h: raw.h };
        tryRestore();
        if (raw.settled) void persistRect(lastRect);
      });
    });

    return () => {
      disposed = true;
      port?.disconnect();
      floatPortRef.current = null;
    };
  }, [token]);

  // 图钉状态报给阅读器：私有端口连上后一次（floatPortSeq 变了），之后每次切换一次
  useEffect(() => {
    if (pinned === null) return;
    floatPortRef.current?.postMessage({ type: 'float/pin', pinned } satisfies FloatToReader);
  }, [pinned, floatPortSeq]);

  const collapse = () =>
    floatPortRef.current?.postMessage({ type: 'float/collapse' } satisfies FloatToReader);

  // 焦点在小窗里时按 Esc 收起（经私有端口；焦点在网页别处时由阅读器自己的 keydown 监听处理）
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.isTrusted && e.key === 'Escape') collapse();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, []);

  useEffect(() => {
    if (state.connPhase === 'ready') portRef.current?.postMessage(subscribeMessage(state.job));
    else if (state.connPhase === 'reconnecting') connect({ type: 'conv/resumeFloat' });
  }, [state.connPhase]);

  // 这次订阅的初始推送（引用等）已收完：若有未就绪时存下的待发问，用这时最新的引用构造并发出
  useEffect(() => {
    flushQueuedAsk(state, askDeps);
    cite.flush();
    lastSummary.request();
  }, [state.snapshotSeq]);

  // 转接：连接就绪才发 handoff/start（点击时后台可能被回收了，先唤醒重连）
  useEffect(() => {
    const h = state.handoff;
    if (!h || h.sent || state.connPhase !== 'ready') return;
    const conversationId = state.conversationId;
    portRef.current?.postMessage({
      type: 'handoff/start',
      ...(conversationId ? { conversationId } : {}),
    } satisfies ClientToBackground);
    dispatch({ kind: 'handoffSent' });
  }, [state.handoff, state.connPhase]);

  // 侧边栏接上（handoff/done）才收起；迟迟没接上就提示一行，小窗留着（AR-19）
  useEffect(() => {
    if (!state.handoff?.done) return;
    collapse();
    dispatch({ kind: 'handoffClear' });
  }, [state.handoff?.done]);

  const handoffWaiting = state.handoff !== null && !state.handoff.done && !state.handoff.slow;
  useEffect(() => {
    if (!handoffWaiting) return;
    const timer = setTimeout(() => dispatch({ kind: 'handoffSlow' }), HANDOFF_SLOW_MS);
    return () => clearTimeout(timer);
  }, [handoffWaiting]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // 小窗获得焦点（阅读器显示小窗时会聚焦 iframe）：把焦点交给输入框，并从 idle 唤醒重连。
  // 预热的小窗挂载时是隐藏的，挂载时那次 focus() 不生效，所以每次获得焦点都要再聚焦一次
  useEffect(() => {
    if (token === null) return;
    const onFocus = () => {
      if (document.activeElement !== textareaRef.current) textareaRef.current?.focus();
      wake();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const generating = isGenerating(state.job);
  // 看着答完一次页面级总结：上次总结换成了这一次，重新取（之后点「新对话」时卡片显示的是最新的）
  const pageSummaryDone =
    state.job?.state === 'completed' && state.job.plan?.notes.some(isReadCoverageNote) === true;
  useEffect(() => {
    if (pageSummaryDone) lastSummary.request();
  }, [pageSummaryDone, state.job?.jobId]);
  const summaryVisible = summaryCardVisible(lastSummary.shown, lastSummary.forced, state);

  const handleSend = async () => {
    if (await submitAsk(askDeps, question)) setQuestion('');
  };

  /** 「展开讲讲」（I3）：在同一个对话里追问一句，长度档用详细 */
  const handleExpand = () => void submitAsk(askDeps, EXPAND_QUESTION, { lengthTier: 'detailed' });

  const handleStop = () => {
    if (!state.job) return;
    portRef.current?.postMessage({ type: 'conv/stop', jobId: state.job.jobId } satisfies ClientToBackground);
  };

  const handleRetry = () => {
    if (!state.job) return;
    portRef.current?.postMessage({ type: 'conv/retry', jobId: state.job.jobId } satisfies ClientToBackground);
  };

  /**
   * 转到侧边栏。open 必须在这次点击的同步路径上发出（规则 10），所以窗口事先取好、这里不 await。
   * 没握手（令牌无效等）也能打开侧边栏：侧边栏跟着本标签页走，选区引用照样带过去，只是没有转接可确认
   */
  const handleToPanel = () => {
    const windowId = windowIdRef.current;
    if (windowId === null) {
      dispatch({ kind: 'localError', message: T.error.notReady });
      return;
    }
    void browser.sidePanel
      .open({ windowId })
      .catch(() => dispatch({ kind: 'localError', message: T.error.panelNotOpened }));
    // 没握手、握手失败、版本不对：没有转接可确认，只打开侧边栏（侧边栏跟着本标签页，引用照样带过去）
    const phase = stateRef.current.connPhase;
    if (phase === 'noToken' || phase === 'expired' || phase === 'versionMismatch') return;
    dispatch({ kind: 'handoffStarted' });
    wake();
  };

  const connMessage = CONN_MESSAGE[state.connPhase];
  // versionMismatch 重连也没用（得刷新页面），其余状态都允许输入：idle / connecting / reconnecting
  // 下用户可以照常打字、点发送，连接没就绪时会先存成待发（见 submitAsk）
  const canType =
    state.connPhase !== 'noToken' && state.connPhase !== 'expired' && state.connPhase !== 'versionMismatch';
  const isPinned = pinned === true;
  const hasConversation = state.conversationId !== null || state.messages.length > 0 || state.job !== null;

  return (
    <main className="ra-app ra-app--float">
      <header className="ra-header">
        <span className="ra-header__title">{T.brand}</span>
        <button
          type="button"
          className="ra-icon-btn"
          aria-label={T.header.newConversation}
          title={T.header.newConversationTitle}
          disabled={generating || !hasConversation}
          onClick={() => dispatch({ kind: 'newConversation' })}
        >
          <IconPlus />
        </button>
        <button
          type="button"
          className="ra-icon-btn"
          aria-label={T.header.toPanel}
          title={T.header.toPanelTitle}
          onClick={handleToPanel}
          disabled={state.handoff !== null && !state.handoff.slow}
        >
          <IconPanel />
        </button>
        <button
          type="button"
          className="ra-icon-btn"
          aria-label={T.header.pin}
          aria-pressed={isPinned}
          title={isPinned ? T.header.unpinTitle : T.header.pinTitle}
          onClick={() => setPinned(!isPinned)}
        >
          <IconPin filled={isPinned} />
        </button>
        <button
          type="button"
          className="ra-icon-btn"
          aria-label={T.header.close}
          title={T.header.closeTitle}
          onClick={collapse}
        >
          <IconClose />
        </button>
      </header>
      <div className="ra-notes">
        <CiteNote cite={cite.cite} onBack={cite.back} />
        {connMessage && <p className="ra-note">{connMessage}</p>}
        {state.handoff?.slow && (
          <p data-testid="handoff-hint" className="ra-note">
            {T.notice.handoffSlow}
          </p>
        )}
        {state.convHint === 'newConversation' && (
          <p data-testid="conv-hint" className="ra-note">
            {T.notice.newConversationStarted}
          </p>
        )}
      </div>
      <MessageList
        items={displayItems(state.messages, state.job)}
        emptyText={canType ? T.list.emptyFloat : ''}
        generating={generating}
        onRetry={handleRetry}
        onExpand={handleExpand}
        onCitation={cite.locate}
        header={
          summaryVisible && lastSummary.shown ? (
            <SummaryCard
              summary={lastSummary.shown.summary}
              forced={lastSummary.forced}
              onCitation={cite.locate}
              onResummarize={() => void resummarize(askDeps)}
            />
          ) : null
        }
      />
      {state.actionError && (
        <p data-testid="action-error" className="ra-note ra-note--error">
          {state.actionError}
          {state.actionError === NO_CONNECTION && (
            <button
              type="button"
              className="ra-btn ra-btn--small"
              onClick={() => void browser.runtime.openOptionsPage()}
            >
              {T.notice.openSettings}
            </button>
          )}
        </p>
      )}
      {canType && (
        <Composer
          inputRef={textareaRef}
          value={question}
          onInput={setQuestion}
          onSend={() => void handleSend()}
          onStop={handleStop}
          onFocus={wake}
          generating={generating}
          quote={state.quote}
          onDismissQuote={() => dispatch({ kind: 'dismissQuote' })}
          tier={state.tierOverride ?? defaults.contextTier}
          thinking={state.thinkingOverride ?? defaults.thinking}
          tierChanged={state.tierOverride !== null && state.tierOverride !== defaults.contextTier}
          thinkingChanged={state.thinkingOverride !== null && state.thinkingOverride !== defaults.thinking}
          onTier={(contextTier) => dispatch({ kind: 'setTier', contextTier })}
          onThinking={(thinking) => dispatch({ kind: 'setThinking', thinking })}
          model={defaults.model}
        />
      )}
    </main>
  );
}
