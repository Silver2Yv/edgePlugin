// 回答区（小窗与侧边栏共用）：任务状态、思考过程、逐字渲染的回答、等待提示、错误、重试。
// 回答的 Markdown/公式/高亮/引用渲染交给 src/ui/render（5.10）；对话内容只用文本节点或该模块产出的 DOM 渲染（规则 4、5）。
// 父组件只在有任务时挂载它；换任务、换尝试时清空回答区重新开始。
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { canRetry, isTerminal } from '@/core/domain/job';
import { ERROR_LABEL } from './error-labels';
import { type JobView, waitHintText } from './float/state';
import './float/wait-hint.css';
import { type AnswerRenderer, createAnswerRenderer } from './render';

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

export function AnswerView({ job, onRetry }: { job: JobView; onRetry: () => void }) {
  const answerRef = useRef<HTMLDivElement | null>(null);
  const answerRendererRef = useRef<AnswerRenderer | null>(null);

  /** 回答容器挂载后才能创建渲染器；懒创建，同一个容器只创建一次 */
  const getAnswerRenderer = (): AnswerRenderer | null => {
    if (answerRendererRef.current) return answerRendererRef.current;
    if (!answerRef.current) return null;
    answerRendererRef.current = createAnswerRenderer(answerRef.current);
    return answerRendererRef.current;
  };

  const allowedCitationIds = useMemo(() => new Set(job.sentBlockIds), [job.sentBlockIds]);

  // 等待提示（纯函数见 float/state.ts 的 waitHintText）：askStartedAtRef 记发问/重试开始的时间，
  // lastDeltaAtRef 记最近一次收到正文/思考增量的时间；1 秒定时器只用来驱动重渲染，
  // 真正的时间判断在渲染时用 Date.now() 现算，任务到终态时 waitHintText 立即返回 null
  const askStartedAtRef = useRef<number | null>(null);
  const lastDeltaAtRef = useRef<number | null>(null);
  const [, bumpWaitTick] = useState(0);

  // 新任务 / 新尝试：清空回答区重新开始（job.jobId 或 attemptId 变化），同时重新起算等待计时
  useEffect(() => {
    const now = Date.now();
    askStartedAtRef.current = now;
    lastDeltaAtRef.current = now;
    getAnswerRenderer()?.reset();
  }, [job.jobId, job.attemptId]);

  // 收到正文或思考的新增量：刷新「距上次增量过去多久」的参照点
  useEffect(() => {
    lastDeltaAtRef.current = Date.now();
  }, [job.text, job.reasoning]);

  // 任务进行中才跑定时器；到终态时停表（清掉 interval）
  useEffect(() => {
    if (isTerminal(job.state)) return;
    const timer = setInterval(() => bumpWaitTick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [job.jobId, job.attemptId, job.state]);

  const waitHint = waitHintText({
    elapsedMs: askStartedAtRef.current ? Date.now() - askStartedAtRef.current : 0,
    hasAnswerText: job.text.length > 0,
    hasReasoningText: job.reasoning.length > 0,
    msSinceLastDelta: lastDeltaAtRef.current ? Date.now() - lastDeltaAtRef.current : 0,
    jobState: job.state,
  });

  // 增量更新：走节流调度（rAF 合并同帧更新；超长回答降到至少 200ms 一次），终态交给下面那条 finalize
  useEffect(() => {
    if (isTerminal(job.state)) return;
    getAnswerRenderer()?.scheduleUpdate(job.text, allowedCitationIds);
  }, [job.text, job.state, allowedCitationIds]);

  // 到达终态：立即做一次完整校正（流式阶段可能遗留的前向引用等在这里被纠正）
  useEffect(() => {
    if (!isTerminal(job.state)) return;
    getAnswerRenderer()?.finalize(job.text, allowedCitationIds);
  }, [job.state, job.text, allowedCitationIds]);

  // 卸载：移除渲染器的 selectionchange 监听
  useEffect(() => () => answerRendererRef.current?.destroy(), []);

  return (
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
          Preact 不会对它做子节点 diff（见 render/mount.ts） */}
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
        <button type="button" style={{ marginTop: '4px' }} onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}
