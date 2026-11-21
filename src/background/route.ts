// 小窗与侧边栏之间的去向（5.2、5.4、6.3）：工具栏「问」、右键「问」、小窗快捷键共用。
// 划词去向（5.4、B7，用户 11-21 确认）：本窗口侧边栏开着就在侧边栏回答，不开小窗；否则按小窗就绪状态走。
// 侧边栏已经开着就不用 open，所以「开没开」可以异步判断（panelOpenIn）：看本窗口有没有已握手的侧边栏端口（hub）；
// 后台刚被唤醒时面板断线闲着、还没重连，有侧边栏存在就叫醒它，等它握手。读网页时后台多半已被回收，这是常态。
// decide() 必须在用户手势事件的同步段里调用：要改走侧边栏就当场 open（规则 10），所以只读内存里的就绪状态。
// 实测（Chrome 159、Edge 157）：内容脚本点击经 runtime.sendMessage 到后台，处理函数第一时间同步 open 可以打开；
// 之前有任何 await 都会被拒。打不开时在网页上提示用快捷键或工具栏图标继续（M4），选区已存下，侧边栏打开时带上引用。
import { type FloatReadiness, routeOnAsk } from '@/core/domain/float';
import type { BackgroundDeps } from './deps';
import type { FloatHost } from './float-host';
import type { Hub } from './hub';
import type { Store } from './store';

/** 叫醒断线闲着的侧边栏后，最多等它握手多久；只在确有侧边栏开着、但还没登记时才等 */
const PANEL_WAKE_MS = 1_500;

export interface RouteDecision {
  toPanel: boolean;
  readiness: FloatReadiness;
  /** 改走侧边栏时 open 的结果（已在同步段里发出） */
  opened: Promise<void> | undefined;
  windowId: number | undefined;
}

export type Route = ReturnType<typeof createRoute>;

export function createRoute(deps: BackgroundDeps, store: Store, hub: Hub, host: FloatHost) {
  return {
    /**
     * 同步决定要不要打开侧边栏（小窗失败过、或这一页放不了小窗）。forcePanel：这一页根本放不了小窗
     * （浏览器内部页面等，见 commands.ts）。windowId 不知道时打不开侧边栏，按打不开处理
     */
    decide(tabId: number, windowId: number | undefined, opts: { forcePanel?: boolean } = {}): RouteDecision {
      const readiness = store.readinessNow(tabId);
      const toPanel = opts.forcePanel === true || routeOnAsk(readiness) === 'sidepanel';
      const opened = toPanel && windowId !== undefined ? deps.openSidePanel(windowId) : undefined;
      return { toPanel, readiness, opened, windowId };
    },

    /**
     * 本窗口侧边栏开没开（划词提问用：工具栏、右键「问」；「打开小窗」快捷键不看）。已登记就是开着；
     * 一个侧边栏都没有就是没开；有侧边栏但没登记（后台刚被唤醒），叫醒本窗口的、等它握手，
     * 等不到（侧边栏在别的窗口）就当没开
     */
    async panelOpenIn(windowId: number): Promise<boolean> {
      if (hub.hasPanel(windowId)) return true;
      if (!(await deps.sidePanelOpen())) return false;
      void deps.notifyPages({ type: 'sidepanel/wake', windowId });
      return hub.waitPanel(windowId, deps.panelWakeMs ?? PANEL_WAKE_MS);
    },

    /**
     * 改走侧边栏之后：顶部说明原因（侧边栏已订阅就实时推，没订阅就等它订阅时取）；偶发失败只代表这一次（5.2），
     * 下次重新试小窗；浏览器没让打开侧边栏时在网页上提示。notice 为 false 时不提示原因（这一页本来就放不了小窗）
     */
    async finish(tabId: number, d: RouteDecision, notice = true): Promise<boolean> {
      const kind = d.readiness === 'failedUnsupported' ? 'floatUnsupported' : 'floatTransient';
      if (notice) {
        store.putNotice(tabId, kind);
        hub.toTab(tabId, { type: 'conv/notice', kind });
      }
      if (d.readiness === 'failedTransient') await store.setReadiness(tabId, 'unknown');
      // 面板本来就开着、但后台被回收后断线闲着：叫它重连，好显示这次的引用与说明
      if (d.windowId !== undefined) void deps.notifyPages({ type: 'sidepanel/wake', windowId: d.windowId });
      const ok = d.opened
        ? await d.opened.then(
            () => true,
            () => false,
          )
        : false;
      deps.log('route/sidepanel', { readiness: d.readiness, opened: ok });
      if (!ok && notice) {
        await host
          .notice(tabId, kind === 'floatUnsupported' ? 'floatUnsupported' : 'floatFailed')
          .catch((e: unknown) =>
            deps.log('page/noticeFailed', {
              error: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
            }),
          );
      }
      return ok;
    },
  };
}
