// 欢迎页（L1–L5、决策 038）：首次安装后自动打开，之后可以从设置页重新打开。三件事排成一页，都可以跳过：
// 1. 配置向导（L2）；2. 快速上手：三步图示加示例文章（L3）；3. 当前实际生效的快捷键、把图标固定到工具栏（L4）、
// 安装前已经打开的网页是否已生效（L5）。不做逐步强制引导，不弹模态（M4）。
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { type InstallOpenTabs, SESSION_KEYS } from '@/core/domain/session-keys';
import { Shortcuts } from './options/Shortcuts';
import { S } from './options/strings';
import { useSettings } from './options/useSettings';
import { Wizard } from './options/Wizard';
import { T } from './strings';
import type { DemoHost } from './welcome/demo';
import { QuickStart } from './welcome/QuickStart';
import './theme.css';
import './options/options.css';

const openSettings = () => void browser.runtime.openOptionsPage();

function isInstallOpenTabs(v: unknown): v is InstallOpenTabs {
  const o = v as Partial<InstallOpenTabs> | null | undefined;
  return typeof o?.injected === 'number' && typeof o.failed === 'number';
}

export function WelcomeApp(props: { demo?: DemoHost }) {
  const state = useSettings();

  return (
    <main class="opt-page opt-page--welcome">
      <header class="opt-header opt-header--welcome">
        <div>
          <div class="opt-brand">{T.brand}</div>
          <h1 class="opt-title">{S.welcome.title}</h1>
          <p class="opt-lead">{S.welcome.lead}</p>
        </div>
      </header>

      <section class="opt-card" aria-label={S.welcome.step1} data-testid="welcome-step-1">
        <h2 class="opt-card__title">
          <span class="opt-stepno">1</span>
          {S.welcome.step1}
        </h2>
        {state.phase === 'loading' && <div class="opt-muted">{S.page.loading}</div>}
        {state.phase === 'error' && (
          <div class="opt-error" role="alert">
            {state.message}
          </div>
        )}
        {state.phase === 'ready' && <Wizard handle={state} showSettingsLink onOpenSettings={openSettings} />}
      </section>

      <section class="opt-card" aria-label={S.welcome.step2} data-testid="welcome-step-2">
        <h2 class="opt-card__title">
          <span class="opt-stepno">2</span>
          {S.welcome.step2}
        </h2>
        <QuickStart
          {...(props.demo ? { demo: props.demo } : {})}
          hasModel={state.phase === 'ready' && state.settings.defaultModel !== undefined}
        />
      </section>

      <section class="opt-card" aria-label={S.welcome.step3} data-testid="welcome-step-3">
        <h2 class="opt-card__title">
          <span class="opt-stepno">3</span>
          {S.welcome.step3}
        </h2>
        <Shortcuts />
        <PinHint />
        <OpenTabsHint />
      </section>

      <footer class="opt-footer">
        <span>{S.welcome.done}</span>
        <button type="button" class="ra-btn" onClick={openSettings}>
          {S.welcome.openSettings}
        </button>
      </footer>
    </main>
  );
}

/** 把图标固定到工具栏（L4）：已经固定了就只说一句，没固定给出做法。扩展自己没法替用户固定 */
function PinHint() {
  const [pinned, setPinned] = useState<boolean | null>(null);
  useEffect(() => {
    const read = () =>
      void browser.action.getUserSettings().then(
        (s) => setPinned(s.isOnToolbar === true),
        () => setPinned(false),
      );
    read();
    // 用户照着做完，图标状态变了就跟着更新
    const onChanged = (c: { isOnToolbar?: boolean }) => {
      if (c.isOnToolbar !== undefined) setPinned(c.isOnToolbar);
    };
    const event = browser.action.onUserSettingsChanged;
    event?.addListener(onChanged);
    return () => event?.removeListener(onChanged);
  }, []);
  if (pinned === null) return null;
  return (
    <div class="opt-hint" data-testid="pin-hint" data-pinned={pinned ? 'true' : 'false'}>
      <h3 class="opt-subtitle">{S.setup.pinTitle}</h3>
      <div class="opt-help">{pinned ? S.setup.pinned : S.setup.pinHelp}</div>
    </div>
  );
}

/** 安装前已经打开的网页（L5）：后台安装时已补注入哨兵，这里说明结果；没能生效的提示刷新一次 */
function OpenTabsHint() {
  const [result, setResult] = useState<InstallOpenTabs | null>(null);
  useEffect(() => {
    const key = SESSION_KEYS.installOpenTabs;
    const apply = (v: unknown) => isInstallOpenTabs(v) && setResult(v);
    void browser.storage.session.get(key).then((got) => apply(got[key]));
    // 补注入要等所有网页应答，可能晚于欢迎页打开
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && changes[key]) apply(changes[key].newValue);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);
  return (
    <div class="opt-hint" data-testid="open-tabs-hint">
      <h3 class="opt-subtitle">{S.setup.openTabsTitle}</h3>
      <div class="opt-help">
        {result && result.injected > 0 ? S.setup.openTabsOk(result.injected) : S.setup.openTabsNone}
      </div>
      {result && result.failed > 0 && <div class="opt-warn">{S.setup.openTabsFailed(result.failed)}</div>}
      <div class="opt-help">{S.setup.openTabsNote}</div>
    </div>
  );
}
