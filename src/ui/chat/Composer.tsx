// 输入区（B2、D3、D11、H4、K4），小窗与侧边栏共用：引用条（可取消）、输入框、上下文档位/思考强度/模型的临时切换、发送 / 停止。
// 档位与思考强度用原生下拉：下拉列表由浏览器画，不受小窗边界限制（5.3 已知约束），键盘与读屏都现成。
// 模型改用窗内面板（ModelPicker）：常用模型分组较多、要能搜索，原生 <select> 装不下这些（H4、H5）。
// 发送键在结构上紧跟输入框（按一下 Tab 就到），视觉上用样式排到这一行最右。
import type { Ref } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { ContextTier, ThinkingLevel } from '@/core/context/plan';
import type { Connection, ModelRef } from '@/core/llm/adapter';
import { type CaptureView, type QuoteView, shouldSendOnEnter } from '../float/state';
import { capabilitiesFor, type ThinkingControlMode } from '../model/options';
import { T } from '../strings';
import { CaptureButton, CapturePreview } from './CaptureParts';
import { IconClose } from './Icons';
import { ModelPicker } from './ModelPicker';

const TIERS: readonly ContextTier[] = ['selection', 'nearby', 'fullPage'];
const THINKING: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high'];
const THINKING_TOGGLE: readonly ThinkingLevel[] = ['off', 'medium'];

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
  /** 所选模型支持的思考控件形态（H6）：开关类只显示关/开，不支持的禁用，其余照常四档 */
  thinkingMode: ThinkingControlMode;
  /** 实际发送用的模型（J10：界面显示的就是实际发送的）；没有连接时为 null */
  model: ModelRef | null;
  /** 设置里的默认模型，用于判断是否临时切换过 */
  defaultModel: ModelRef | null;
  /** 所有连接（模型下拉按连接分组列出用户勾选的常用模型） */
  connections: readonly Connection[];
  onModel: (model: ModelRef | null) => void;
  /** 框选截图（capture 块）：待确认的截图、去掉它、「截图」按钮。不给 onCapture 就不显示按钮 */
  capture?: CaptureView | null;
  onDismissCapture?: () => void;
  onCapture?: () => void;
}

export function Composer(p: ComposerProps) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);

  // 输入框跟着内容长高，到上限后内部滚动（上限在样式里）；清空后回到最小高度。
  // 宽度变了也重算：侧边栏刚打开时页面先按 0 宽排版，占位文字折成很多行，不重算就一直撑着最大高度
  useLayoutEffect(() => {
    const el = localRef.current;
    if (!el) return;
    const fitHeight = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    fitHeight();
    window.addEventListener('resize', fitHeight);
    return () => window.removeEventListener('resize', fitHeight);
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
        {p.capture && (
          <CapturePreview
            capture={p.capture}
            vision={capabilitiesFor(p.connections, p.model)?.vision ?? null}
            onDismiss={p.onDismissCapture}
          />
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
            {p.thinkingMode === 'disabled' ? (
              <select
                className="ra-select"
                aria-label={T.composer.thinkingLabel}
                title={T.composer.thinkingDisabled}
                disabled
                value="off"
              >
                <option value="off">{T.composer.thinking.off}</option>
              </select>
            ) : (
              <select
                className="ra-select"
                aria-label={T.composer.thinkingLabel}
                title={`${T.composer.thinkingHelp}\n${T.composer.scopeHelp}`}
                data-changed={p.thinkingChanged}
                value={p.thinking}
                onChange={(e) => p.onThinking((e.target as HTMLSelectElement).value as ThinkingLevel)}
              >
                {(p.thinkingMode === 'toggle' ? THINKING_TOGGLE : THINKING).map((t) => (
                  <option key={t} value={t}>
                    {p.thinkingMode === 'toggle'
                      ? T.composer.thinkingToggle[t === 'off' ? 'off' : 'on']
                      : T.composer.thinking[t]}
                  </option>
                ))}
              </select>
            )}
          </span>
          <ModelPicker
            connections={p.connections}
            value={p.model}
            defaultModel={p.defaultModel}
            onChange={p.onModel}
          />
          {p.onCapture && <CaptureButton onClick={p.onCapture} disabled={p.generating} />}
        </div>
      </div>
    </div>
  );
}
