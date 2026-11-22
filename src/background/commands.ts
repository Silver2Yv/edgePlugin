// 快捷键与右键菜单（5.1、5.2、5.4、6.2）。处理函数在事件的同步段里先做要用户手势的事（sidePanel.open，规则 10），
// 之后才 await。commands.onCommand、contextMenus.onClicked 的处理函数里同步调用 open 可以打开侧边栏。
//
// | 入口 | 做什么 |
// | 快捷键「开关侧边栏」 | 总是同步 open；记下命令时间并广播，之前就开着的面板自行关闭（5.4，V-11） |
// | 快捷键「打开小窗」 | 无选区唤起：注入阅读器、显示小窗（5.2 末条）；小窗失败过或这页放不了小窗时同步开侧边栏 |
// | 快捷键 / 右键「总结本页」 | 同步开侧边栏，后台用固定问题发起一次整页请求，侧边栏订阅时接上（6.2 最小版） |
// | 右键「问」 | 选中文字取自浏览器（info.selectionText），不依赖哨兵；按需注入阅读器走小窗，去向同工具栏 |
// | 快捷键「框选截图」 | 去向同「问」：要改走侧边栏就同步 open；注入阅读器显示遮罩，截好后预览去小窗或侧边栏（capture.ts） |
import { BUILTIN_ACTIONS, CONTEXT_MENU_ACTIONS } from '@/core/domain/actions';
import { truncateByJsonBytes } from '@/core/domain/bytes';
import { floatHostable } from '@/core/domain/float';
import { JOB_LIMITS } from '@/core/domain/job';
import type { PanelNoticeKind } from '@/core/domain/messages';
import { SUMMARIZE_PAGE_QUESTION } from '@/core/prompt/ask';
import type { Capture } from './capture';
import type { BackgroundDeps } from './deps';
import type { FloatHost } from './float-host';
import type { Hub } from './hub';
import type { Jobs } from './jobs';
import { quoteOf } from './quote';
import type { Route } from './route';
import type { Store, StoredSelection } from './store';
import type { Summary } from './summary';

/** commands.onCommand / contextMenus.onClicked 给的标签页里用到的部分 */
export interface CommandTab {
  id?: number | undefined;
  windowId?: number | undefined;
  url?: string | undefined;
}

/** contextMenus.onClicked 的 info 里用到的部分 */
export interface MenuInfo {
  menuItemId: string | number;
  selectionText?: string | undefined;
  editable?: boolean | undefined;
  frameId?: number | undefined;
}

/** 右键菜单项：编号即动作编号（CONTEXT_MENU_ACTIONS 里本版本做的两个；「解释」不做） */
type MenuContext = 'selection' | 'page';
export const MENU_ITEMS: readonly { id: string; title: string; contexts: [MenuContext, ...MenuContext[]] }[] =
  (
    [
      { id: 'ask', title: '问「%s」', contexts: ['selection'] },
      {
        id: 'summarizePage',
        title: BUILTIN_ACTIONS.find((a) => a.id === 'summarizePage')?.label ?? '总结本页',
        contexts: ['page', 'selection'],
      },
    ] as const satisfies readonly { id: string; title: string; contexts: [MenuContext, ...MenuContext[]] }[]
  ).filter((m) => CONTEXT_MENU_ACTIONS.includes(m.id));

const errName = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : 'unknown');

export type Commands = ReturnType<typeof createCommands>;

export function createCommands(
  deps: BackgroundDeps,
  store: Store,
  hub: Hub,
  host: FloatHost,
  jobs: Jobs,
  route: Route,
  /** cite 块：页面没变时复用上次总结；capture 块：框选截图（都可选只是为了不打扰只测别的模块的单测） */
  extra: { summary?: Summary; capture?: Capture } = {},
) {
  const notice = (tabId: number, kind: PanelNoticeKind) => {
    store.putNotice(tabId, kind);
    hub.toTab(tabId, { type: 'conv/notice', kind });
  };

  /** 开关侧边栏（5.4）：open 必须第一个发出；广播之前先记下时间，面板「先读记录、后挂监听」之间不留空隙 */
  function togglePanel(windowId: number): void {
    const at = deps.now();
    const opened = deps.openSidePanel(windowId);
    void opened.catch((e: unknown) => deps.log('sidepanel/openFailed', { via: 'toggle', error: errName(e) }));
    void store
      .setPanelToggle(windowId, at)
      .then(() => deps.notifyPages({ type: 'sidepanel/toggle', windowId, at }))
      .catch((e: unknown) => deps.log('sidepanel/toggleFailed', { error: errName(e) }));
  }

  /** 后台替侧边栏发起「总结本页」：任务归后台（规则 2），侧边栏订阅这个标签页时从头续播 */
  async function startSummary(tabId: number): Promise<void> {
    const loaded = await deps.loadSettings();
    const s = loaded.ok ? loaded.settings : undefined;
    if (!s?.defaultModel) return notice(tabId, 'noConnection');
    // 页面没变就直接显示上次的总结，不重新请求（6.2、第 3 节）
    if (await extra.summary?.tryReuse(tabId)) return;
    await jobs.ask(
      tabId,
      {
        type: 'conv/ask',
        clientRequestId: deps.newId(),
        actionId: 'summarizePage',
        text: SUMMARIZE_PAGE_QUESTION,
        contextTier: 'fullPage',
        lengthTier: s.reply.lengthTier,
        thinking: s.reply.thinking,
        model: s.defaultModel,
      },
      (m) => {
        if (m.type !== 'conv/rejected') return;
        deps.log('summary/rejected', { reason: m.reason });
        notice(tabId, 'requestRefused');
      },
    );
  }

  function summarize(tab: CommandTab): void {
    const { id: tabId, windowId } = tab;
    if (tabId === undefined || windowId === undefined) return;
    const opened = deps.openSidePanel(windowId);
    void opened.catch((e: unknown) =>
      deps.log('sidepanel/openFailed', { via: 'summary', error: errName(e) }),
    );
    void deps.notifyPages({ type: 'sidepanel/wake', windowId });
    void startSummary(tabId).catch((e: unknown) => deps.log('summary/failed', { error: errName(e) }));
  }

  /** 无选区唤起小窗（5.2 末条）。这一页放不了小窗（看不到地址）时改开侧边栏，不提示小窗失败 */
  function openFloat(tab: CommandTab): void {
    const { id: tabId, windowId } = tab;
    if (tabId === undefined) return;
    const hostable = floatHostable(tab.url);
    const d = route.decide(tabId, windowId, { forcePanel: !hostable });
    if (d.toPanel) {
      void route.finish(tabId, d, hostable);
      return;
    }
    void host.show(tabId).catch((e: unknown) => {
      deps.log('float/showFailed', { error: errName(e) });
      // 这一页注入不了阅读器（安装前就开着、补注入没成功的网页，或扩展商店这类页面，L5）：网页上没法提示，
      // 记成这次失败——再按一次快捷键就同步改开侧边栏，并在顶部说明原因（5.2 偶发失败的口径）
      void store.setReadiness(tabId, 'failedTransient');
    });
  }

  /** 右键「问」：选中文字由浏览器给出；表单与可编辑区域里的不读（M6，与 SelectionPolicy 同口径） */
  function menuAsk(info: MenuInfo, tab: CommandTab): void {
    const { id: tabId, windowId } = tab;
    const raw = info.selectionText ?? '';
    if (tabId === undefined || info.editable || raw.trim() === '') return;
    const hostable = floatHostable(tab.url);
    const d = route.decide(tabId, windowId, { forcePanel: !hostable });
    const { text, truncated } = truncateByJsonBytes(raw, JOB_LIMITS.maxFieldBytes);
    const now = deps.now();
    // 修订号用时间：与哨兵各框架自己数的修订号不会撞上；conv/ask 按它取这一份
    const sel: StoredSelection = {
      frameId: info.frameId ?? 0,
      selectionRevision: now,
      text,
      truncated,
      originalLength: [...raw].length,
      inCode: false,
      at: now,
    };
    const saved = store.putSelection(tabId, sel);
    hub.toTab(tabId, quoteOf(sel));
    void saved.catch(() => undefined);
    if (d.toPanel) {
      void route.finish(tabId, d, hostable);
      return;
    }
    // 去向同工具栏：本窗口侧边栏开着就在侧边栏回答（引用已推给它）
    void (async () => {
      if (windowId !== undefined && (await route.panelOpenIn(windowId))) return;
      await host.show(tabId);
    })().catch((e: unknown) => deps.log('float/showFailed', { error: errName(e) }));
  }

  return {
    onCommand(command: string, tab: CommandTab | undefined): void {
      if (!tab) return;
      switch (command) {
        case 'toggle-sidepanel':
          if (tab.windowId !== undefined) togglePanel(tab.windowId);
          return;
        case 'open-float':
          openFloat(tab);
          return;
        case 'summarize-page':
          summarize(tab);
          return;
        case 'capture-region':
          // 同步段里调用：要开侧边栏的当场 open（规则 10）
          if (extra.capture) extra.capture.command(tab);
          return;
        default:
          deps.log('command/ignored', { command });
      }
    },

    onMenuClicked(info: MenuInfo, tab: CommandTab | undefined): void {
      if (!tab) return;
      if (info.menuItemId === 'ask') menuAsk(info, tab);
      else if (info.menuItemId === 'summarizePage') summarize(tab);
    },
  };
}
