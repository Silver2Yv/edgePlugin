// 引用跳回原文（F1、F2、5.7）与回到刚才的位置（F4）的界面部分，小窗与侧边栏共用：
// 点回答里的引用 → citation/locate（后台核对编号、算锚点、让网页定位并高亮）→ citation/located → 一行结果说明；
// 定位成功后给一次「回到刚才阅读的位置」（citation/back）。连接没就绪时先存着，订阅完成后再发。
// 结果说明放在提示区（.ra-notes），不进对话列表；换任务、换标签页时清掉。
import { useEffect, useRef, useState } from 'preact/hooks';
import type { BackgroundToClient, CitationFailReason, ClientToBackground } from '@/core/domain/messages';
import { T } from '../strings';

/** 回答里被点的引用：编号（【12】的 12），逐字引用再带上原文 */
export interface CitationClick {
  citation: string;
  quote?: string;
}

type Level = Extract<BackgroundToClient, { type: 'citation/located' }>['level'];

export interface CiteView {
  requestId: string;
  pending: boolean;
  level?: Level;
  reason?: CitationFailReason;
  back: boolean;
}

export interface CiteDeps {
  post: (msg: ClientToBackground) => void;
  /** 现在能不能直接发（连接已就绪；侧边栏还要求订阅已确认） */
  canSendNow: () => boolean;
  wake: () => void;
}

/** 结果说明的文案 */
export function citeNoteText(c: CiteView): string {
  if (c.pending) return T.cite.locating;
  if (c.level === 'exact') return T.cite.exact;
  if (c.level === 'fuzzy' || c.level === 'scroll') return T.cite.approx;
  return T.cite.fail[c.reason ?? 'notFound'];
}

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

  useEffect(() => {
    current.current = null;
    queued.current = null;
    setCite(null);
  }, [resetKey]);

  const api = useRef({
    locate(messageId: string, c: CitationClick): void {
      const requestId = crypto.randomUUID();
      const msg: ClientToBackground = {
        type: 'citation/locate',
        requestId,
        messageId,
        citation: c.citation,
        ...(c.quote ? { quote: c.quote } : {}),
      };
      current.current = requestId;
      setCite({ requestId, pending: true, back: false });
      if (depsRef.current.canSendNow()) depsRef.current.post(msg);
      else {
        queued.current = msg;
        depsRef.current.wake();
      }
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
        });
      } else if (
        msg.type === 'conv/rejected' &&
        msg.refType === 'citation/locate' &&
        msg.refId === current.current
      ) {
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
