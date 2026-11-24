// 引用跳回原文（F1、F2、5.7）与回到刚才的位置（F4）的界面部分，小窗与侧边栏共用：
// 点回答里的引用 → citation/locate（后台核对编号、算锚点、让网页定位并高亮）→ citation/located → 一行结果说明；
// 定位成功后给一次「回到刚才阅读的位置」（citation/back）。连接没就绪时先存着，订阅完成后再发。
// 一处标了多个编号（【12,5】）时循环跳转（决策 097，cycle.ts），说明里写「第 2 / 3 处」。
// 回到某一页（决策 098，仅侧边栏）：jump/open → jump/result；到了新标签页后由 onJumped 让面板改订阅并显示对话。
// 结果说明放在提示区（.ra-notes），不进对话列表；换任务、换标签页时清掉（跳转自己引起的换标签页除外）。
import { useEffect, useRef, useState } from 'preact/hooks';
import type { BackgroundToClient, CitationFailReason, ClientToBackground } from '@/core/domain/messages';
import { T } from '../strings';
import { type CycleState, cycleStep } from './cycle';

/**
 * 回答里被点的引用：编号（【12】的 12），逐字引用再带上原文。
 * 要点编号【12,5】带上全部编号 ids 与它在回答里是第几个引用标记 slot，由 useCite 决定这一次跳哪个
 */
export interface CitationClick {
  citation: string;
  quote?: string;
  ids?: readonly string[];
  slot?: number;
}

type Level = Extract<BackgroundToClient, { type: 'citation/located' }>['level'];

export interface CiteView {
  requestId: string;
  pending: boolean;
  level?: Level;
  reason?: CitationFailReason;
  back: boolean;
  /** 一处多个编号时这次跳的是第几处（决策 097） */
  position?: { index: number; total: number };
  /** 正在打开页面（跳回别的页面，决策 098） */
  opening?: boolean;
}

/** 回到某一页的目标：页面的对话给 pageKey，收藏给 favoriteId；地址由后台从库里取 */
export type JumpTarget = { pageKey: string } | { favoriteId: string };

/** 回到某一页之后要界面接着做的事 */
export interface JumpOptions {
  /** 到了之后侧边栏要显示的对话 */
  conversationId?: string;
  /** 这次跳转没有锚点也不算问题（收藏只有来源对话）：不显示「没有记下原文位置」 */
  quiet?: boolean;
}

export interface CiteDeps {
  post: (msg: ClientToBackground) => void;
  /** 现在能不能直接发（连接已就绪；侧边栏还要求订阅已确认） */
  canSendNow: () => boolean;
  wake: () => void;
  /** 回到某一页成功、已在 tabId 这个标签页（仅侧边栏） */
  onJumped?: (tabId: number, options: JumpOptions) => void;
}

/** 结果说明的文案 */
export function citeNoteText(c: CiteView): string {
  const text = c.pending
    ? c.opening
      ? T.cite.opening
      : T.cite.locating
    : c.level === 'exact'
      ? T.cite.exact
      : c.level === 'fuzzy' || c.level === 'scroll'
        ? T.cite.approx
        : T.cite.fail[c.reason ?? 'notFound'];
  return c.position ? `${T.cite.position(c.position.index, c.position.total)}：${text}` : text;
}

/** 回到某一页自己引起的换标签页，在这么久内不清掉结果说明 */
const LANDING_MS = 2_000;

/**
 * resetKey 变了（换了任务、换了标签页）就清掉上一次的结果。onMessage 要挂到对话端口上（每条推送都调一次），
 * flush 在订阅完成后调（发出连接没就绪时存下的那次定位）
 */
export function useCite(deps: CiteDeps, resetKey: string) {
  const [cite, setCite] = useState<CiteView | null>(null);
  const current = useRef<string | null>(null);
  const queued = useRef<ClientToBackground | null>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;
  /** 多编号引用上一次点的是哪一处 */
  const cycle = useRef<CycleState | null>(null);
  /** 当前这次定位的「第几处」，定位结果回来时带上 */
  const position = useRef<{ requestId: string; index: number; total: number } | null>(null);
  /** 在途的回到某一页，以及刚到达的那个标签页（见 LANDING_MS） */
  const jumping = useRef<{ requestId: string; options: JumpOptions } | null>(null);
  const landing = useRef<{ tabId: number; until: number } | null>(null);

  useEffect(() => {
    cycle.current = null;
    // 回到某一页会换标签页、换订阅：这是它自己引起的，别把正在显示的说明清掉
    const l = landing.current;
    if (jumping.current || (l && Date.now() < l.until && resetKey.startsWith(`${l.tabId}:`))) return;
    current.current = null;
    queued.current = null;
    setCite(null);
  }, [resetKey]);

  const send = (msg: ClientToBackground): void => {
    if (depsRef.current.canSendNow()) depsRef.current.post(msg);
    else {
      queued.current = msg;
      depsRef.current.wake();
    }
  };

  const positionOf = (requestId: string): { position?: { index: number; total: number } } =>
    position.current?.requestId === requestId
      ? { position: { index: position.current.index, total: position.current.total } }
      : {};

  const api = useRef({
    locate(messageId: string, c: CitationClick): void {
      const step = cycleStep(cycle.current, {
        messageId,
        slot: c.slot,
        ids: c.ids ?? [c.citation],
      });
      if (!step) return;
      cycle.current = step.next;
      const requestId = crypto.randomUUID();
      const msg: ClientToBackground = {
        type: 'citation/locate',
        requestId,
        messageId,
        citation: step.citation,
        ...(c.quote ? { quote: c.quote } : {}),
      };
      current.current = requestId;
      jumping.current = null;
      position.current = step.total > 1 ? { requestId, index: step.index, total: step.total } : null;
      setCite({ requestId, pending: true, back: false, ...positionOf(requestId) });
      send(msg);
    },
    /** 回到某一页（决策 098）：页面的对话的「回到那一页」、收藏的「回到原文」 */
    jump(target: JumpTarget, options: JumpOptions = {}): void {
      const requestId = crypto.randomUUID();
      current.current = requestId;
      jumping.current = { requestId, options };
      position.current = null;
      setCite({ requestId, pending: true, opening: true, back: false });
      send({ type: 'jump/open', requestId, ...target });
    },
    flush(): void {
      const msg = queued.current;
      if (!msg || !depsRef.current.canSendNow()) return;
      queued.current = null;
      depsRef.current.post(msg);
    },
    back(): void {
      depsRef.current.post({ type: 'citation/back', requestId: crypto.randomUUID() });
      current.current = null;
      setCite(null);
    },
    onMessage(msg: BackgroundToClient): void {
      if (msg.type === 'citation/located' && msg.requestId === current.current) {
        setCite({
          requestId: msg.requestId,
          pending: false,
          level: msg.level,
          ...(msg.reason ? { reason: msg.reason } : {}),
          back: msg.back === true,
          ...positionOf(msg.requestId),
        });
      } else if (msg.type === 'jump/result' && msg.requestId === current.current) {
        const options = jumping.current?.options ?? {};
        jumping.current = null;
        if (msg.ok && msg.tabId !== undefined) {
          landing.current = { tabId: msg.tabId, until: Date.now() + LANDING_MS };
          depsRef.current.onJumped?.(msg.tabId, options);
        }
        const reason = msg.reason === 'noAnchor' && options.quiet ? undefined : msg.reason;
        if (msg.ok && msg.level === undefined && reason === undefined) {
          // 到了就行（页面的对话、收藏只有来源对话）：没有要说明的
          current.current = null;
          setCite(null);
        } else {
          setCite({
            requestId: msg.requestId,
            pending: false,
            level: msg.level ?? 'none',
            ...(reason ? { reason } : {}),
            back: msg.back === true,
          });
        }
      } else if (
        msg.type === 'conv/rejected' &&
        (msg.refType === 'citation/locate' || msg.refType === 'jump/open') &&
        msg.refId === current.current
      ) {
        jumping.current = null;
        setCite({ requestId: msg.refId, pending: false, level: 'none', reason: 'unavailable', back: false });
      }
    },
  }).current;

  return { cite, ...api };
}

export function CiteNote({ cite, onBack }: { cite: CiteView | null; onBack: () => void }) {
  if (!cite) return null;
  return (
    <p data-testid="cite-note" data-level={cite.level ?? 'pending'} className="ra-note" aria-live="polite">
      {citeNoteText(cite)}
      {cite.back && (
        <button type="button" data-testid="cite-back" className="ra-btn ra-btn--small" onClick={onBack}>
          {T.cite.back}
        </button>
      )}
    </p>
  );
}
