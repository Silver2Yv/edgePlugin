// 回答区（小窗与侧边栏共用）：思考过程、逐字渲染的回答、等待提示、错误、重试、「展开讲讲」、
// 实际发送说明（B8）与用量（J9）。对话里的每条助手消息都用它：正在显示的任务（live）与历史消息走同一条渲染管线。
// 回答的 Markdown/公式/高亮/引用渲染交给 src/ui/render（5.10）；对话内容只用文本节点或该模块产出的 DOM 渲染（规则 4、5）。
// 引用编号只在这条消息自己的发送计划（plan.sentBlockIds）内有效（规则 9）。
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { canRetry, isTerminal } from '@/core/domain/job';
import type { Connection, ModelRef } from '@/core/llm/adapter';
import { isReadCoverageNote } from '@/core/prompt/ask';
import { ImageAnswerNote } from './chat/CaptureParts';
import type { CitationClick } from './cite/useCite';
import { ERROR_LABEL } from './error-labels';
import { type AnswerLike, citationIds } from './float/messages';
import { sendSummary } from './float/send-summary';
import { waitHintText } from './float/state';
import './float/wait-hint.css';
import { MODEL_SWITCH_ERROR_KINDS, switchCandidates } from './model/options';
import { type AnswerRenderer, createAnswerRenderer } from './render';
import { T } from './strings';

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

const NO_BLOCKS: readonly string[] = [];
/** 「存」点了之后等这么久还没确认就恢复按钮（后台没回应、或消息丢了），不是真正的请求超时 */
const SAVE_PENDING_MS = 8_000;

export interface AnswerViewProps {
  view: AnswerLike;
  /**
   * 正在显示的任务：带 data-testid="job-state" / "answer"（界面上同一时刻只有一个），有等待提示，可以重试。
   * 历史消息为 false，只渲染内容
   */
  live: boolean;
  /** 这条回答对应的发问选中了多少字（发送说明用），不知道为 null */
  selectedChars: number | null;
  /** 显示「展开讲讲」（I3）：简短档的回答答完了，且是对话的最后一条 */
  canExpand: boolean;
  onRetry: () => void;
  onExpand: () => void;
  /** 点了回答里的引用（cite 块，F1）：跳回原文。不给就只显示不响应 */
  onCitation?: (c: CitationClick) => void;
  /** 「换个模型再试」（H12）要用到的连接（列候选）；不是正在显示的任务不需要传 */
  connections?: readonly Connection[] | undefined;
  onSwitchModel?: ((model: ModelRef) => void) | undefined;
  /**
   * 「存」（G3，核心功能开发第二批）：收藏这条回答连同提问与引用。不传（没有对话编号时，如还没落库的
   * 本地暂存消息）不显示按钮；只对已完成的回答显示
   */
  onSave?: () => void;
  /** 已经收到 favorite/saved 确认（按钮改「已存」） */
  saved?: boolean;
}

/**
 * 点到的引用元素 → 编号与原文。要点编号【12,5】带上全部编号与它是回答里第几个引用标记，
 * 由 useCite 决定这一次跳哪个（循环，决策 097）
 */
function citationOf(target: EventTarget | null, root: HTMLElement | null): CitationClick | undefined {
  const el = target instanceof Element ? target.closest('.ra-citation, .ra-citation-quote') : null;
  if (!el || !root?.contains(el)) return undefined;
  if (el.classList.contains('ra-citation-quote')) {
    const citation = el.getAttribute('data-id') ?? '';
    return citation ? { citation, quote: el.textContent ?? '' } : undefined;
  }
  const ids = (el.getAttribute('data-ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const citation = ids[0];
  if (!citation) return undefined;
  const slot = Array.from(root.querySelectorAll('.ra-citation, .ra-citation-quote')).indexOf(el);
  return { citation, ids, slot };
}

export function AnswerView({
  view,
  live,
  selectedChars,
  canExpand,
  onRetry,
  onExpand,
  onCitation,
  connections,
  onSwitchModel,
  onSave,
  saved,
}: AnswerViewProps) {
  const answerRef = useRef<HTMLDivElement | null>(null);
  const answerRendererRef = useRef<AnswerRenderer | null>(null);

  /** 回答容器挂载后才能创建渲染器；懒创建，同一个容器只创建一次 */
  const getAnswerRenderer = (): AnswerRenderer | null => {
    if (answerRendererRef.current) return answerRendererRef.current;
    if (!answerRef.current) return null;
    answerRendererRef.current = createAnswerRenderer(answerRef.current);
    return answerRendererRef.current;
  };

  // 回答里的引用写法是全角【12】，发送的块编号是 b12：换成去掉前缀的数字再交给渲染管线
  const sentBlockIds = view.plan?.sentBlockIds ?? NO_BLOCKS;
  const allowedCitationIds = useMemo(() => citationIds(sentBlockIds), [sentBlockIds]);

  // 还在生成的只有正在显示的任务；历史消息不论记录里的状态是什么都按已定稿渲染
  const streaming = live && !isTerminal(view.state);

  // 等待提示（纯函数见 float/state.ts 的 waitHintText）：askStartedAtRef 记发问/重试开始的时间，
  // lastDeltaAtRef 记最近一次收到正文/思考增量的时间；1 秒定时器只用来驱动重渲染，
  // 真正的时间判断在渲染时用 Date.now() 现算，任务到终态时 waitHintText 立即返回 null
  const askStartedAtRef = useRef<number | null>(null);
  const lastDeltaAtRef = useRef<number | null>(null);
  const [, bumpWaitTick] = useState(0);

  // 「存」（G3）：点了之后短暂禁用，收到 favorite/saved（saved 变真）就定住；迟迟没有确认（失败、丢消息）
  // SAVE_PENDING_MS 后自动恢复，不让按钮永远卡在禁用态
  const [savePending, setSavePending] = useState(false);
  useEffect(() => {
    if (!savePending) return;
    if (saved) {
      setSavePending(false);
      return;
    }
    const timer = setTimeout(() => setSavePending(false), SAVE_PENDING_MS);
    return () => clearTimeout(timer);
  }, [savePending, saved]);

  // 新任务 / 新尝试：清空回答区重新开始（jobId 或 attemptId 变化），同时重新起算等待计时
  useEffect(() => {
    const now = Date.now();
    askStartedAtRef.current = now;
    lastDeltaAtRef.current = now;
    getAnswerRenderer()?.reset();
  }, [view.jobId, view.attemptId]);

  // 收到正文或思考的新增量：刷新「距上次增量过去多久」的参照点
  useEffect(() => {
    lastDeltaAtRef.current = Date.now();
  }, [view.text, view.reasoning]);

  // 任务进行中才跑定时器；到终态时停表（清掉 interval）
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => bumpWaitTick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [view.jobId, view.attemptId, streaming]);

  const waitHint = streaming
    ? waitHintText({
        elapsedMs: askStartedAtRef.current ? Date.now() - askStartedAtRef.current : 0,
        hasAnswerText: view.text.length > 0,
        hasReasoningText: view.reasoning.length > 0,
        msSinceLastDelta: lastDeltaAtRef.current ? Date.now() - lastDeltaAtRef.current : 0,
        jobState: view.state,
      })
    : null;

  // 增量更新：走节流调度（rAF 合并同帧更新；超长回答降到至少 200ms 一次），终态交给下面那条 finalize。
  // 依赖里带上任务与尝试：上面那条清空回答区之后，这两条跟着重新渲染（同一次提交里按声明顺序执行）
  useEffect(() => {
    if (!streaming) return;
    getAnswerRenderer()?.scheduleUpdate(view.text, allowedCitationIds);
  }, [view.text, streaming, allowedCitationIds, view.jobId, view.attemptId]);

  // 到达终态（或本来就是历史消息）：立即做一次完整校正（流式阶段可能遗留的前向引用等在这里被纠正）
  useEffect(() => {
    if (streaming) return;
    getAnswerRenderer()?.finalize(view.text, allowedCitationIds);
  }, [streaming, view.text, allowedCitationIds, view.jobId, view.attemptId]);

  // 卸载：移除渲染器的 selectionchange 监听
  useEffect(() => () => answerRendererRef.current?.destroy(), []);

  // 页面级动作（总结等）的读取覆盖范围写在回答的标题处（5.9、AR-21）
  const coverage = view.plan?.notes.find(isReadCoverageNote);
  const onAnswerEvent = (e: MouseEvent | KeyboardEvent) => {
    if (!onCitation) return;
    if (e instanceof KeyboardEvent && e.key !== 'Enter' && e.key !== ' ') return;
    const c = citationOf(e.target, answerRef.current);
    if (!c) return;
    e.preventDefault();
    onCitation(c);
  };

  // 思考进行中（H6）：有思考内容、正文还没开始
  const reasoningNow = streaming && view.reasoning.length > 0 && view.text.length === 0;
  const summary = view.plan ? sendSummary(view.plan, selectedChars) : null;
  const usage = view.usage;
  const usageParts = usage
    ? [
        usage.inputTokens === undefined ? null : T.answer.usageInput(usage.inputTokens),
        usage.outputTokens === undefined ? null : T.answer.usageOutput(usage.outputTokens),
        usage.reasoningTokens === undefined ? null : T.answer.usageReasoning(usage.reasoningTokens),
      ].filter((p): p is string => p !== null)
    : [];

  // 换个模型再试（H12）：默认模型连不上/鉴权失败这类错误才建议；没有发送计划（没知道用的哪个模型）不建议
  const switchOptions =
    live &&
    connections &&
    onSwitchModel &&
    view.state === 'failed' &&
    view.error &&
    MODEL_SWITCH_ERROR_KINDS.has(view.error.kind) &&
    view.plan
      ? switchCandidates(connections, view.plan.model)
      : [];

  return (
    <div className="ra-assistant">
      {/* 给端到端测试与读屏之外的排查用的原始状态；界面上的状态由下面的提示文字表达 */}
      {live && (
        <span data-testid="job-state" hidden>
          {view.state}
        </span>
      )}
      {view.reasoning && (
        <details className="ra-fold ra-think">
          <summary>
            {reasoningNow ? T.answer.reasoningNow : T.answer.reasoning}
            {reasoningNow && <span className="ra-pulse" />}
          </summary>
          <div className="ra-think__body">{view.reasoning}</div>
        </details>
      )}
      {coverage && (
        <p className="ra-answer__coverage" data-testid="coverage-title">
          {coverage}
        </p>
      )}
      {/* 子节点完全由 src/ui/render（createAnswerRenderer）管理，这里不写 children，
          Preact 不会对它做子节点 diff（见 render/mount.ts）。引用元素的点击在这里委托处理 */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 只委托处理里面引用元素（role=button、可聚焦）的点击与按键 */}
      <div
        ref={answerRef}
        data-testid={live ? 'answer' : 'history-answer'}
        className="ra-answer"
        onClick={onAnswerEvent}
        onKeyDown={onAnswerEvent}
      />
      {waitHint && (
        <p data-testid="wait-hint" aria-live="polite" className="ra-status">
          {renderWaitHint(waitHint)}
        </p>
      )}
      {view.state === 'failed' && view.error && (
        <p className="ra-status ra-status--error">
          {ERROR_LABEL[view.error.kind]}
          {view.error.message && `：${view.error.message}`}
        </p>
      )}
      {switchOptions.length > 0 && (
        <p className="ra-status ra-switch-model" data-testid="switch-model">
          {T.answer.switchModel}
          {switchOptions.map((c) => (
            <button
              type="button"
              key={`${c.ref.connectionId}:${c.ref.model}`}
              className="ra-btn ra-btn--small"
              data-testid="switch-model-option"
              onClick={() => onSwitchModel?.(c.ref)}
            >
              {c.label}
            </button>
          ))}
        </p>
      )}
      {view.state === 'interrupted' && <p className="ra-status">{T.answer.interrupted}</p>}
      {view.state === 'stopped' && <p className="ra-status">{T.answer.stopped}</p>}
      <ImageAnswerNote view={view} />
      <div className="ra-actions">
        {live && canRetry(view.state) && (
          <button type="button" className="ra-btn ra-btn--small" onClick={onRetry}>
            {T.answer.retry}
          </button>
        )}
        {canExpand && (
          <button
            type="button"
            className="ra-btn ra-btn--small"
            title={T.answer.expandTitle}
            onClick={onExpand}
          >
            {T.answer.expand}
          </button>
        )}
        {onSave && view.state === 'completed' && (
          <button
            type="button"
            className="ra-btn ra-btn--small"
            data-testid="answer-save"
            title={T.answer.saveTitle}
            disabled={saved || savePending}
            onClick={() => {
              setSavePending(true);
              onSave();
            }}
          >
            {saved ? T.answer.saved : T.answer.save}
          </button>
        )}
      </div>
      {/* 实际使用的模型（J10）：一直显示，不用展开；和输入区下拉选中的不一致时（H12 换过模型、或
          modelGone 被迫换回默认）一眼能看出 */}
      {view.plan && (
        <p className="ra-status" data-testid="answer-model">
          {T.sent.model(view.plan.model.model)}
        </p>
      )}
      {(summary || usageParts.length > 0) && (
        <div className="ra-meta">
          {summary && (
            <details className="ra-fold" data-testid="send-note">
              <summary title={T.sent.label}>
                <span>{summary.parts.join(' · ')}</span>
              </summary>
              <ul>
                {summary.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </details>
          )}
          {usageParts.length > 0 && (
            <details className="ra-fold" data-testid="usage">
              <summary>
                <span>{T.answer.usage}</span>
              </summary>
              <ul>
                {usageParts.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
