// 输入区（B2、D3、D11、H4、K4），小窗与侧边栏共用：引用条（可取消）、输入框、上下文档位与思考强度的临时切换、发送 / 停止。
// 档位与思考强度用原生下拉：下拉列表由浏览器画，不受小窗边界限制（5.3 已知约束），键盘与读屏都现成。
// 发送键在结构上紧跟输入框（按一下 Tab 就到），视觉上用样式排到这一行最右。
import type { Ref } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { ContextTier, ThinkingLevel } from '@/core/context/plan';
import { type QuoteView, shouldSendOnEnter } from '../float/state';
import { T } from '../strings';
import { IconClose } from './Icons';

const TIERS: readonly ContextTier[] = ['selection', 'nearby', 'fullPage'];
const THINKING: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

export interface ComposerProps {
  inputRef?: Ref<HTMLTextAreaElement>;
  value: string;
  onInput: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** 输入框获得焦点（断线闲着的界面据此重连） */
  onFocus: () => void;
  generating: boolean;
  quote: QuoteView | null;
  onDismissQuote: () => void;
  /** 当前生效的档位与思考强度（临时切换的，或设置里的默认值） */
  tier: ContextTier;
  thinking: ThinkingLevel;
  /** 是否临时切换过（与默认值不同时点亮） */
  tierChanged: boolean;
  thinkingChanged: boolean;
  onTier: (tier: ContextTier) => void;
  onThinking: (thinking: ThinkingLevel) => void;
  /** 实际发送用的模型名（J10）；没有连接时为 null。这一轮只显示，不能切换 */
  model: string | null;
}

export function Composer(p: ComposerProps) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);

  // 输入框跟着内容长高，到上限后内部滚动（上限在样式里）；清空后回到最小高度
  useLayoutEffect(() => {
    const el = localRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [p.value]);

  const setRef = (el: HTMLTextAreaElement | null) => {
    localRef.current = el;
    const outer = p.inputRef;
    if (typeof outer === 'function') outer(el);
    else if (outer) (outer as { current: HTMLTextAreaElement | null }).current = el;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!shouldSendOnEnter(e)) return;
    e.preventDefault();
    p.onSend();
  };

  return (
    <div className="ra-composer">
      <div className="ra-composer__box">
        {p.quote && (
          <div className="ra-quote" title={T.composer.quoteLabel}>
            <div className="ra-quote__body">
              {/* 选区末尾常带换行，显示时去掉，免得引用条多出一行空白 */}
              <div className="ra-quote__text" data-testid="quote">
                {p.quote.text.trimEnd()}
              </div>
              {p.quote.truncated && (
                <p className="ra-quote__note">{T.composer.quoteTruncated(p.quote.originalLength)}</p>
              )}
            </div>
            <button
              type="button"
              className="ra-icon-btn"
              aria-label={T.composer.quoteDismiss}
              title={T.composer.quoteDismissTitle}
              onClick={p.onDismissQuote}
            >
              <IconClose />
            </button>
          </div>
        )}
        <textarea
          ref={setRef}
          className="ra-input"
          aria-label={T.composer.inputLabel}
          placeholder={T.composer.placeholder}
          rows={1}
          value={p.value}
          onInput={(e) => p.onInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
          onFocus={p.onFocus}
        />
        <div className="ra-composer__bar">
          {/* 生成中发送键变「停止」（决策 062） */}
          {p.generating ? (
            <button type="button" className="ra-btn ra-composer__send" onClick={p.onStop}>
              {T.composer.stop}
            </button>
          ) : (
            <button type="button" className="ra-btn ra-btn--primary ra-composer__send" onClick={p.onSend}>
              {T.composer.send}
            </button>
          )}
          <span className="ra-pick">
            <select
              className="ra-select"
              aria-label={T.composer.tierLabel}
              title={`${T.composer.tierHelp[p.tier]}\n${T.composer.scopeHelp}`}
              data-changed={p.tierChanged}
              value={p.tier}
              onChange={(e) => p.onTier((e.target as HTMLSelectElement).value as ContextTier)}
            >
              {TIERS.map((t) => (
                <option key={t} value={t} title={T.composer.tierHelp[t]}>
                  {T.composer.tier[t]}
                </option>
              ))}
            </select>
          </span>
          <span className="ra-pick">
            <select
              className="ra-select"
              aria-label={T.composer.thinkingLabel}
              title={`${T.composer.thinkingHelp}\n${T.composer.scopeHelp}`}
              data-changed={p.thinkingChanged}
              value={p.thinking}
              onChange={(e) => p.onThinking((e.target as HTMLSelectElement).value as ThinkingLevel)}
            >
              {THINKING.map((t) => (
                <option key={t} value={t}>
                  {T.composer.thinking[t]}
                </option>
              ))}
            </select>
          </span>
          {p.model && (
            <span className="ra-model" title={T.composer.modelTitle(p.model)}>
              {p.model}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
