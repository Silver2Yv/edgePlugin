// 小窗（5.3）：从地址片段取令牌握手、订阅对话、发问、逐字渲染增量，断线后自动重连（5.5）。
// 回答区的 Markdown/公式/高亮/引用渲染交给 src/ui/render（5.10）；对话内容只用文本节点或
// 该模块产出的 DOM 渲染，不经过 window.postMessage（规则 4、5）。
//
// 拖动 / 缩放不在这里处理：V-12 实测发现 iframe 内指针捕获一旦移出 iframe 渲染区域（缩放拖出、
// 大幅拖动都会立刻发生）就收不到后续 pointermove，这是 pointer capture 跨 iframe 边界的已知限制
// （不是实现 bug），按 5.3 原文的退路改为宿主侧不可见把手直接处理（page/float-host.ts）。
// 这里只做两件事：连接时按持久化设置回放一次记忆的位置/尺寸；收到手势结束后的最终 rect 时落盘。
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
import { loadSettings, SETTINGS_KEY } from '@/platform/settings-store';
import { AnswerView } from './AnswerView';
import { loadAskDefaults } from './ask-defaults';
import {
  buildAskMessage,
  type FloatRectValue,
  type FloatState,
  floatReducer,
  HANDOFF_SLOW_MS,
  initialFloatState,
  isGenerating,
  parseTokenFromHash,
  restoreCommandsOnConnect,
  shouldSendOnEnter,
  subscribeMessage,
} from './float/state';

type Port = Browser.runtime.Port;

/** 从地址片段读令牌（#t=<32 位十六进制>），读到即清掉片段，避免片段留在 performance 资源条目里 */
function takeToken(): string | null {
  const token = parseTokenFromHash(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return token;
}

const CONN_MESSAGE: Readonly<Record<FloatState['connPhase'], string | null>> = {
  noToken: '没有有效的令牌，无法连接',
  connecting: '连接中…',
  ready: null,
  versionMismatch: '扩展版本与页面不一致，请刷新页面后重试',
  reconnecting: '连接已断开，正在重连…',
  idle: null,
  expired: '连接已失效，请关闭小窗后重新点「问」',
};

export function FloatApp() {
  const [token] = useState(takeToken);
  const [state, dispatch] = useReducer(floatReducer, initialFloatState(token !== null));
  const [question, setQuestion] = useState('');
  const portRef = useRef<Port | null>(null);
  // 异步操作（loadSettings）resolve 之后要读最新状态，不能用闭包里那份
  const stateRef = useRef(state);
  stateRef.current = state;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // 小窗私有端口（恢复位置尺寸 / 收起，5.3）；与所在标签页的阅读器直连，不经后台
  const floatPortRef = useRef<Port | null>(null);
  // 所在窗口：加载时取好，点「转到侧边栏」时同步 open 要用（规则 10，点击处理里不能 await）
  const windowIdRef = useRef<number | null>(null);

  // 建端口：helloFloat（首次）或 resumeFloat（重连）
  const connect = (hello: ClientToBackground) => {
    const port = browser.runtime.connect({ name: CONV_PORT });
    portRef.current = port;
    port.onMessage.addListener((raw: BackgroundToClient) => dispatch({ kind: 'server', msg: raw }));
    port.onDisconnect.addListener(() => dispatch({ kind: 'disconnected' }));
    port.postMessage(hello);
  };

  /** 从 idle 唤醒重连；其余状态下是空操作（onWake 只在 idle 时改变状态） */
  const wake = () => dispatch({ kind: 'wake' });

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
      tryRestore();
    });

    void browser.tabs.getCurrent().then((tab) => {
      if (disposed || tab?.id === undefined) return;
      const p = browser.tabs.connect(tab.id, { name: FLOAT_PORT, frameId: 0 });
      port = p;
      floatPortRef.current = p;
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
    const ask = state.queuedAsk;
    if (!ask) return;
    portRef.current?.postMessage(
      buildAskMessage({
        clientRequestId: ask.clientRequestId,
        text: ask.text,
        quote: state.quote,
        lengthTier: ask.lengthTier,
        thinking: ask.thinking,
        model: ask.model,
        ...(ask.contextTier ? { contextTier: ask.contextTier } : {}),
      }),
    );
    dispatch({ kind: 'askSent', clientRequestId: ask.clientRequestId });
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
  const job = state.job;

  const handleSend = async () => {
    const text = question.trim();
    if (!text) return;
    if (generating) {
      dispatch({ kind: 'localError', message: '回答进行中' });
      return;
    }
    const defaults = await loadAskDefaults();
    if (!defaults.ok) {
      dispatch({ kind: 'localError', message: defaults.message });
      return;
    }
    const { lengthTier, thinking, contextTier, model } = defaults;
    const clientRequestId = crypto.randomUUID();
    if (stateRef.current.connPhase === 'ready') {
      portRef.current?.postMessage(
        buildAskMessage({
          clientRequestId,
          text,
          quote: stateRef.current.quote,
          lengthTier,
          thinking,
          model,
          contextTier,
        }),
      );
      dispatch({ kind: 'askSent', clientRequestId });
    } else {
      // 没就绪：先存成待发，等重连、订阅、收到这次 conv/snapshot 后再用当时最新的引用发出
      dispatch({
        kind: 'queueAsk',
        ask: { clientRequestId, text, lengthTier, thinking, model, contextTier },
      });
      wake();
    }
    setQuestion('');
  };

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
      dispatch({ kind: 'localError', message: '还没准备好，请稍后再点一次' });
      return;
    }
    void browser.sidePanel
      .open({ windowId })
      .catch(() =>
        dispatch({ kind: 'localError', message: '浏览器没有打开侧边栏，请点工具栏里的「阅读助手」图标' }),
      );
    // 没握手、握手失败、版本不对：没有转接可确认，只打开侧边栏（侧边栏跟着本标签页，引用照样带过去）
    const phase = stateRef.current.connPhase;
    if (phase === 'noToken' || phase === 'expired' || phase === 'versionMismatch') return;
    dispatch({ kind: 'handoffStarted' });
    wake();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!shouldSendOnEnter(e)) return;
    e.preventDefault();
    void handleSend();
  };

  const connMessage = CONN_MESSAGE[state.connPhase];
  // versionMismatch 重连也没用（得刷新页面），其余状态都允许输入：idle / connecting / reconnecting
  // 下用户可以照常打字、点发送，连接没就绪时会先存成待发（见 handleSend）
  const canType =
    state.connPhase !== 'noToken' && state.connPhase !== 'expired' && state.connPhase !== 'versionMismatch';

  return (
    <main style={{ width: '100%', boxSizing: 'border-box', padding: '8px', fontSize: '13px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 8px' }}>
        <span style={{ flex: '1', color: '#666' }}>{connMessage}</span>
        <button
          type="button"
          onClick={handleToPanel}
          disabled={state.handoff !== null && !state.handoff.slow}
        >
          转到侧边栏
        </button>
      </div>
      {state.handoff?.slow && (
        <p data-testid="handoff-hint" style={{ margin: '0 0 8px', color: '#999' }}>
          侧边栏还没有接上，小窗先留着；可以稍后再点一次
        </p>
      )}
      {state.quote && (
        <div style={{ margin: '0 0 8px', padding: '6px', background: '#f5f5f5', borderRadius: '4px' }}>
          <div style={{ maxHeight: '80px', overflow: 'auto', whiteSpace: 'pre-wrap', color: '#555' }}>
            {state.quote.text}
          </div>
          {state.quote.truncated && (
            <p style={{ margin: '4px 0 0', color: '#999' }}>
              选区过长，只发送了其中一部分（原文共 {state.quote.originalLength} 字）
            </p>
          )}
        </div>
      )}
      {canType && (
        <>
          <textarea
            ref={textareaRef}
            aria-label="输入问题"
            value={question}
            onInput={(e) => setQuestion((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
            onFocus={wake}
            style={{ width: '100%', boxSizing: 'border-box', minHeight: '60px', resize: 'vertical' }}
          />
          <div style={{ marginTop: '6px', textAlign: 'right' }}>
            {generating ? (
              <button type="button" onClick={handleStop}>
                停止
              </button>
            ) : (
              <button type="button" onClick={() => void handleSend()}>
                问
              </button>
            )}
          </div>
        </>
      )}
      {state.actionError && (
        <p style={{ margin: '6px 0 0', color: '#c33' }}>
          {state.actionError}
          {state.actionError === '请先在设置里添加连接' && (
            <button
              type="button"
              style={{ marginLeft: '6px' }}
              onClick={() => void browser.runtime.openOptionsPage()}
            >
              打开设置
            </button>
          )}
        </p>
      )}
      {job && <AnswerView job={job} onRetry={handleRetry} />}
    </main>
  );
}
