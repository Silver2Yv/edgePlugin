// 配置向导（L2、H1）：只配一个默认模型，其余选项全部用默认值。
// 选服务商 → 填地址和 Key → 测试连接（先拉模型列表探一下地址与 Key；H9 的诊断、缺 /v1 时一键修正）→
// 选默认模型（拉不到列表可以手填），用它发一条最小的真实对话确认能用 → 完成。随时可以跳过，之后在设置页配置。
// 欢迎页与设置页（还没有任何连接时在顶部出现）共用这一个组件。
import { useRef, useState } from 'preact/hooks';
import type { Connection, ModelError } from '@/core/llm/adapter';
import { PROVIDER_PRESETS } from '@/core/llm/presets';
import { listModels, testConnection } from './api';
import { ModelList } from './ModelList';
import {
  applyPreset,
  blankConnection,
  presetOf,
  resolveApiKey,
  setDefaultModel,
  toggleCommonModel,
  upsertConnection,
} from './model';
import { S } from './strings';
import { type TestOutcome, TestResultView } from './TestResultView';
import type { SettingsHandle } from './useSettings';

type Step = 'provider' | 'connect' | 'probe' | 'model' | 'done' | 'skipped' | 'configured';

type Probe =
  | { phase: 'running' }
  | { phase: 'ok'; models: string[] }
  | { phase: 'failed'; at: number; elapsedMs: number; error?: ModelError; suggestedBaseUrl?: string };

const STEP_INDEX: Readonly<Partial<Record<Step, number>>> = { provider: 0, connect: 1, probe: 2, model: 3 };
const LIST_MODELS_LABEL = '（拉取模型列表）';

export function Wizard(props: {
  handle: SettingsHandle;
  /** 给了就表示向导可以收起（设置页）：跳过时、完成后点「收起」时调用。欢迎页不给，向导留在原处显示结果 */
  onClose?: () => void;
  /** 完成后要不要给「打开设置页」的入口（欢迎页要，设置页自己就是） */
  showSettingsLink?: boolean;
  onOpenSettings?: () => void;
}) {
  const { handle } = props;
  const alreadyConfigured = handle.settings.connections.length > 0;
  const [step, setStep] = useState<Step>(alreadyConfigured ? 'configured' : 'provider');
  const [presetId, setPresetId] = useState('deepseek');
  const [baseUrl, setBaseUrl] = useState(presetOf('deepseek')?.baseUrl ?? '');
  const [keyInput, setKeyInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Connection | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [model, setModel] = useState('');
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [finishedModel, setFinishedModel] = useState('');
  // 向导从头到尾只建一条连接：返回上一步改了再保存，更新的是同一条
  const connId = useRef(crypto.randomUUID());

  const preset = presetOf(presetId);
  const total = S.wizard.steps.length;

  function choosePreset(id: string): void {
    setPresetId(id);
    const p = presetOf(id);
    // 换了服务商，地址跟着换成它的；选「自定义」时清空，让用户自己填
    setBaseUrl(p?.baseUrl ?? '');
  }

  async function saveAndProbe(urlOverride?: string): Promise<void> {
    const url = (urlOverride ?? baseUrl).trim();
    if (url === '') {
      setFormError(S.wizard.needBaseUrl);
      return;
    }
    setFormError(null);
    setOutcome(null);
    setStep('probe');
    setProbe({ phase: 'running' });
    const base = saved ?? blankConnection(connId.current, presetId);
    const draft: Connection = {
      ...applyPreset(base, presetId),
      baseUrl: url,
      apiKey: resolveApiKey(saved?.apiKey ?? '', keyInput, false),
    };
    const conn = await handle.update((s) => {
      const r = upsertConnection(s, draft);
      return { settings: r.settings, result: r.saved };
    });
    if (!conn) {
      setStep('connect');
      setProbe(null);
      return;
    }
    setSaved(conn);
    setBaseUrl(conn.baseUrl);
    setKeyInput('');
    const startedAt = Date.now();
    const r = await listModels(conn.id);
    if (r.ok && r.models.length > 0) {
      setProbe({ phase: 'ok', models: r.models });
      const suggested = preset?.suggestedModels.find((m) => r.models.includes(m));
      setModel((m) => (m !== '' && r.models.includes(m) ? m : (suggested ?? '')));
      setStep('model');
      return;
    }
    if (r.ok) {
      // 连上了但列表是空的：让用户手填
      setProbe({ phase: 'ok', models: [] });
      setModel((m) => m || (preset?.suggestedModels[0] ?? ''));
      setStep('model');
      return;
    }
    setProbe({
      phase: 'failed',
      at: startedAt,
      elapsedMs: Date.now() - startedAt,
      ...(r.error ? { error: r.error } : {}),
      ...(r.suggestedBaseUrl !== undefined ? { suggestedBaseUrl: r.suggestedBaseUrl } : {}),
    });
  }

  function continueManually(): void {
    setModel((m) => m || (preset?.suggestedModels[0] ?? ''));
    setStep('model');
  }

  async function testAndFinish(conn: Connection): Promise<void> {
    const name = model.trim();
    if (name === '') {
      setFormError(S.wizard.needModel);
      return;
    }
    setFormError(null);
    setTesting(true);
    try {
      const at = Date.now();
      const result = await testConnection(conn.id, name);
      if (!result?.ok) {
        setOutcome({ at, model: name, result: result ?? 'noReply' });
        return;
      }
      const ok = await handle.set((s) => {
        const current = s.connections.find((c) => c.id === conn.id);
        if (!current) return s;
        const r = upsertConnection(s, toggleCommonModel(current, name, true));
        return setDefaultModel(r.settings, { connectionId: conn.id, model: name });
      });
      if (!ok) return;
      setOutcome({ at, model: name, result });
      setFinishedModel(name);
      setStep('done');
    } finally {
      setTesting(false);
    }
  }

  /** 缺 /v1：改成后台探测出来的地址，保存后从拉模型列表重新来 */
  async function applySuggested(url: string): Promise<void> {
    setBaseUrl(url);
    await saveAndProbe(url);
  }

  function skip(): void {
    setStep('skipped');
    props.onClose?.();
  }

  function restart(): void {
    connId.current = crypto.randomUUID();
    setSaved(null);
    setProbe(null);
    setOutcome(null);
    setModel('');
    setKeyInput('');
    choosePreset('deepseek');
    setStep('provider');
  }

  const stepIndex = STEP_INDEX[step];
  const skipLink = (
    <button type="button" class="opt-link" onClick={skip}>
      {S.wizard.skip}
    </button>
  );
  const settingsLink = props.showSettingsLink && props.onOpenSettings && (
    <button type="button" class="ra-btn" onClick={props.onOpenSettings}>
      {S.wizard.openSettings}
    </button>
  );

  return (
    <section class="opt-wizard" data-testid="wizard" data-step={step} aria-label={S.wizard.heading}>
      {stepIndex !== undefined && (
        <ol
          class="opt-steps"
          aria-label={S.wizard.stepLabel(stepIndex + 1, total, S.wizard.steps[stepIndex] ?? '')}
        >
          {S.wizard.steps.map((name, i) => (
            <li
              key={name}
              class={i === stepIndex ? 'opt-steps__item opt-steps__item--now' : 'opt-steps__item'}
              data-done={i < stepIndex ? 'true' : undefined}
              aria-current={i === stepIndex ? 'step' : undefined}
            >
              <span class="opt-steps__num">{i + 1}</span>
              {name}
            </li>
          ))}
        </ol>
      )}

      {step === 'provider' && (
        <div class="opt-wizard__body">
          <div class="opt-wizard__lead">{S.wizard.lead}</div>
          <div class="opt-presets" role="radiogroup" aria-label={S.wizard.provider}>
            {PROVIDER_PRESETS.map((p) => (
              <label key={p.id} class="opt-preset" data-checked={p.id === presetId ? 'true' : undefined}>
                <input
                  type="radio"
                  name="opt-wizard-preset"
                  checked={p.id === presetId}
                  onChange={() => choosePreset(p.id)}
                />
                <span>{p.name}</span>
              </label>
            ))}
          </div>
          <div class="opt-help">{S.wizard.providerHelp}</div>
          <div class="opt-wizard__actions">
            <button type="button" class="ra-btn ra-btn--primary" onClick={() => setStep('connect')}>
              {S.wizard.next}
            </button>
            {skipLink}
          </div>
        </div>
      )}

      {step === 'connect' && (
        <div class="opt-wizard__body">
          <div class="opt-field">
            <label class="opt-field__label" for="wizard-base-url">
              {S.conn.baseUrl}
            </label>
            <input
              id="wizard-base-url"
              class="opt-input"
              placeholder="https://…/v1"
              value={baseUrl}
              onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
            />
            <div class="opt-help">{S.conn.baseUrlHelp}</div>
          </div>
          <div class="opt-field">
            <label class="opt-field__label" for="wizard-api-key">
              {S.conn.apiKey}
            </label>
            <input
              id="wizard-api-key"
              class="opt-input"
              type="password"
              autocomplete="off"
              placeholder={saved?.apiKey ? S.conn.apiKeyPlaceholderSaved : S.conn.apiKeyPlaceholderNew}
              value={keyInput}
              onInput={(e) => setKeyInput((e.target as HTMLInputElement).value)}
            />
            <div class="opt-help">
              {S.conn.apiKeyHelp}
              {preset?.apiKeyUrl && (
                <>
                  {' '}
                  <a class="opt-link" href={preset.apiKeyUrl} target="_blank" rel="noreferrer">
                    {S.conn.getKey}（{preset.name}）
                  </a>
                </>
              )}
            </div>
          </div>
          {formError && <div class="opt-error">{formError}</div>}
          {handle.saveError && <div class="opt-error">{handle.saveError}</div>}
          <div class="opt-wizard__actions">
            <button type="button" class="ra-btn" onClick={() => setStep('provider')}>
              {S.wizard.back}
            </button>
            <button type="button" class="ra-btn ra-btn--primary" onClick={() => void saveAndProbe()}>
              {S.wizard.saveAndTest}
            </button>
            {skipLink}
          </div>
        </div>
      )}

      {step === 'probe' && (
        <div class="opt-wizard__body">
          {probe?.phase === 'running' && (
            <div class="opt-muted" role="status">
              {S.wizard.probing}
            </div>
          )}
          {probe?.phase === 'failed' && saved && (
            <>
              {probe.error ? (
                <TestResultView
                  outcome={{
                    at: probe.at,
                    model: LIST_MODELS_LABEL,
                    result: {
                      ok: false,
                      error: probe.error,
                      elapsedMs: probe.elapsedMs,
                      ...(probe.suggestedBaseUrl !== undefined
                        ? { suggestedBaseUrl: probe.suggestedBaseUrl }
                        : {}),
                    },
                  }}
                  conn={saved}
                  busy={false}
                  onApplySuggested={(url) => void applySuggested(url)}
                />
              ) : (
                <div class="opt-result opt-result--error" role="status">
                  {S.wizard.probeFailed}
                </div>
              )}
              <div class="opt-help">{S.wizard.probeManual}</div>
              <div class="opt-wizard__actions">
                <button type="button" class="ra-btn" onClick={() => setStep('connect')}>
                  {S.wizard.back}
                </button>
                <button type="button" class="ra-btn" onClick={() => void saveAndProbe()}>
                  {S.wizard.retry}
                </button>
                <button type="button" class="ra-btn" onClick={continueManually}>
                  {S.wizard.manualContinue}
                </button>
                {skipLink}
              </div>
            </>
          )}
        </div>
      )}

      {step === 'model' && saved && (
        <div class="opt-wizard__body">
          {probe?.phase === 'ok' && (
            <div class="opt-result opt-result--ok" role="status">
              {probe.models.length > 0 ? S.wizard.probeOk(probe.models.length) : S.wizard.probeEmpty}
            </div>
          )}
          <div class="opt-help">{S.wizard.chooseHelp}</div>
          {probe?.phase === 'ok' && probe.models.length > 0 && (
            <ModelList
              models={probe.models}
              mode="radio"
              selected={model ? [model] : []}
              onToggle={(m) => setModel(m)}
            />
          )}
          <div class="opt-field">
            <label class="opt-field__label" for="wizard-model">
              {S.wizard.manualModel}
            </label>
            <input
              id="wizard-model"
              class="opt-input"
              placeholder={S.wizard.manualPlaceholder}
              value={model}
              onInput={(e) => setModel((e.target as HTMLInputElement).value)}
            />
            {preset && preset.suggestedModels.length > 0 && (
              <div class="opt-help">
                {S.wizard.suggested}
                {preset.suggestedModels.map((m) => (
                  <button key={m} type="button" class="opt-chip" onClick={() => setModel(m)}>
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
          {formError && <div class="opt-error">{formError}</div>}
          {outcome && (
            <TestResultView
              outcome={outcome}
              conn={saved}
              busy={testing}
              onApplySuggested={(url) => void applySuggested(url)}
            />
          )}
          <div class="opt-wizard__actions">
            <button type="button" class="ra-btn" onClick={() => setStep('connect')}>
              {S.wizard.back}
            </button>
            <button
              type="button"
              class="ra-btn ra-btn--primary"
              disabled={testing}
              onClick={() => void testAndFinish(saved)}
            >
              {testing ? S.wizard.testing : S.wizard.testAndFinish}
            </button>
            {skipLink}
          </div>
        </div>
      )}

      {step === 'done' && (
        <div class="opt-wizard__body">
          <div class="opt-result opt-result--ok" role="status">
            {S.wizard.done(finishedModel)}
          </div>
          <div class="opt-wizard__actions">
            {settingsLink}
            {props.onClose && (
              <button type="button" class="ra-btn" onClick={props.onClose}>
                {S.conn.close}
              </button>
            )}
          </div>
        </div>
      )}

      {step === 'skipped' && (
        <div class="opt-wizard__body">
          <div class="opt-muted">{S.wizard.skipped}</div>
          <div class="opt-wizard__actions">
            <button type="button" class="ra-btn" onClick={restart}>
              {S.wizard.restart}
            </button>
            {settingsLink}
          </div>
        </div>
      )}

      {step === 'configured' && (
        <div class="opt-wizard__body">
          <div class="opt-result opt-result--ok" role="status">
            {handle.settings.defaultModel
              ? S.wizard.configured(handle.settings.defaultModel.model)
              : S.wizard.configuredNoDefault}
          </div>
          <div class="opt-wizard__actions">
            <button type="button" class="ra-btn" onClick={restart}>
              {S.wizard.again}
            </button>
            {settingsLink}
          </div>
        </div>
      )}
    </section>
  );
}
