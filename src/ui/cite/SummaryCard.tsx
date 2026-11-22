// 「总结本页」完整版的界面部分（6.2、I6、验收第 8 条），小窗与侧边栏共用：
// | 何时取 | 每次订阅的初始推送收完（打开、重连、侧边栏换标签页）、看着答完一次页面级总结之后：发 summary/get |
// | 何时显示 | 这一页有上次的总结，且正在显示的对话是空的（还没发问、点了新对话）；用户刚点「总结本页」而后台直接复用了它（show）时，不论对话空不空都摆到列表最上面 |
// | 版本 | 后台核对过总结所基于的内容版本：不一致标「基于旧版本」，不冒充当前全文（5.6 页面变化）；核对不了标「未核对版本」 |
// | 重新总结 | 发一次新的 conv/ask（summarizePage、带全文、新对话），会花钱，所以只在用户点按钮时发 |
// 卡片里的要点照常渲染引用，点了跳回原文（F3，复用引用跳回）。
import { useEffect, useRef, useState } from 'preact/hooks';
import type { BackgroundToClient, ClientToBackground, LastSummary } from '@/core/domain/messages';
import { SUMMARIZE_PAGE_QUESTION } from '@/core/prompt/ask';
import { AnswerView } from '../AnswerView';
import { loadAskDefaults } from '../ask-defaults';
import type { AskDeps } from '../chat/ask';
import { type AnswerLike, type MessageView, recordToView } from '../float/messages';
import { type FloatState, isGenerating } from '../float/state';
import { T } from '../strings';
import type { CitationClick } from './useCite';

const pad = (n: number) => String(n).padStart(2, '0');

/** 总结时间：今天的只写时分，别的日子写几月几日 */
export function summaryTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString()
    ? T.summary.today(hm)
    : T.summary.date(d.getMonth() + 1, d.getDate(), hm);
}

export interface Shown {
  tabId: number;
  summary: LastSummary;
}

/**
 * 卡片显示不显示。target：侧边栏订阅的标签页（小窗为 null，不比较）；forced：用户刚点了「总结本页」、后台复用了上次的
 */
export function summaryCardVisible(
  shown: Shown | null,
  forced: boolean,
  state: Pick<FloatState, 'target' | 'messages' | 'job' | 'pendingAsk'>,
): shown is Shown {
  if (!shown) return false;
  if (state.target !== null && shown.tabId !== state.target) return false;
  const id = shown.summary.message.id;
  // 正在显示的对话里已经有这条总结：不重复
  if (state.job?.messageId === id || state.messages.some((m: MessageView) => m.id === id)) return false;
  const empty = state.messages.length === 0 && state.job === null && state.pendingAsk === null;
  return empty || forced;
}

export interface SummaryDeps {
  post: (msg: ClientToBackground) => void;
  canSendNow: () => boolean;
}

/** resetKey 变了（侧边栏换标签页）就清掉；jobId 变了（开始了新任务）就不再强制显示 */
export function useLastSummary(deps: SummaryDeps, resetKey: string, jobId: string | null) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [forced, setForced] = useState(false);
  const current = useRef<string | null>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    current.current = null;
    setShown(null);
    setForced(false);
  }, [resetKey]);

  useEffect(() => setForced(false), [jobId]);

  const api = useRef({
    request(): void {
      if (!depsRef.current.canSendNow()) return;
      const requestId = crypto.randomUUID();
      current.current = requestId;
      depsRef.current.post({ type: 'summary/get', requestId });
    },
    onMessage(msg: BackgroundToClient): void {
      if (msg.type !== 'summary/last') return;
      // 应答只认最近一次的；后台主动推的（复用上次总结）不带编号
      if (msg.requestId !== undefined && msg.requestId !== current.current) return;
      setShown(msg.summary ? { tabId: msg.tabId, summary: msg.summary } : null);
      if (msg.show && msg.summary) setForced(true);
    },
  }).current;

  return { shown, forced, ...api };
}

/** 「重新总结」：新对话里发一次整页总结（与工具栏「总结本页」同样的动作与档位） */
export async function resummarize(deps: AskDeps): Promise<void> {
  if (isGenerating(deps.getState().job)) {
    deps.dispatch({ kind: 'localError', message: T.error.generating });
    return;
  }
  const defaults = await loadAskDefaults();
  if (!defaults.ok) {
    deps.dispatch({ kind: 'localError', message: defaults.message });
    return;
  }
  const s = deps.getState();
  if (!deps.canSendNow(s)) {
    deps.wake();
    deps.dispatch({ kind: 'localError', message: T.error.notReady });
    return;
  }
  const clientRequestId = crypto.randomUUID();
  deps.post({
    type: 'conv/ask',
    clientRequestId,
    fresh: true,
    actionId: 'summarizePage',
    text: SUMMARIZE_PAGE_QUESTION,
    contextTier: 'fullPage',
    lengthTier: defaults.lengthTier,
    thinking: s.thinkingOverride ?? defaults.thinking,
    model: defaults.model,
  });
  deps.dispatch({ kind: 'askSent', clientRequestId, text: SUMMARIZE_PAGE_QUESTION, quote: null });
}

const noop = () => undefined;

export function SummaryCard({
  summary,
  forced,
  onCitation,
  onResummarize,
}: {
  summary: LastSummary;
  forced: boolean;
  onCitation: (messageId: string, c: CitationClick) => void;
  onResummarize: () => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const { message, current } = summary;
  const view = recordToView(message) as AnswerLike;

  // 用户刚点「总结本页」、后台复用了上次的：把卡片滚到眼前（列表里可能还有别的对话）
  useEffect(() => {
    if (forced) ref.current?.scrollIntoView({ block: 'start' });
  }, [forced, message.id]);

  return (
    <section ref={ref} className="ra-summary-card" data-testid="summary-card">
      <div className="ra-summary-card__head">
        <span className="ra-summary-card__title">{T.page.lastSummary(summaryTime(message.updatedAt))}</span>
        {current === 'changed' && (
          <span className="ra-badge ra-badge--warn" data-testid="summary-stale" title={T.summary.staleTitle}>
            {T.summary.stale}
          </span>
        )}
        {current === 'unknown' && (
          <span className="ra-badge" title={T.summary.unknownTitle}>
            {T.summary.unknown}
          </span>
        )}
        <button
          type="button"
          className="ra-btn ra-btn--small ra-summary-card__redo"
          title={T.summary.resummarizeTitle}
          onClick={onResummarize}
        >
          {T.summary.resummarize}
        </button>
      </div>
      {current === 'changed' && <p className="ra-summary-card__stale">{T.summary.staleNote}</p>}
      <AnswerView
        view={view}
        live={false}
        selectedChars={null}
        canExpand={false}
        onRetry={noop}
        onExpand={noop}
        onCitation={(c) => onCitation(message.id, c)}
      />
    </section>
  );
}
