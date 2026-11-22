// 设置页（K1–K5、5.11「设置」、5.8「测试连接」）。分两层：常用项露在外面——默认模型、上下文档位、回答长度、
// 思考开关、网站黑名单；其余收进「高级选项」，默认折叠（折叠不减少能力，只减少视觉负担）。
// 还没有任何连接时，顶部出现配置向导（L2、H1），可以跳过。
// 只和后台通信（settings/ensureLocked、connection/test、connection/listModels），自己不做数据库写入；
// storage.local 的写入顺序见 options/api.ts 的 persistSettings（5.11）。表单逻辑在 options/model.ts（纯函数，有单测）。
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { ActionsSection } from './options/ActionsSection';
import { ConnectionsSection } from './options/ConnectionsSection';
import { PromptsSection } from './options/PromptsSection';
import { Fold } from './options/parts';
import { ShortcutNotice, Shortcuts } from './options/Shortcuts';
import {
  CommonSection,
  FloatSection,
  PermissionsSection,
  ReplySection,
  SitesSection,
} from './options/sections';
import { S } from './options/strings';
import { useSettings } from './options/useSettings';
import { Wizard } from './options/Wizard';
import { T } from './strings';
import './theme.css';
import './options/options.css';

export function OptionsApp() {
  const state = useSettings();
  // 向导只看打开设置页那一刻有没有连接：向导中途保存了连接也不该自己消失
  const [showWizard, setShowWizard] = useState<boolean | null>(null);
  const ready = state.phase === 'ready';
  const noConnection = ready && state.settings.connections.length === 0;
  useEffect(() => {
    if (ready) setShowWizard((v) => v ?? noConnection);
  }, [ready, noConnection]);

  if (state.phase === 'error') {
    return (
      <main class="opt-page">
        <div class="opt-error" role="alert">
          {state.message}
        </div>
      </main>
    );
  }
  if (state.phase === 'loading') {
    return (
      <main class="opt-page">
        <div class="opt-muted">{S.page.loading}</div>
      </main>
    );
  }

  return (
    <main class="opt-page">
      <header class="opt-header">
        <div>
          <div class="opt-brand">{T.brand}</div>
          <h1 class="opt-title">{S.page.title}</h1>
        </div>
        <button
          type="button"
          class="ra-btn"
          title={S.page.openWelcomeTitle}
          onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/welcome.html') })}
        >
          {S.page.openWelcome}
        </button>
      </header>

      {state.saveError && (
        <div class="opt-banner opt-banner--error" role="alert">
          {state.saveError}
        </div>
      )}
      <ShortcutNotice />

      {showWizard && (
        <section class="opt-card" aria-label={S.wizard.heading}>
          <h2 class="opt-card__title">{S.wizard.heading}</h2>
          <Wizard handle={state} onClose={() => setShowWizard(false)} />
        </section>
      )}

      <section class="opt-card" aria-label={S.common.heading} data-testid="common">
        <h2 class="opt-card__title">{S.common.heading}</h2>
        <CommonSection handle={state} />
        <SitesSection handle={state} />
      </section>

      <Fold major title={S.advanced.heading} hint={S.advanced.hint} testId="advanced">
        <Fold title={S.conn.heading} hint={S.conn.summary} testId="fold-connections">
          <ConnectionsSection handle={state} />
        </Fold>
        <Fold title={S.prompts.heading} hint={S.prompts.summary} testId="fold-prompts">
          <PromptsSection handle={state} />
        </Fold>
        <Fold title={S.actions.heading} hint={S.actions.summary} testId="fold-actions">
          <ActionsSection handle={state} />
        </Fold>
        <Fold title={S.reply.heading} hint={S.reply.summary} testId="fold-reply">
          <ReplySection handle={state} />
        </Fold>
        <Fold title={S.float.heading} hint={S.float.summary} testId="fold-float">
          <FloatSection handle={state} />
        </Fold>
        <Fold title={S.shortcuts.heading} hint={S.shortcuts.summary} testId="fold-shortcuts">
          <Shortcuts />
        </Fold>
        <Fold title={S.permissions.heading} hint={S.permissions.summary} testId="fold-permissions">
          <PermissionsSection />
        </Fold>
      </Fold>
    </main>
  );
}
