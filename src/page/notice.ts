// 网页上的一行提示（M4：不用模态、不挡输入）：小窗用不了、侧边栏又没能替用户打开时，告诉用户怎么在侧边栏继续。
// 封闭 Shadow DOM + popover 顶层；整条 pointer-events: none，不拦网页上的任何点击与输入；
// 显示一段时间后自动消失，按 Esc 或点网页也消失。只放固定文案，不放任何对话内容（规则 4）。
// 「加载失败」与「网站不支持」分开说，不把前者说成后者（V-02）。

export type PageNoticeKind = 'floatFailed' | 'floatUnsupported';

const HOW = '请点浏览器工具栏里的「阅读助手」图标，或按 Alt+Shift+D，在侧边栏继续；刚才选中的文字会带过去。';

export const PAGE_NOTICE_TEXT: Readonly<Record<PageNoticeKind, string>> = {
  floatFailed: `小窗这次没能加载出来。${HOW}`,
  floatUnsupported: `这个网站放不了小窗。${HOW}`,
};

/** 自动消失前停留的时间 */
export const PAGE_NOTICE_MS = 10_000;

export interface PageNotice {
  show(kind: PageNoticeKind): void;
  hide(): void;
}

export function createPageNotice(): PageNotice {
  let host: HTMLElement | null = null;
  let text: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function build(): void {
    const h = document.createElement('div');
    h.popover = 'manual';
    h.dataset.raPageNotice = 'true';
    Object.assign(h.style, {
      position: 'fixed',
      inset: 'auto',
      left: '50%',
      bottom: '24px',
      transform: 'translateX(-50%)',
      margin: '0',
      padding: '0',
      border: 'none',
      background: 'transparent',
      overflow: 'visible',
      pointerEvents: 'none',
      zIndex: '2147483647',
    });
    const shadow = h.attachShadow({ mode: 'closed' });
    const t = document.createElement('div');
    t.setAttribute('role', 'status');
    Object.assign(t.style, {
      maxWidth: '560px',
      padding: '8px 14px',
      borderRadius: '6px',
      background: '#1f1f1f',
      color: '#fff',
      font: '13px/20px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
      pointerEvents: 'none',
    });
    shadow.append(t);
    document.documentElement.append(h);
    host = h;
    text = t;
  }

  function hide(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (host?.isConnected && host.matches(':popover-open')) host.hidePopover();
  }

  // 按 Esc、点网页都让提示消失；被动监听，不影响网页
  document.addEventListener('keydown', (e) => e.isTrusted && e.key === 'Escape' && hide(), {
    capture: true,
    passive: true,
  });
  document.addEventListener('pointerdown', (e) => e.isTrusted && hide(), { capture: true, passive: true });

  return {
    show(kind) {
      if (!host?.isConnected) build();
      if (!host || !text) return;
      text.textContent = PAGE_NOTICE_TEXT[kind];
      if (!host.matches(':popover-open')) host.showPopover();
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(hide, PAGE_NOTICE_MS);
    },
    hide,
  };
}
