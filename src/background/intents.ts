// 意图通道（runtime.onMessage，5.12）：内容脚本（哨兵 / 阅读器）→ 后台。
// 角色与身份只取自 sender（规则 7）；每条消息先过 parseFrom，拒绝时不写入、不发指令。
import { BUILTIN_ACTIONS } from '@/core/domain/actions';
import {
  type ContentToBackground,
  contentToBackground,
  type PageConfig,
  parseFrom,
  type RejectReason,
} from '@/core/domain/messages';
import { DEFAULT_SETTINGS } from '@/core/domain/settings';
import { siteLevelFor } from '@/core/domain/site-policy';
import type { BackgroundDeps, SenderLike } from './deps';
import type { FloatHost } from './float-host';
import type { Hub } from './hub';
import { quoteOf } from './quote';
import { senderRole } from './roles';
import type { Store } from './store';

/** 意图的应答。config/get 直接回 PageConfig */
export type IntentResponse = { ok: true } | { ok: false; reason: RejectReason } | PageConfig;

interface ContentSender {
  tabId: number;
  frameId: number;
  documentId: string | undefined;
  url: string | undefined;
}

const hostOf = (url: string | undefined): string => {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
};

export function createIntents(deps: BackgroundDeps, store: Store, hub: Hub, host: FloatHost) {
  const refuse = (reason: RejectReason, detail?: Record<string, unknown>): IntentResponse => {
    deps.log('intent/rejected', { reason, ...detail });
    return { ok: false, reason };
  };

  async function pageConfig(s: ContentSender): Promise<PageConfig> {
    const loaded = await deps.loadSettings();
    const settings = loaded.ok ? loaded.settings : DEFAULT_SETTINGS;
    const hidden = new Set(settings.hiddenActions);
    const defs = [...BUILTIN_ACTIONS, ...settings.customActions];
    const toolbarActions = settings.toolbarActions.flatMap((id) => {
      const d = hidden.has(id) ? undefined : defs.find((a) => a.id === id);
      return d ? [{ id: d.id, label: d.label }] : [];
    });
    return { siteLevel: siteLevelFor(hostOf(s.url), settings.sites), toolbarActions, askRoute: 'float' };
  }

  async function handle(msg: ContentToBackground, s: ContentSender): Promise<IntentResponse> {
    switch (msg.type) {
      case 'selection/ready': {
        if (s.frameId === 0 && s.documentId !== undefined) await host.noteTopDocument(s.tabId, s.documentId);
        await host
          .prewarm(s.tabId)
          .catch((e: unknown) => deps.log('float/prewarmFailed', { error: errName(e) }));
        return { ok: true };
      }
      case 'action/click': {
        // 本版本只接「问」；其他动作回拒绝
        if (msg.actionId !== 'ask') return refuse('notAllowed', { type: msg.type });
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
        // 小窗已订阅（预热过、握手过）就直接换引用
        hub.toTab(s.tabId, quoteOf(sel));
        try {
          await host.show(s.tabId);
        } catch (e) {
          deps.log('float/showFailed', { error: errName(e) });
          await saved;
          return { ok: false, reason: 'invalid' };
        }
        await saved;
        return { ok: true };
      }
      case 'config/get':
        return pageConfig(s);
      case 'float/loadResult': {
        if (msg.result === 'ready') {
          await store.setReadiness(s.tabId, 'ready');
        } else {
          host.markFloatFailed(s.tabId);
          await store.deleteBinding(s.tabId);
          await store.setReadiness(s.tabId, msg.result);
        }
        return { ok: true };
      }
      default:
        // 选区锚点、页面读取、定位、截图本版本不做
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
    return handle(parsed.msg, { tabId, frameId, documentId: sender.documentId, url: sender.url });
  };
}

const errName = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : 'unknown');
