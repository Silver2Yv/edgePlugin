// 侧边栏最小版（5.4、6.4）：每个窗口一个面板，显示本窗口当前活动标签页的对话；跟随切换标签页与地址变化
// （监听器挂在面板自己身上，面板关着时不唤醒后台）。内容：顶部说明、引用条、输入框、回答、停止 / 重试、等待提示。
// 逻辑与小窗共用 float/state.ts 的归约器；后台按本窗口授权（见 background/conv.ts）。
//
// 开关快捷键（5.4）：后台在命令处理里总是同步 open，并广播带命令时间的 sidepanel/toggle、同时记进 storage.session。
// 面板在那个时间之前就已存在，说明这次命令是「关」，自行 window.close()。先挂监听再读记录，两者之间不留空隙。
// 历史、收藏、引用跳回、样式打磨不在这一版。
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import {
  type BackgroundToClient,
  type BackgroundToPages,
  type ClientToBackground,
  CONV_PORT,
} from '@/core/domain/messages';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import { AnswerView } from './AnswerView';
import { loadAskDefaults, NO_CONNECTION } from './ask-defaults';
import {
  buildAskMessage,
  type FloatState,
  floatReducer,
  initialPanelState,
  isGenerating,
  PANEL_NOTICE_TEXT,
  panelSubscribeMessage,
  shouldCloseOnToggle,
  shouldSendOnEnter,
} from './float/state';

type Port = Browser.runtime.Port;

const CONN_MESSAGE: Readonly<Record<FloatState['connPhase'], string | null>> = {
  noToken: null,
  connecting: '连接中…',
  ready: null,
  versionMismatch: '扩展版本已更新，请关闭侧边栏后重新打开',
  reconnecting: '连接已断开，正在重连…',
  idle: null,
  expired: '连接已失效，请关闭侧边栏后重新打开',
};

export function SidePanelApp() {
  const [windowId, setWindowId] = useState<number | null>(null);
  const [state, dispatch] = useReducer(floatReducer, undefined, initialPanelState);
  const [question, setQuestion] = useState('');
  const portRef = useRef<Port | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const wake = () => dispatch({ kind: 'wake' });
  const retarget = (tabId: number) => {
    dispatch({ kind: 'retarget', tabId });
    wake();
  };

  useEffect(() => {
    void browser.windows.getCurrent().then((w) => {
      if (w.id !== undefined) setWindowId(w.id);
    });
  }, []);

  // 开关快捷键：命令时间晚于本面板的创建时间，就是「关」（见文件头）
  useEffect(() => {
    if (windowId === null) return;
    const createdAt = performance.timeOrigin;
    const check = (at: unknown) => {
      if (typeof at === 'number' && shouldCloseOnToggle(createdAt, at)) window.close();
    };
    const onMessage = (raw: unknown, sender: Browser.runtime.MessageSender) => {
      if (sender.id !== browser.runtime.id || sender.tab !== undefined) return;
      const m = raw as Partial<BackgroundToPages> | undefined;
      if (m?.type === 'sidepanel/toggle' && m.windowId === windowId) check(m.at);
    };
    browser.runtime.onMessage.addListener(onMessage);
    const key = SESSION_KEYS.sidepanelToggle(windowId);
    void browser.storage.session.get(key).then((r) => check(r[key]));
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [windowId]);

  const connect = (w: number) => {
    const port = browser.runtime.connect({ name: CONV_PORT });
    portRef.current = port;
    port.onMessage.addListener((raw: BackgroundToClient) => dispatch({ kind: 'server', msg: raw }));
    port.onDisconnect.addListener(() => dispatch({ kind: 'disconnected' }));
    port.postMessage({ type: 'conv/helloSidepanel', windowId: w } satisfies ClientToBackground);
  };

  useEffect(() => {
    if (windowId !== null) connect(windowId);
  }, [windowId]);

  // 跟随本窗口的活动标签页：切换标签页、活动标签页的地址变化都重新订阅
  useEffect(() => {
    if (windowId === null) return;
    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (info.windowId === windowId) retarget(info.tabId);
    };
    const onUpdated = (tabId: number, change: { url?: string }, tab: Browser.tabs.Tab) => {
      if (change.url !== undefined && tab.active && tab.windowId === windowId) retarget(tabId);
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    void browser.tabs.query({ active: true, windowId }).then(([t]) => {
      if (t?.id !== undefined && stateRef.current.target === null) retarget(t.id);
    });
    return () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [windowId]);

  // 小窗转来的对话（handoff/pending）：带着转接编号订阅那个标签页，后台据此让小窗收起
  useEffect(() => {
    const h = state.incomingHandoff;
    if (h) dispatch({ kind: 'retarget', tabId: h.tabId, handoff: h });
  }, [state.incomingHandoff]);

  // 握手完成、或换了订阅：发 conv/subscribe；断线有任务在跑就重连（重连后 helloSidepanel 再订一次）
  useEffect(() => {
    if (state.connPhase === 'ready') {
      const msg = panelSubscribeMessage(state);
      if (msg) portRef.current?.postMessage(msg);
    } else if (state.connPhase === 'reconnecting' && windowId !== null) {
      connect(windowId);
    }
  }, [state.connPhase, state.targetSeq]);

  // 重连并订阅完之后：发出未就绪时存下的待发问
  useEffect(() => {
    const ask = state.queuedAsk;
    if (!ask) return;
    portRef.current?.postMessage(
      buildAskMessage({
        clientRequestId: ask.clientRequestId,
        text: ask.text,
        quote: state.quote,
        conversationId: state.conversationId,
        lengthTier: ask.lengthTier,
        thinking: ask.thinking,
        model: ask.model,
        ...(ask.contextTier ? { contextTier: ask.contextTier } : {}),
      }),
    );
    dispatch({ kind: 'askSent', clientRequestId: ask.clientRequestId });
  }, [state.snapshotSeq]);

  useEffect(() => {
    const onFocus = () => wake();
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
    const s = stateRef.current;
    if (s.connPhase === 'ready' && s.targetConfirmed) {
      portRef.current?.postMessage(
        buildAskMessage({
          clientRequestId,
          text,
          quote: s.quote,
          conversationId: s.conversationId,
          lengthTier,
          thinking,
          model,
          contextTier,
        }),
      );
      dispatch({ kind: 'askSent', clientRequestId });
    } else {
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

  const onKeyDown = (e: KeyboardEvent) => {
    if (!shouldSendOnEnter(e)) return;
    e.preventDefault();
    void handleSend();
  };

  const connMessage = CONN_MESSAGE[state.connPhase];
  const canType = state.connPhase !== 'expired' && state.connPhase !== 'versionMismatch';
  const noticeText = state.notice ? PANEL_NOTICE_TEXT[state.notice] : null;

  return (
    <main
      style={{
        boxSizing: 'border-box',
        padding: '12px',
        fontSize: '13px',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {noticeText && (
        <p data-testid="panel-notice" style={{ margin: '0 0 8px', color: '#888', fontSize: '12px' }}>
          {noticeText}
          {state.notice === 'noConnection' && (
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
      {connMessage && <p style={{ margin: '0 0 8px', color: '#666' }}>{connMessage}</p>}
      {state.quote && (
        <div
          data-testid="quote"
          style={{ margin: '0 0 8px', padding: '6px', background: '#f5f5f5', borderRadius: '4px' }}
        >
          <div style={{ maxHeight: '120px', overflow: 'auto', whiteSpace: 'pre-wrap', color: '#555' }}>
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
            aria-label="输入问题"
            value={question}
            onInput={(e) => setQuestion((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
            onFocus={wake}
            style={{ width: '100%', boxSizing: 'border-box', minHeight: '72px', resize: 'vertical' }}
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
        <p data-testid="action-error" style={{ margin: '6px 0 0', color: '#c33' }}>
          {state.actionError}
          {state.actionError === NO_CONNECTION && (
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
