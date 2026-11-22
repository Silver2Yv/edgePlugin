// 测试连接的结果（H9、5.8）：成功显示模型回了什么、用时；失败把原因说清楚——错误分类、状态码、浏览器错误码、
// 可能的原因、服务器原始报错（已由后台脱敏限长），缺 /v1 时一键改地址重测，并能一键复制诊断信息（Key 自动隐去）。
// 设置页的连接编辑器与配置向导共用。
import { useState } from 'preact/hooks';
import type { Connection } from '@/core/llm/adapter';
import { buildDiagnosticsText } from '@/core/llm/diagnostics';
import { ERROR_LABEL } from '../error-labels';
import { copyText } from './api';
import { causesOf } from './diagnose';
import type { TestResult } from './model';
import { S } from './strings';

/** noReply：后台应答形状不对（扩展版本不一致等） */
export type TestOutcome = { at: number; model: string; result: TestResult | 'noReply'; note?: string };

export function TestResultView(props: {
  outcome: TestOutcome;
  /** 被测的连接（已保存的那份）；诊断信息从它取名字、地址、请求头，Key 不进诊断文本 */
  conn: Connection;
  busy: boolean;
  onApplySuggested?: (url: string) => void;
}) {
  const { outcome, conn } = props;
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const { result } = outcome;

  if (result === 'noReply') {
    return (
      <div class="opt-result opt-result--error" role="status">
        {S.test.noReply}
      </div>
    );
  }
  if (result.ok) {
    return (
      <div class="opt-result opt-result--ok" role="status">
        {S.test.ok(result.model, result.reply, (result.elapsedMs / 1000).toFixed(1))}
        {result.reasoning && S.test.reasoning}
        {outcome.note}
      </div>
    );
  }

  const { error } = result;
  const copy = async () => {
    const text = buildDiagnosticsText({
      connectionName: conn.name,
      baseUrl: conn.baseUrl,
      interfaceType: conn.interfaceType,
      model: outcome.model,
      headers: conn.headers,
      error,
      elapsedMs: result.elapsedMs,
      at: outcome.at,
    });
    setCopyState((await copyText(text)) ? 'copied' : 'failed');
  };
  const facts = [
    ERROR_LABEL[error.kind],
    ...(error.status !== undefined ? [S.test.status(error.status)] : []),
    ...(error.netError ? [S.test.netError(error.netError)] : []),
  ];
  const suggested = result.suggestedBaseUrl;
  return (
    <div class="opt-result opt-result--error" role="status" data-testid="test-error">
      <div class="opt-result__title">
        {S.test.failed}：{facts.join('；')}
      </div>
      <ul class="opt-result__causes" aria-label={S.test.causes}>
        {causesOf(error).map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      {error.serverMessage && (
        <div class="opt-result__server">
          <div class="opt-result__server-label">{S.test.server}</div>
          <pre data-testid="server-message">{error.serverMessage}</pre>
        </div>
      )}
      <div class="opt-result__actions">
        {suggested !== undefined && props.onApplySuggested && (
          <button
            type="button"
            class="ra-btn ra-btn--primary"
            disabled={props.busy}
            onClick={() => props.onApplySuggested?.(suggested)}
          >
            {S.test.applySuggested(suggested)}
          </button>
        )}
        <button type="button" class="ra-btn" onClick={() => void copy()}>
          {S.test.copy}
        </button>
        {copyState !== 'idle' && (
          <span class="opt-result__copied">{copyState === 'copied' ? S.test.copied : S.test.copyFailed}</span>
        )}
      </div>
    </div>
  );
}
