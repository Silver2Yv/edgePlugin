// 侧边栏（5.4、6.4，核心功能开发第二批扩成完整版）：每个窗口一个面板，显示本窗口当前活动标签页的对话；
// 跟随切换标签页与地址变化（监听器挂在面板自己身上，面板关着时不唤醒后台）。
// 界面（C1–C5）：顶部三个视图切换（对话 / 历史 / 收藏，Nav）→
//   对话视图：当前页信息（标题、可读取字数、本页对话切换）→ 整页快捷动作（C4）→ 一行提示 → 对话列表（含「存」）→ 输入区；
//   历史视图：按页面/网站分组、搜索、删除（HistoryView）；
//   收藏视图：列表、搜索、编辑、删除、导出（FavoritesView）。
// 样式与组件和小窗共用（theme.css、chat/），比小窗宽松一档；逻辑与小窗共用 float/state.ts 的归约器；
// 后台按本窗口授权（见 background/conv.ts）。历史/收藏的列表与搜索直接只读查询 IndexedDB（5.4），写入经后台，
// 用 panel/conv-ops.ts 的编号关联拿应答（history/query 可能分批、history/delete、favorite/update、favorite/remove）。
//
// 开关快捷键（5.4）：后台在命令处理里总是同步 open，并广播带命令时间的 sidepanel/toggle、同时记进 storage.session。
// 面板在那个时间之前就已存在，说明这次命令是「关」，自行 window.close()。先挂监听再读记录，两者之间不留空隙。
import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import { toPageKey } from '@/core/context/page-key';
import type { ActionId } from '@/core/domain/actions';
import {
  type BackgroundToClient,
  type BackgroundToPages,
  type ClientToBackground,
  CONV_PORT,
} from '@/core/domain/messages';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import { SUMMARIZE_PAGE_QUESTION } from '@/core/prompt/ask';
import { EXPAND_QUESTION, loadAskDefaults, NO_CONNECTION } from './ask-defaults';
import { type AskDeps, flushQueuedAsk, submitAsk, useComposerDefaults } from './chat/ask';
import { Composer } from './chat/Composer';
import { IconPlus } from './chat/Icons';
import { MessageList } from './chat/MessageList';
import { displayItems, latestPlan } from './float/messages';
import { pageInfo } from './float/send-summary';
import {
  buildAskMessage,
  type FloatState,
  favoriteAddMessage,
  floatReducer,
  initialPanelState,
  isGenerating,
  PANEL_NOTICE_TEXT,
  panelSubscribeMessage,
  shouldCloseOnToggle,
  switchConversationMessage,
} from './float/state';
import { ConversationSwitcher } from './panel/ConversationSwitcher';
import { createOpRegistry, type OpDeps } from './panel/conv-ops';
import { FavoritesView } from './panel/FavoritesView';
import { HistoryView } from './panel/HistoryView';
import { Nav, type PanelView } from './panel/Nav';
import { PageActions } from './panel/PageActions';
import { T } from './strings';
import './theme.css';

type Port = Browser.runtime.Port;

const CONN_MESSAGE: Readonly<Record<FloatState['connPhase'], string | null>> = {
  noToken: null,
  connecting: T.conn.panel.connecting,
  ready: null,
  versionMismatch: T.conn.panel.versionMismatch,
  reconnecting: T.conn.panel.reconnecting,
  idle: null,
  expired: T.conn.panel.expired,
};

export function SidePanelApp() {
  const [windowId, setWindowId] = useState<number | null>(null);
  const [state, dispatch] = useReducer(floatReducer, undefined, initialPanelState);
  const [question, setQuestion] = useState('');
  const [view, setView] = useState<PanelView>('chat');
  // 当前页标题与地址（C3、C2）：取自所订阅的标签页
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  // favorite/changed 广播到达次数：历史/收藏视图据此重新只读查询
  const [favRefreshSeq, setFavRefreshSeq] = useState(0);
  const defaults = useComposerDefaults();
  const portRef = useRef<Port | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const opRegistryRef = useRef(createOpRegistry());

  const wake = () => dispatch({ kind: 'wake' });
  const retarget = (tabId: number) => {
    dispatch({ kind: 'retarget', tabId });
    wake();
  };

  const askDeps: AskDeps = {
    getState: () => stateRef.current,
    post: (msg) => portRef.current?.postMessage(msg),
    dispatch,
    canSendNow: (s) => s.connPhase === 'ready' && s.targetConfirmed,
    wake,
  };

  const opDeps: OpDeps = {
    post: (msg: ClientToBackground) => portRef.current?.postMessage(msg),
    registry: opRegistryRef.current,
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
      if (m?.type === 'favorite/changed') {
        setFavRefreshSeq((n) => n + 1);
        return;
      }
      if (m?.type !== 'sidepanel/toggle' && m?.type !== 'sidepanel/wake') return;
      if (m.windowId !== windowId) return;
      if (m.type === 'sidepanel/toggle') check(m.at);
      // 后台有东西交给本窗口的侧边栏：断线闲着的就重连（重连后 hello 里取到待接的转接、订阅时取到说明）
      else wake();
    };
    browser.runtime.onMessage.addListener(onMessage);
    const key = SESSION_KEYS.sidepanelToggle(windowId);
    void browser.storage.session.get(key).then((r) => check(r[key]));
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [windowId]);

  const connect = (w: number) => {
    const port = browser.runtime.connect({ name: CONV_PORT });
    portRef.current = port;
    port.onMessage.addListener((raw: BackgroundToClient) => {
      // 历史查询 / 收藏编辑删除的应答先按编号分发给等待它的 Promise，再照常喂给归约器
      // （归约器对这些类型本就不处理，见 float/state.ts 的 default 分支）
      opRegistryRef.current.dispatch(raw);
      dispatch({ kind: 'server', msg: raw });
    });
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
    const onUpdated = (tabId: number, change: { url?: string; title?: string }, tab: Browser.tabs.Tab) => {
      if (change.url !== undefined && tab.active && tab.windowId === windowId) retarget(tabId);
      // 当前页标题变了（页面加载完、单页应用换页）：顶部的页面信息跟着换
      if (change.title !== undefined && tabId === stateRef.current.target) setPageTitle(change.title);
      if (change.url !== undefined && tabId === stateRef.current.target) setPageUrl(change.url);
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

  // 换了要显示的标签页：取它的标题与地址（C3、本页对话列表用地址算 pageKey）
  useEffect(() => {
    const tabId = state.target;
    if (tabId === null) return;
    let stale = false;
    setPageTitle(null);
    setPageUrl(null);
    void browser.tabs.get(tabId).then(
      (tab) => {
        if (!stale) {
          setPageTitle(tab.title ?? null);
          setPageUrl(tab.url ?? null);
        }
      },
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [state.target]);

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
    flushQueuedAsk(state, askDeps);
  }, [state.snapshotSeq]);

  useEffect(() => {
    const onFocus = () => wake();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const generating = isGenerating(state.job);

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

  /** 回答上的「存」（G3） */
  const handleSave = (conversationId: string, messageId: string) => {
    portRef.current?.postMessage(favoriteAddMessage(conversationId, messageId));
  };

  /** 整页快捷动作（C4）：总结本页 / 提取要点 / 这页在讲什么 / scope 为 page 的自定义动作 */
  const handlePageAction = async (actionId: ActionId, label: string) => {
    if (generating) return;
    const ask = await loadAskDefaults();
    if (!ask.ok) {
      dispatch({ kind: 'localError', message: ask.message });
      return;
    }
    const clientRequestId = crypto.randomUUID();
    const text = actionId === 'summarizePage' ? SUMMARIZE_PAGE_QUESTION : label;
    portRef.current?.postMessage(
      buildAskMessage({
        clientRequestId,
        text,
        quote: null,
        conversationId: state.conversationId,
        fresh: state.freshConversation,
        lengthTier: ask.lengthTier,
        thinking: ask.thinking,
        model: ask.model,
        contextTier: 'fullPage',
        actionId,
      }),
    );
    dispatch({ kind: 'askSent', clientRequestId, text, quote: null });
  };

  /** 本页对话列表（C2）/ 历史里点开一条：切换到那个对话；续问是否允许由后台按页面归属判定 */
  const handleOpenConversation = (conversationId: string) => {
    const msg = switchConversationMessage(state, conversationId);
    if (!msg) return;
    dispatch({ kind: 'switchConversation', conversationId });
    portRef.current?.postMessage(msg);
    setView('chat');
  };

  const connMessage = CONN_MESSAGE[state.connPhase];
  const pageKeyOfTab = pageUrl ? (toPageKey(pageUrl) ?? null) : null;
  // 跨页对话（C2）：订阅到的对话属于别的页面——只能看，续问请回到那一页（后台 conv/ask 也会拒绝 notOwner）
  const isCrossPage =
    state.conversationId !== null &&
    state.conversationPageKey !== null &&
    pageKeyOfTab !== null &&
    state.conversationPageKey !== pageKeyOfTab;
  const canType = state.connPhase !== 'expired' && state.connPhase !== 'versionMismatch' && !isCrossPage;
  const noticeText = state.notice ? PANEL_NOTICE_TEXT[state.notice] : null;
  const hasConversation = state.conversationId !== null || state.messages.length > 0 || state.job !== null;

  // 当前页信息（C3）：能读取的字数、有没有截断，取自最近一次请求的发送计划
  const info = pageInfo(latestPlan(state.messages, state.job));
  const pageMeta = info
    ? [
        info.readableChars === null ? null : T.page.readable(info.readableChars),
        info.notRead ? T.page.notRead : null,
        info.truncated === null ? null : info.truncated ? T.page.truncated : T.page.complete,
      ].filter((p): p is string => p !== null)
    : [];

  return (
    <main className="ra-app ra-app--panel">
      <Nav view={view} onChange={setView} />
      {view === 'history' && (
        <HistoryView deps={opDeps} pageKey={pageKeyOfTab} onOpen={handleOpenConversation} />
      )}
      {view === 'favorites' && (
        <FavoritesView deps={opDeps} pageKey={pageKeyOfTab} refreshSeq={favRefreshSeq} />
      )}
      {view === 'chat' && (
        <>
          <header className="ra-header">
            <div className="ra-page">
              <div className="ra-page__title" data-testid="page-title" title={pageTitle ?? undefined}>
                {pageTitle || T.page.untitled}
              </div>
              {/* 「上次总结的时间」（C3）下一轮接：有了就接在这一行后面（T.page.lastSummary） */}
              {pageMeta.length > 0 && (
                <div className="ra-page__meta" data-testid="page-meta">
                  {pageMeta.join(' · ')}
                </div>
              )}
            </div>
            <ConversationSwitcher
              deps={opDeps}
              pageKey={pageKeyOfTab}
              currentConversationId={state.conversationId}
              disabled={generating}
              onSelect={handleOpenConversation}
            />
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
          </header>
          <PageActions onAsk={(id, label) => void handlePageAction(id, label)} disabled={generating} />
          <div className="ra-notes">
            {noticeText && (
              <p data-testid="panel-notice" className="ra-note">
                {noticeText}
                {state.notice === 'noConnection' && (
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
            {connMessage && <p className="ra-note">{connMessage}</p>}
            {state.convHint === 'newConversation' && (
              <p data-testid="conv-hint" className="ra-note">
                {T.notice.newConversationStarted}
              </p>
            )}
            {isCrossPage && (
              <p data-testid="cross-page-notice" className="ra-note">
                {T.notice.crossPageConversation}
              </p>
            )}
          </div>
          <MessageList
            items={displayItems(state.messages, state.job)}
            emptyText={canType ? T.list.emptyPanel : ''}
            generating={generating}
            onRetry={handleRetry}
            onExpand={handleExpand}
            conversationId={state.conversationId}
            favorited={state.savedMessageIds}
            onSave={handleSave}
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
              thinkingChanged={
                state.thinkingOverride !== null && state.thinkingOverride !== defaults.thinking
              }
              onTier={(contextTier) => dispatch({ kind: 'setTier', contextTier })}
              onThinking={(thinking) => dispatch({ kind: 'setThinking', thinking })}
              model={defaults.model}
            />
          )}
        </>
      )}
    </main>
  );
}
