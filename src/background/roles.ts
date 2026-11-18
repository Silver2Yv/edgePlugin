// 从 sender 推角色（5.12 SenderRole 判定表）。身份只取自 sender，不看消息内容（规则 7）。
import type { SenderRole } from '@/core/domain/messages';
import type { SelfInfo, SenderLike } from './deps';

/**
 * | 角色 | 判定 |
 * | content | sender.id 是本扩展，sender.url 不是扩展页面，带 tab 与 frameId |
 * | float | sender.url 的路径是 /float.html，且在某个标签页里 |
 * | sidepanel | 路径是 /sidepanel.html，不在标签页里 |
 * | options | 路径是 /options.html 或 /welcome.html |
 * 扩展页面只按路径判定：小窗声明了 use_dynamic_url，sender.url 的主机可能是动态 ID 而不是扩展 ID；
 * 是不是本扩展已由 sender.id 核对。
 */
export function senderRole(sender: SenderLike, self: SelfInfo): SenderRole {
  if (sender.id === undefined || sender.id !== self.runtimeId || !sender.url) return 'unknown';
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return 'unknown';
  }
  const inTab = typeof sender.tab?.id === 'number';
  if (url.protocol !== self.protocol) {
    return inTab && typeof sender.frameId === 'number' ? 'content' : 'unknown';
  }
  switch (url.pathname) {
    case '/float.html':
      return inTab ? 'float' : 'unknown';
    case '/sidepanel.html':
      return inTab ? 'unknown' : 'sidepanel';
    case '/options.html':
    case '/welcome.html':
      return 'options';
    default:
      return 'unknown';
  }
}

/** 诊断用的 sender 摘要（V-05）：地址去掉片段（片段里是令牌），不记 documentId 本身 */
export function senderSummary(sender: SenderLike, self: SelfInfo): Record<string, unknown> {
  const url = sender.url ?? '';
  const hash = url.indexOf('#');
  return {
    url: hash < 0 ? url : url.slice(0, hash),
    urlHasFragment: hash >= 0,
    origin: sender.origin,
    idIsSelf: sender.id === self.runtimeId,
    hostIsRuntimeId: url.includes(`//${self.runtimeId}/`),
    tabId: sender.tab?.id,
    frameId: sender.frameId,
    hasDocumentId: typeof sender.documentId === 'string',
    documentLifecycle: sender.documentLifecycle,
  };
}
