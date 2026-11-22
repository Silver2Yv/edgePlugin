// 对话列表（C1），小窗与侧边栏共用：当前对话的全部消息（用户提问 + 助手回答）加上正在生成的任务。
// 滚动（5.10）：流式增量到达时不跟着滚、不抢焦点；只在出现新一轮问答时把这一轮顶到列表上沿
// （最后一轮至少占满列表高度，见 theme.css 的 .ra-turn--last），回答从上往下长，读的人自己往下看。
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { Connection, ModelRef } from '@/core/llm/adapter';
import { AnswerView } from '../AnswerView';
import { type DisplayItem, groupTurns, type UserMessageView } from '../float/messages';
import { T } from '../strings';

/** 用户消息气泡里引用摘要最多显示的字数（完整引用发问时在引用条里看过，这里只是提示问的是哪一段） */
const QUOTE_PREVIEW_CHARS = 60;

function UserMessage({ message, showQuote }: { message: UserMessageView; showQuote: boolean }) {
  const q = showQuote ? message.quote : undefined;
  const full = q ? q.text.trim() : '';
  const preview = [...full].slice(0, QUOTE_PREVIEW_CHARS).join('');
  return (
    <div className="ra-user" data-testid="user-message">
      {q && (
        <div className="ra-user__quote" title={T.list.quoted(q.originalLength)}>
          {preview}
          {preview.length < full.length || q.truncated ? '…' : ''}
        </div>
      )}
      {message.text ? message.text : <span className="ra-user__empty">{T.list.userNoText}</span>}
    </div>
  );
}

export interface MessageListProps {
  items: readonly DisplayItem[];
  /** 还没有消息时的一句说明 */
  emptyText: string;
  generating: boolean;
  onRetry: () => void;
  /** 点「展开讲讲」（I3） */
  onExpand: () => void;
  /** 「换个模型再试」（H12）要列的连接；不传就不显示这个功能 */
  connections?: readonly Connection[];
  onSwitchModel?: (model: ModelRef) => void;
}

export function MessageList({
  items,
  emptyText,
  generating,
  onRetry,
  onExpand,
  connections = [],
  onSwitchModel,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastTurnRef = useRef<HTMLDivElement | null>(null);
  const turns = groupTurns(items);
  const lastItem = items.at(-1);
  const liveId = liveKey(items);

  // 出现新一轮（换了正在显示的任务）：把这一轮顶到列表上沿。只动列表自己的滚动位置，不碰焦点；
  // 只在换任务时定位，增量到达不动
  useLayoutEffect(() => {
    const list = listRef.current;
    const turn = lastTurnRef.current;
    if (!list || !turn || liveId === '') return;
    list.scrollTop = Math.max(0, turn.offsetTop - 8);
  }, [liveId]);

  return (
    <div className="ra-list" ref={listRef} data-testid="message-list">
      {items.length === 0 && <p className="ra-empty">{emptyText}</p>}
      {turns.map((turn, ti) => {
        const last = ti === turns.length - 1;
        const first = turn[0] as DisplayItem;
        return (
          <div
            key={first.kind === 'user' ? first.message.id : first.id}
            className={last ? 'ra-turn ra-turn--last' : 'ra-turn'}
            {...(last ? { ref: lastTurnRef } : {})}
          >
            {turn.map((item) =>
              item.kind === 'user' ? (
                <UserMessage key={item.message.id} message={item.message} showQuote={item.showQuote} />
              ) : (
                <AnswerView
                  key={item.id}
                  view={item.view}
                  live={item.live}
                  selectedChars={item.selectedChars}
                  canExpand={
                    item === lastItem &&
                    !generating &&
                    item.view.state === 'completed' &&
                    item.view.plan?.lengthTier === 'brief'
                  }
                  onRetry={onRetry}
                  onExpand={onExpand}
                  connections={connections}
                  onSwitchModel={onSwitchModel}
                />
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 正在显示的任务所在的那条消息编号；没有任务时为空串 */
function liveKey(items: readonly DisplayItem[]): string {
  for (const i of items) if (i.kind === 'assistant' && i.live) return i.id;
  return '';
}
