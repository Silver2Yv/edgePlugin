// 提示词（I1）：按登记表（PROMPT_REGISTRY）列出，每条可以编辑、保存、恢复默认。设置里只存改过的部分：
// 恢复默认就是删掉那一条覆盖；改回和默认一样也等于恢复默认。
import { useState } from 'preact/hooks';
import { PROMPT_REGISTRY, type PromptDef } from '@/core/prompt/ask';
import { isPromptOverridden, promptText, resetPrompt, setPromptOverride } from './model';
import { S } from './strings';
import type { SettingsHandle } from './useSettings';

export function PromptsSection({ handle }: { handle: SettingsHandle }) {
  return (
    <div class="opt-prompts">
      <div class="opt-help">{S.prompts.help}</div>
      {PROMPT_REGISTRY.map((def) => (
        <PromptEditor key={def.id} handle={handle} def={def} />
      ))}
    </div>
  );
}

function PromptEditor({ handle, def }: { handle: SettingsHandle; def: PromptDef }) {
  const stored = promptText(handle.settings, def);
  // 草稿只在用户动过之后才有；没动过时显示存储里的（别处恢复默认、导入设置后跟着变）
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const text = draft ?? stored;
  const dirty = draft !== null && draft !== stored;
  const overridden = isPromptOverridden(handle.settings, def.id);

  async function save(): Promise<void> {
    if (draft === null) return;
    if (await handle.set((s) => setPromptOverride(s, def.id, draft))) {
      setDraft(null);
      setSaved(true);
    }
  }

  async function reset(): Promise<void> {
    if (await handle.set((s) => resetPrompt(s, def.id))) {
      setDraft(null);
      setSaved(false);
    }
  }

  return (
    <div class="opt-prompt" data-prompt-id={def.id}>
      <div class="opt-prompt__head">
        <span class="opt-prompt__name">{def.name}</span>
        {overridden && <span class="opt-badge opt-badge--muted">{S.prompts.changed}</span>}
      </div>
      <div class="opt-help">{def.description}</div>
      <textarea
        class="opt-input opt-textarea"
        rows={Math.min(10, Math.max(2, text.split('\n').length + 1))}
        aria-label={S.prompts.editLabel(def.name)}
        value={text}
        onInput={(e) => {
          setDraft((e.target as HTMLTextAreaElement).value);
          setSaved(false);
        }}
      />
      <div class="opt-prompt__actions">
        <button
          type="button"
          class="ra-btn ra-btn--primary"
          aria-label={S.prompts.saveLabel(def.name)}
          disabled={!dirty}
          onClick={() => void save()}
        >
          {S.prompts.save}
        </button>
        <button
          type="button"
          class="ra-btn"
          aria-label={S.prompts.resetLabel(def.name)}
          disabled={!overridden && !dirty}
          onClick={() => void reset()}
        >
          {S.prompts.reset}
        </button>
        {saved && <span class="opt-saved">{S.page.saved}</span>}
      </div>
    </div>
  );
}
