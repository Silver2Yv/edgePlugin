// 小窗（5.3）：从地址片段取令牌握手、订阅对话、发问、逐字渲染增量，断线后自动重连（5.5）。
// 对话内容只用文本节点渲染（规则 5）；只和后台通信，不做数据库写入。
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import { type BackgroundToClient, type ClientToBackground, CONV_PORT } from '@/core/domain/messages';
import { loadSettings } from '@/platform/settings-store';
import { ERROR_LABEL } from './error-labels';
import {
  buildAskMessage,
  type FloatState,
  floatReducer,
  initialFloatState,
  isGenerating,
  parseTokenFromHash,
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
      }),
    );
    dispatch({ kind: 'askSent', clientRequestId: ask.clientRequestId });
  }, [state.snapshotSeq]);

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

  const handleSend = async () => {
    const text = question.trim();
    if (!text) return;
    if (generating) {
      dispatch({ kind: 'localError', message: '回答进行中' });
      return;
    }
    const result = await loadSettings();
    if (!result.ok) {
      dispatch({ kind: 'localError', message: '请先在设置里添加连接' });
      return;
    }
    const { settings } = result;
    if (settings.defaultModel === undefined) {
      dispatch({ kind: 'localError', message: '请先在设置里添加连接' });
      return;
    }
    const { lengthTier, thinking } = settings.reply;
    const model = settings.defaultModel;
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
        }),
      );
      dispatch({ kind: 'askSent', clientRequestId });
    } else {
      // 没就绪：先存成待发，等重连、订阅、收到这次 conv/snapshot 后再用当时最新的引用发出
      dispatch({ kind: 'queueAsk', ask: { clientRequestId, text, lengthTier, thinking, model } });
      wake();
    }
    setQuestion('');
  };

  const handleStop = () => {
    if (!state.job) return;
    portRef.current?.postMessage({ type: 'conv/stop', jobId: state.job.jobId } satisfies ClientToBackground);
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
  const job = state.job;

  return (
    <main style={{ width: 380, boxSizing: 'border-box', padding: 8, fontSize: 13 }}>
      {connMessage && <p style={{ margin: '0 0 8px', color: '#666' }}>{connMessage}</p>}
      {state.quote && (
        <div style={{ margin: '0 0 8px', padding: 6, background: '#f5f5f5', borderRadius: 4 }}>
          <div style={{ maxHeight: 80, overflow: 'auto', whiteSpace: 'pre-wrap', color: '#555' }}>
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
            style={{ width: '100%', boxSizing: 'border-box', minHeight: 60, resize: 'vertical' }}
          />
          <div style={{ marginTop: 6, textAlign: 'right' }}>
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
              style={{ marginLeft: 6 }}
              onClick={() => void browser.runtime.openOptionsPage()}
            >
              打开设置
            </button>
          )}
        </p>
      )}
      {job && (
        <div style={{ marginTop: 8 }}>
          <div data-testid="job-state" style={{ color: '#999' }}>
            {job.state}
          </div>
          {job.reasoning && (
            <details style={{ marginTop: 4 }}>
              <summary>思考过程</summary>
              <div style={{ whiteSpace: 'pre-wrap', color: '#777' }}>{job.reasoning}</div>
            </details>
          )}
          <div data-testid="answer" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
            {job.text}
          </div>
          {job.state === 'failed' && job.error && (
            <p style={{ margin: '4px 0 0', color: '#c33' }}>
              {ERROR_LABEL[job.error.kind]}
              {job.error.message && `：${job.error.message}`}
            </p>
          )}
        </div>
      )}
    </main>
  );
}
