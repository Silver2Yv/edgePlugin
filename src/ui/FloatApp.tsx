// 小窗（5.3）：从地址片段取令牌握手、订阅对话、发问、逐字渲染增量，断线后自动重连（5.5）。
// 回答区的 Markdown/公式/高亮/引用渲染交给 src/ui/render（5.10）；对话内容只用文本节点或
// 该模块产出的 DOM 渲染，不经过 window.postMessage（规则 4、5）。
//
// 拖动 / 缩放不在这里处理：V-12 实测发现 iframe 内指针捕获一旦移出 iframe 渲染区域（缩放拖出、
// 大幅拖动都会立刻发生）就收不到后续 pointermove，这是 pointer capture 跨 iframe 边界的已知限制
// （不是实现 bug），按 5.3 原文的退路改为宿主侧不可见把手直接处理（page/float-host.ts）。
// 这里只做两件事：连接时按持久化设置回放一次记忆的位置/尺寸；收到手势结束后的最终 rect 时落盘。
import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import { canRetry, isTerminal } from '@/core/domain/job';
import {
  type BackgroundToClient,
  type ClientToBackground,
  CONV_PORT,
  FLOAT_PORT,
  type FloatToReader,
  type ReaderToFloat,
} from '@/core/domain/messages';
import { loadSettings, SETTINGS_KEY } from '@/platform/settings-store';
import { ERROR_LABEL } from './error-labels';
import {
  buildAskMessage,
  type FloatRectValue,
  type FloatState,
  floatReducer,
  initialFloatState,
  isGenerating,
  parseTokenFromHash,
  restoreCommandsOnConnect,
  shouldSendOnEnter,
  subscribeMessage,
  waitHintText,
} from './float/state';
import './float/wait-hint.css';
import { type AnswerRenderer, createAnswerRenderer } from './render';

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

/** 把提示文案里的省略号包一层 span 做闪烁动画（wait-hint.css），其余文字原样显示 */
function renderWaitHint(text: string) {
  const idx = text.indexOf('…');
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="wait-hint__dots">…</span>
      {text.slice(idx + 1)}
    </>
  );
}

export function FloatApp() {
  const [token] = useState(takeToken);
  const [state, dispatch] = useReducer(floatReducer, initialFloatState(token !== null));
  const [question, setQuestion] = useState('');
  const portRef = useRef<Port | null>(null);
  // 异步操作（loadSettings）resolve 之后要读最新状态，不能用闭包里那份
  const stateRef = useRef(state);
  stateRef.current = state;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const answerRef = useRef<HTMLDivElement | null>(null);
  const answerRendererRef = useRef<AnswerRenderer | null>(null);
  // 小窗私有端口（恢复位置尺寸 / 收起，5.3）；与所在标签页的阅读器直连，不经后台
  const floatPortRef = useRef<Port | null>(null);

  /** 回答容器挂载后才能创建渲染器；懒创建，同一个容器只创建一次 */
  const getAnswerRenderer = (): AnswerRenderer | null => {
    if (answerRendererRef.current) return answerRendererRef.current;
    if (!answerRef.current) return null;
    answerRendererRef.current = createAnswerRenderer(answerRef.current);
    return answerRendererRef.current;
  };

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

  // 焦点在小窗里时按 Esc 收起（经私有端口；焦点在网页别处时由阅读器自己的 keydown 监听处理）
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.isTrusted && e.key === 'Escape') {
        floatPortRef.current?.postMessage({ type: 'float/collapse' } satisfies FloatToReader);
      }
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
  const allowedCitationIds = useMemo(() => new Set(job?.sentBlockIds ?? []), [job?.sentBlockIds]);

  // 等待提示（小窗回答区持续反馈，纯函数见 float/state.ts 的 waitHintText）：askStartedAtRef 记发问/
  // 重试开始的时间，lastDeltaAtRef 记最近一次收到正文/思考增量的时间；1 秒定时器只用来驱动重渲染，
  // 真正的时间判断在渲染时用 Date.now() 现算，任务到终态时 waitHintText 立即返回 null
  const askStartedAtRef = useRef<number | null>(null);
  const lastDeltaAtRef = useRef<number | null>(null);
  const [, bumpWaitTick] = useState(0);

  // 新任务 / 新尝试：清空回答区重新开始（job.jobId 或 attemptId 变化），同时重新起算等待计时
  useEffect(() => {
    const now = Date.now();
    askStartedAtRef.current = job ? now : null;
    lastDeltaAtRef.current = job ? now : null;
    getAnswerRenderer()?.reset();
  }, [job?.jobId, job?.attemptId]);

  // 收到正文或思考的新增量：刷新「距上次增量过去多久」的参照点
  useEffect(() => {
    if (!job) return;
    lastDeltaAtRef.current = Date.now();
  }, [job?.text, job?.reasoning]);

  // 任务进行中才跑定时器；到终态或没有任务时停表（清掉 interval）
  useEffect(() => {
    if (!job || isTerminal(job.state)) return;
    const timer = setInterval(() => bumpWaitTick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [job?.jobId, job?.attemptId, job?.state]);

  const waitHint = job
    ? waitHintText({
        elapsedMs: askStartedAtRef.current ? Date.now() - askStartedAtRef.current : 0,
        hasAnswerText: job.text.length > 0,
        hasReasoningText: job.reasoning.length > 0,
        msSinceLastDelta: lastDeltaAtRef.current ? Date.now() - lastDeltaAtRef.current : 0,
        jobState: job.state,
      })
    : null;

  // 增量更新：走节流调度（rAF 合并同帧更新；超长回答降到至少 200ms 一次），终态交给下面那条 finalize
  useEffect(() => {
    if (!job || isTerminal(job.state)) return;
    getAnswerRenderer()?.scheduleUpdate(job.text, allowedCitationIds);
  }, [job?.text, job?.state, allowedCitationIds]);

  // 到达终态：立即做一次完整校正（流式阶段可能遗留的前向引用等在这里被纠正）
  useEffect(() => {
    if (!job || !isTerminal(job.state)) return;
    getAnswerRenderer()?.finalize(job.text, allowedCitationIds);
  }, [job?.state, job?.text, allowedCitationIds]);

  // 组件卸载：移除渲染器的 selectionchange 监听
  useEffect(() => () => answerRendererRef.current?.destroy(), []);

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
    const contextTier = settings.context.defaultTier;
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
      {connMessage && <p style={{ margin: '0 0 8px', color: '#666' }}>{connMessage}</p>}
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
      {job && (
        <div style={{ marginTop: '8px' }}>
          <div data-testid="job-state" style={{ color: '#999' }}>
            {job.state}
          </div>
          {job.reasoning && (
            <details style={{ marginTop: '4px' }}>
              <summary>思考过程</summary>
              <div style={{ whiteSpace: 'pre-wrap', color: '#777' }}>{job.reasoning}</div>
            </details>
          )}
          {/* 子节点完全由 src/ui/render（createAnswerRenderer）管理，这里不写 children，
              Preact 不会对它做子节点 diff（见模块顶部注释与 render/mount.ts） */}
          <div ref={answerRef} data-testid="answer" style={{ marginTop: '4px' }} />
          {waitHint && (
            <p data-testid="wait-hint" aria-live="polite" style={{ margin: '4px 0 0', color: '#999' }}>
              {renderWaitHint(waitHint)}
            </p>
          )}
          {job.state === 'failed' && job.error && (
            <p style={{ margin: '4px 0 0', color: '#c33' }}>
              {ERROR_LABEL[job.error.kind]}
              {job.error.message && `：${job.error.message}`}
            </p>
          )}
          {job.state === 'interrupted' && (
            <p style={{ margin: '4px 0 0', color: '#999' }}>上次请求的结果未知，重试可能重新计费</p>
          )}
          {canRetry(job.state) && (
            <button type="button" style={{ marginTop: '4px' }} onClick={handleRetry}>
              重试
            </button>
          )}
        </div>
      )}
    </main>
  );
}
