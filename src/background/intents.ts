// 意图通道（runtime.onMessage，5.12）：内容脚本（哨兵 / 阅读器）→ 后台。
// 角色与身份只取自 sender（规则 7）；每条消息先过 parseFrom，拒绝时不写入、不发指令。
import { type ActionDef, BUILTIN_ACTIONS } from '@/core/domain/actions';
import { routeOnAsk } from '@/core/domain/float';
import {
  type ContentToBackground,
  contentToBackground,
  type PageConfig,
  type PanelNoticeKind,
  parseFrom,
  type RejectReason,
} from '@/core/domain/messages';
import { DEFAULT_SETTINGS } from '@/core/domain/settings';
import { frameSiteLevel } from '@/core/domain/site-policy';
import { SUMMARIZE_PAGE_QUESTION } from '@/core/prompt/ask';
import type { BackgroundDeps, SenderLike } from './deps';
import type { FloatHost } from './float-host';
import type { Hub } from './hub';
import type { Jobs } from './jobs';
import type { Pages } from './pages';
import { quoteOf } from './quote';
import { senderRole } from './roles';
import type { Route } from './route';
import type { Store, StoredSelection } from './store';

/** 意图的应答。config/get 直接回 PageConfig */
export type IntentResponse = { ok: true } | { ok: false; reason: RejectReason } | PageConfig;

interface ContentSender {
  tabId: number;
  frameId: number;
  documentId: string | undefined;
  url: string | undefined;
  /** 标签页所在窗口（sender.tab，浏览器给的） */
  windowId: number | undefined;
}

const errName = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : 'unknown');

export function createIntents(
  deps: BackgroundDeps,
  store: Store,
  hub: Hub,
  host: FloatHost,
  pages: Pages,
  route: Route,
  jobs: Jobs,
) {
  const refuse = (reason: RejectReason, detail?: Record<string, unknown>): IntentResponse => {
    deps.log('intent/rejected', { reason, ...detail });
    return { ok: false, reason };
  };

  const notice = (tabId: number, kind: PanelNoticeKind) => {
    store.putNotice(tabId, kind);
    hub.toTab(tabId, { type: 'conv/notice', kind });
  };

  /** 直接发送动作（needsInput 为假）的默认问题：没有选区可引用时（页面类）用它当 text（prompts 块再接管具体措辞） */
  const directQuestion = (def: ActionDef): string =>
    def.id === 'summarizePage' ? SUMMARIZE_PAGE_QUESTION : def.label;

  /**
   * 「问」等输入；其余已知为直接发送的动作（explain/explainCode/translate/summarizePage/keyPoints/
   * pageAbout、以及自定义动作里 needsInput 为假的）由后台自己起个任务（任务归后台，规则 2）。
   * 选区类动作带上这次存下的选区；页面类动作照「总结本页」的路径发起，不带选区（与 commands.ts 的 startSummary 同例）。
   * 档位、长度、思考取设置默认值，模型取默认模型，text 为空串时各动作的默认问题由 prompts 块在装配里补。
   */
  async function startActionIfDirect(
    tabId: number,
    actionId: string,
    sel: StoredSelection,
    builtin: ActionDef | undefined,
  ): Promise<void> {
    if (builtin?.needsInput) return; // 「问」：等界面里输入，不帮它起任务
    const loaded = await deps.loadSettings();
    const settings = loaded.ok ? loaded.settings : undefined;
    const def = builtin ?? settings?.customActions.find((a) => a.id === actionId);
    if (def?.kind !== 'model' || def.needsInput) {
      if (!def) deps.log('action/unknown', { actionId });
      return;
    }
    if (!settings?.defaultModel) return notice(tabId, 'noConnection');
    const isPage = def.scope === 'page';
    await jobs.ask(
      tabId,
      {
        type: 'conv/ask',
        clientRequestId: deps.newId(),
        actionId: def.id,
        text: isPage ? directQuestion(def) : '',
        ...(isPage ? {} : { selectionRevision: sel.selectionRevision }),
        contextTier: isPage ? 'fullPage' : settings.context.defaultTier,
        lengthTier: settings.reply.lengthTier,
        thinking: settings.reply.thinking,
        model: settings.defaultModel,
      },
      (m) => {
        if (m.type !== 'conv/rejected') return;
        deps.log('action/rejected', { reason: m.reason, actionId: def.id });
        notice(tabId, 'requestRefused');
      },
    );
  }

  async function pageConfig(s: ContentSender): Promise<PageConfig> {
    const loaded = await deps.loadSettings();
    const settings = loaded.ok ? loaded.settings : DEFAULT_SETTINGS;
    const hidden = new Set(settings.hiddenActions);
    const defs = [...BUILTIN_ACTIONS, ...settings.customActions];
    const toolbarActions = settings.toolbarActions.flatMap((id) => {
      const d = hidden.has(id) ? undefined : defs.find((a) => a.id === id);
      return d ? [{ id: d.id, label: d.label, kind: d.kind, needsInput: d.needsInput, scope: d.scope }] : [];
    });
    // 子框架取「顶层站点与框架来源」更严（4.1、AR-14）；顶层框架两者相同，不必再查标签页地址
    const topUrl = s.frameId === 0 ? s.url : await deps.getTabUrl?.(s.tabId).catch(() => undefined);
    const siteLevel = frameSiteLevel(topUrl, s.url, settings.sites);
    const panelOpen = s.windowId !== undefined && hub.hasPanel(s.windowId);
    return {
      siteLevel,
      toolbarActions,
      askRoute: panelOpen ? 'sidepanel' : routeOnAsk(store.readinessNow(s.tabId)),
    };
  }

  async function handle(msg: ContentToBackground, s: ContentSender): Promise<IntentResponse> {
    switch (msg.type) {
      case 'selection/ready': {
        // 本窗口侧边栏开着、但后台刚被唤醒还没登记到它：现在就叫醒，紧接着的点击不用再等它握手
        if (s.windowId !== undefined)
          void route
            .panelOpenIn(s.windowId)
            .catch((e: unknown) => deps.log('sidepanel/wakeFailed', { error: errName(e) }));
        if (s.frameId === 0 && s.documentId !== undefined) await host.noteTopDocument(s.tabId, s.documentId);
        await host
          .prewarm(s.tabId)
          .catch((e: unknown) => deps.log('float/prewarmFailed', { error: errName(e) }));
        return { ok: true };
      }
      case 'action/click': {
        // 内置「存」类动作本版本不发请求：提前拒绝，不触发任何路由副作用（工具栏本应已经本地拦截，这里是兜底）
        const builtin = BUILTIN_ACTIONS.find((a) => a.id === msg.actionId);
        if (builtin && builtin.kind !== 'model') return refuse('notAllowed', { type: msg.type });
        // 去向（5.2、5.4）：小窗失败过就打开侧边栏——必须在这条点击消息的同步段里发出（规则 10），先于一切
        // await；本窗口侧边栏已经开着就在侧边栏回答，不用 open，可以之后再判断（见 route.ts）
        const d = route.decide(s.tabId, s.windowId);
        const sel = {
          frameId: s.frameId,
          ...(s.documentId === undefined ? {} : { documentId: s.documentId }),
          selectionRevision: msg.selectionRevision,
          text: msg.text,
          truncated: msg.truncated,
          originalLength: msg.originalLength,
          inCode: msg.inCode,
          at: deps.now(),
        };
        const saved = store.putSelection(s.tabId, sel);
        // 小窗、侧边栏已订阅就直接换引用
        hub.toTab(s.tabId, quoteOf(sel));
        let ok = true;
        if (d.toPanel) {
          await route.finish(s.tabId, d);
        } else if (s.windowId !== undefined && (await route.panelOpenIn(s.windowId))) {
          // 侧边栏开着：引用已推给它（刚握手、还没订阅的，订阅时取存下的选区），不开小窗
          deps.log('route/sidepanel', { readiness: d.readiness, panelOpen: true });
        } else {
          try {
            await host.show(s.tabId);
          } catch (e) {
            deps.log('float/showFailed', { error: errName(e) });
            ok = false;
          }
        }
        await saved;
        if (!ok) return { ok: false, reason: 'invalid' };
        // 「问」等输入；其余直接发送的动作由后台自己起个任务，不等这条意图应答（规则 2）
        void startActionIfDirect(s.tabId, msg.actionId, sel, builtin).catch((e: unknown) =>
          deps.log('action/startFailed', { error: errName(e) }),
        );
        return { ok: true };
      }
      case 'config/get':
        return pageConfig(s);
      case 'float/loadResult': {
        if (msg.result === 'ready') {
          await store.setReadiness(s.tabId, 'ready');
        } else {
          host.markFloatFailed(s.tabId);
          // 用户接着用快捷键或图标打开侧边栏时，顶部说明原因（网页上已经提示过怎么继续）
          store.putNotice(
            s.tabId,
            msg.result === 'failedUnsupported' ? 'floatUnsupported' : 'floatTransient',
          );
          await store.deleteBinding(s.tabId);
          await store.setReadiness(s.tabId, msg.result);
        }
        return { ok: true };
      }
      // 页面读取（5.6）：身份取自 sender，对不上这次读取的标签页、顶层框架、文档就拒绝（规则 7）
      case 'page/docPart':
      case 'page/docUnchanged': {
        const reason = msg.type === 'page/docPart' ? pages.onDocPart(msg, s) : pages.onDocUnchanged(msg, s);
        return reason ? refuse(reason, { type: msg.type }) : { ok: true };
      }
      case 'selection/anchored':
        return pages.onAnchored(msg, s) ? { ok: true } : refuse('notOwner', { type: msg.type });
      default:
        // 定位、截图本版本不做
        return refuse('notAllowed', { type: msg.type });
    }
  }

  return async function onMessage(raw: unknown, sender: SenderLike): Promise<IntentResponse> {
    const role = senderRole(sender, deps.self);
    // 设置页 / 欢迎页的消息本版本不做；扩展页面走对话端口，不走这里
    if (role !== 'content') return refuse('notAllowed', { role });
    const parsed = parseFrom(role, contentToBackground, raw);
    if (!parsed.ok)
      return refuse(parsed.reason, { role, ...(parsed.detail ? { detail: parsed.detail } : {}) });
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (tabId === undefined || frameId === undefined) return refuse('notAllowed', { role });
    return handle(parsed.msg, {
      tabId,
      frameId,
      documentId: sender.documentId,
      url: sender.url,
      windowId: sender.tab?.windowId,
    });
  };
}
