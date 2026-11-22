// 「总结本页」完整版（6.2、I6、验收第 8 条）：同一页面（pageKey）上次的总结。
// | 场景 | 做法 |
// | 小窗 / 侧边栏打开（summary/get） | 查 PageRecord.lastSummary；有就让阅读器重新算一次内容指纹（不发给模型）与总结所基于的版本比较，回 summary/last |
// | 再点「总结本页」（工具栏、右键、快捷键） | 页面没变就直接显示上次的（推 summary/last，show 为真），不重新请求、不花钱；变了或核对不了照常发起新总结 |
// | 「重新总结」 | 界面直接发 conv/ask（summarizePage），不经这里 |
// 推送时界面可能还没连上（小窗刚显示、侧边栏刚打开）：记一个短期标记，它订阅后第一次 summary/get 时带上 show。
import { toPageKey } from '@/core/context/page-key';
import { truncateByJsonBytes } from '@/core/domain/bytes';
import { JOB_LIMITS } from '@/core/domain/job';
import type { BackgroundToClient, ClientToBackground, LastSummary } from '@/core/domain/messages';
import type { MessageRecord } from '@/core/domain/records';
import type { BackgroundDeps } from './deps';
import type { History } from './history';
import type { Hub } from './hub';
import type { Pages } from './pages';

type GetMsg = Extract<ClientToBackground, { type: 'summary/get' }>;
type Reply = (msg: BackgroundToClient) => void;

/** 「直接显示上次的」标记的有效期：够小窗显示、侧边栏打开并订阅 */
export const SHOW_TTL_MS = 15_000;

/** 只给界面显示用：去掉思考过程，正文过长时截断（整条消息不超过 64 KB） */
function forDisplay(m: MessageRecord): MessageRecord {
  const { reasoning: _reasoning, ...rest } = m;
  const text = m.segments.map((s) => (s.kind === 'text' ? s.text : '')).join('');
  const cut = truncateByJsonBytes(text, JOB_LIMITS.maxFieldBytes).text;
  return { ...rest, segments: [{ kind: 'text', text: cut }] };
}

export type Summary = ReturnType<typeof createSummary>;

export function createSummary(deps: BackgroundDeps, history: History, pages: Pages, hub: Hub) {
  const showUntil = new Map<number, number>();

  async function lastFor(tabId: number): Promise<LastSummary | undefined> {
    const url = await deps.getTabUrl?.(tabId).catch(() => undefined);
    const pageKey = url === undefined ? undefined : toPageKey(url);
    if (pageKey === undefined) return undefined;
    const last = await history.lastSummary(pageKey).catch(() => undefined);
    if (!last) return undefined;
    const loaded = await deps.loadSettings();
    const now = loaded.ok ? await pages.currentVersion(tabId, loaded.settings) : undefined;
    return {
      message: forDisplay(last.message),
      contentVersion: last.contentVersion,
      current: now === undefined ? 'unknown' : now === last.contentVersion ? 'same' : 'changed',
    };
  }

  function takeShow(tabId: number): boolean {
    const until = showUntil.get(tabId);
    showUntil.delete(tabId);
    return until !== undefined && until > deps.now();
  }

  return {
    /** summary/get：tabId 由对话端口给出（规则 7） */
    async get(tabId: number, msg: GetMsg, reply: Reply): Promise<void> {
      const summary = await lastFor(tabId);
      const show = summary !== undefined && takeShow(tabId);
      reply({
        type: 'summary/last',
        requestId: msg.requestId,
        tabId,
        ...(summary ? { summary } : {}),
        ...(show ? { show } : {}),
      });
    },

    /**
     * 后台替用户发起「总结本页」之前调用：这一页有上次的总结、且页面内容没变，就直接显示它并返回 true（调用方不再发请求）
     */
    async tryReuse(tabId: number): Promise<boolean> {
      const summary = await lastFor(tabId);
      if (summary?.current !== 'same') return false;
      deps.log('summary/reused', {});
      // 已连着的界面直接推；刚打开、还没订阅的（侧边栏、新建的小窗）订阅后来取时带上 show
      hub.toTab(tabId, { type: 'summary/last', tabId, summary, show: true });
      showUntil.set(tabId, deps.now() + SHOW_TTL_MS);
      return true;
    },

    forgetTab(tabId: number): void {
      showUntil.delete(tabId);
    },
  };
}
