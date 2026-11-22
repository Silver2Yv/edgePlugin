// 设置页的常用项与几个小的高级小节。常用项（K1）：默认模型、上下文档位、回答长度、思考开关、网站黑名单；
// 高级里的「回答与上下文」「小窗」「权限说明」。每个会影响速度、费用、干扰程度、隐私的选项旁边直接写说明（K3、K5）。
import { useState } from 'preact/hooks';
import type { ContextTier, LengthTier, ThinkingLevel } from '@/core/context/plan';
import type { Settings } from '@/core/domain/settings';
import type { SiteRule } from '@/core/domain/site-policy';
import { isIpv6Rule, modelChoices, removeSiteRule, setDefaultModel, upsertSiteRule } from './model';
import { Row, Select } from './parts';
import { S } from './strings';
import type { SettingsHandle } from './useSettings';

const TIERS: readonly ContextTier[] = ['selection', 'nearby', 'fullPage'];
const LENGTHS: readonly LengthTier[] = ['brief', 'normal', 'detailed'];
const THINKING: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

export function CommonSection({ handle }: { handle: SettingsHandle }) {
  const { settings } = handle;
  const choices = modelChoices(settings);
  const selected = choices.findIndex(
    (c) => c.connectionId === settings.defaultModel?.connectionId && c.model === settings.defaultModel?.model,
  );
  const tier = settings.context.defaultTier;
  const length = settings.reply.lengthTier;

  return (
    <>
      <Row
        label={S.common.model}
        help={
          <>
            {S.common.modelHelp}
            {choices.length === 0 && <div class="opt-warn">{S.common.modelNone}</div>}
            {choices.length > 0 && !settings.defaultModel && (
              <div class="opt-warn">{S.common.modelMissing}</div>
            )}
          </>
        }
      >
        <select
          class="opt-select"
          aria-label={S.common.model}
          value={selected}
          disabled={choices.length === 0}
          onChange={(e) => {
            const c = choices[Number((e.target as HTMLSelectElement).value)];
            if (c)
              void handle.set((s) => setDefaultModel(s, { connectionId: c.connectionId, model: c.model }));
          }}
        >
          {selected < 0 && <option value={-1}>{S.common.modelUnset}</option>}
          {choices.map((c, i) => (
            <option key={`${c.connectionId}:${c.model}`} value={i}>
              {c.label}
            </option>
          ))}
        </select>
      </Row>

      <Row
        label={S.common.tier}
        help={
          <>
            {S.common.tierHelp[tier]} {S.common.tierScope}
          </>
        }
      >
        <Select
          label={S.common.tierLabel}
          value={tier}
          options={TIERS.map((t) => ({ value: t, label: S.common.tierOption[t] }))}
          onChange={(defaultTier) =>
            void handle.set((s) => ({ ...s, context: { ...s.context, defaultTier } }))
          }
        />
      </Row>

      <Row label={S.common.length} help={S.common.lengthHelp[length]}>
        <Select
          label={S.common.lengthLabel}
          value={length}
          options={LENGTHS.map((t) => ({ value: t, label: S.common.lengthOption[t] }))}
          onChange={(lengthTier) => void handle.set((s) => ({ ...s, reply: { ...s.reply, lengthTier } }))}
        />
      </Row>

      <Row label={S.common.thinking} help={S.common.thinkingHelp}>
        <Select
          label={S.common.thinkingLabel}
          value={settings.reply.thinking}
          options={THINKING.map((t) => ({ value: t, label: S.common.thinkingOption[t] }))}
          onChange={(thinking) => void handle.set((s) => ({ ...s, reply: { ...s.reply, thinking } }))}
        />
      </Row>
    </>
  );
}

/** 网站黑名单（A4）：两级。改动立即生效；已打开网页里的工具栏刷新后才消失 */
export function SitesSection({ handle }: { handle: SettingsHandle }) {
  const { settings } = handle;
  const [input, setInput] = useState('');
  const [level, setLevel] = useState<SiteRule['level']>('noRead');
  const [error, setError] = useState<string | null>(null);

  async function add(): Promise<void> {
    if (upsertSiteRule([], input, level) === undefined) {
      setError(S.sites.invalid);
      return;
    }
    const ok = await handle.set((s) => ({ ...s, sites: upsertSiteRule(s.sites, input, level) ?? s.sites }));
    if (ok) {
      setInput('');
      setError(null);
    }
  }

  return (
    <div class="opt-sites">
      <div class="opt-row__label">{S.sites.heading}</div>
      <div class="opt-help">
        {S.sites.help} {S.sites.effect}
      </div>
      {settings.sites.length === 0 && <div class="opt-muted">{S.sites.empty}</div>}
      <ul class="opt-list">
        {settings.sites.map((r) => (
          <li key={r.host} class="opt-list__item">
            <div class="opt-list__main">
              <span class="opt-mono">{r.host}</span>
              <span class="opt-badge opt-badge--muted">{S.sites.level[r.level]}</span>
              {isIpv6Rule(r.host) && r.level === 'noToolbar' && <div class="opt-warn">{S.sites.ipv6}</div>}
            </div>
            <button
              type="button"
              class="ra-btn ra-btn--small"
              aria-label={S.sites.removeLabel(r.host)}
              onClick={() => void handle.set((s) => ({ ...s, sites: removeSiteRule(s.sites, r.host) }))}
            >
              {S.sites.remove}
            </button>
          </li>
        ))}
      </ul>
      <div class="opt-inline opt-sites__add">
        <input
          class="opt-input"
          aria-label={S.sites.inputLabel}
          placeholder={S.sites.placeholder}
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <Select
          label={S.sites.levelLabel}
          value={level}
          options={[
            { value: 'noRead', label: S.sites.level.noRead },
            { value: 'noToolbar', label: S.sites.level.noToolbar },
          ]}
          onChange={setLevel}
        />
        <button type="button" class="ra-btn" onClick={() => void add()}>
          {S.sites.add}
        </button>
      </div>
      {error && <div class="opt-error">{error}</div>}
      {input.trim().startsWith('[') && <div class="opt-warn">{S.sites.ipv6}</div>}
    </div>
  );
}

const pct = (ratio: number) => Math.round(ratio * 100);

/** 回答语言（I5）、长文门槛、总结读取比例（D9） */
export function ReplySection({ handle }: { handle: SettingsHandle }) {
  const { settings } = handle;
  const language = settings.reply.language === 'auto' ? 'auto' : 'zh';
  const setContext = (patch: Partial<Settings['context']>) =>
    void handle.set((s) => ({ ...s, context: { ...s.context, ...patch } }));
  return (
    <>
      <Row label={S.reply.language} help={S.reply.languageHelp}>
        <Select
          label={S.reply.languageLabel}
          value={language}
          options={[
            { value: 'zh', label: S.reply.languageOption.zh },
            { value: 'auto', label: S.reply.languageOption.auto },
          ]}
          onChange={(lang) => void handle.set((s) => ({ ...s, reply: { ...s.reply, language: lang } }))}
        />
      </Row>
      <Row label={S.reply.softBudget} help={S.reply.softBudgetHelp}>
        <Slider
          label={S.reply.softBudgetLabel}
          min={10}
          max={100}
          step={5}
          value={pct(settings.context.speedSoftBudgetRatio)}
          onCommit={(n) => setContext({ speedSoftBudgetRatio: n / 100 })}
        />
      </Row>
      <Row label={S.reply.summaryRatio} help={S.reply.summaryRatioHelp}>
        <Slider
          label={S.reply.summaryRatioLabel}
          min={20}
          max={40}
          step={5}
          value={pct(settings.context.summaryReadRatio)}
          onCommit={(n) => setContext({ summaryReadRatio: n / 100 })}
        />
      </Row>
    </>
  );
}

/** 滑块：拖动时只更新旁边的数字，松手（change）才写设置，避免拖一下写几十次 */
function Slider(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? props.value;
  return (
    <div class="opt-slider">
      <input
        type="range"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={props.step}
        value={shown}
        onInput={(e) => setDragging(Number((e.target as HTMLInputElement).value))}
        onChange={(e) => {
          setDragging(null);
          props.onCommit(Number((e.target as HTMLInputElement).value));
        }}
      />
      <output class="opt-slider__value">{S.reply.percent(shown)}</output>
    </div>
  );
}

/** 小窗默认关闭方式（B3）与位置（B1） */
export function FloatSection({ handle }: { handle: SettingsHandle }) {
  const { settings } = handle;
  const setFloat = (patch: Partial<Settings['float']>) =>
    void handle.set((s) => ({ ...s, float: { ...s.float, ...patch } }));
  return (
    <>
      <Row label={S.float.closeMode} help={S.float.closeModeHelp}>
        <Select
          label={S.float.closeModeLabel}
          value={settings.float.closeMode}
          options={[
            { value: 'auto', label: S.float.closeModeOption.auto },
            { value: 'pinned', label: S.float.closeModeOption.pinned },
          ]}
          onChange={(closeMode) => setFloat({ closeMode })}
        />
      </Row>
      <Row label={S.float.placement} help={S.float.placementHelp}>
        <Select
          label={S.float.placementLabel}
          value={settings.float.placement}
          options={[
            { value: 'remembered', label: S.float.placementOption.remembered },
            { value: 'nearSelection', label: S.float.placementOption.nearSelection },
          ]}
          onChange={(placement) => setFloat({ placement })}
        />
      </Row>
    </>
  );
}

/** 每个权限一句用途（5.14），与 README 的表一致 */
export function PermissionsSection() {
  return (
    <>
      <div class="opt-help">{S.permissions.help}</div>
      <div class="opt-table-wrap">
        <table class="opt-table" data-testid="permission-table">
          <thead>
            <tr>
              <th>{S.permissions.permission}</th>
              <th>{S.permissions.usage}</th>
            </tr>
          </thead>
          <tbody>
            {S.permissions.items.map((p) => (
              <tr key={p.name}>
                <td>
                  {p.label}
                  <div class="opt-mono opt-muted">{p.name}</div>
                </td>
                <td>{p.usage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
