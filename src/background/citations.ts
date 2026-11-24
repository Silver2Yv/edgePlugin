// 引用跳回原文（5.7、F1、F2）与回到刚才的位置（F4）：界面点了回答里的引用（citation/locate），后台核对、算锚点，
// 再让所订阅标签页顶层框架的阅读器定位与高亮（page/locate），结果回 citation/located。
//
// | 步骤 | 依据 |
// | 核对编号 | 编号必须属于这条消息那次请求实际发送的块（plan.sentBlockIds，规则 9）；界面报来的编号只是「点了哪个」 |
// | 核对页面 | 消息的计划属于标签页当前页面（pageKey）；别的页面的回答在这里跳不了（otherPage） |
// | 算锚点 | 快照（7 天内）里有块文本：逐字引用在块里找原文，要点编号用整块；快照过期只能按引用原文，且原文须在回答里核对过 |
// | 发给谁 | 标签页顶层框架、注入阅读器时拿到的那个文档（documentId）；结果只认同一标签页、顶层、同一文档发来的（规则 7） |
// | 高亮样式 | 每个文档注入一次 ::highlight 样式（scripting.insertCSS，不改网页 DOM） |
import type { Anchor } from '@/core/anchor/anchor';
import { citationAnchor, citationInText, normalizeCitationNumber } from '@/core/anchor/citations';
import { toPageKey } from '@/core/context/page-key';
import { segmentsText } from '@/core/domain/conversation';
import type {
  BackgroundToClient,
  BackgroundToContent,
  CitationFailReason,
  ClientToBackground,
  ContentToBackground,
} from '@/core/domain/messages';
import { siteLevelForUrl } from '@/core/domain/site-policy';
import { citationNumberOf } from '@/core/prompt/ask';
import type { BackgroundDeps } from './deps';
import type { Jobs } from './jobs';
import type { PageSender } from './pages';

type LocateMsg = Extract<ClientToBackground, { type: 'citation/locate' }>;
type LocateResult = Extract<ContentToBackground, { type: 'page/locateResult' }>;
type Reply = (msg: BackgroundToClient) => void;
type Level = LocateResult['level'];
type ToReader = Omit<Extract<BackgroundToContent, { type: 'page/locate' }>, 'type' | 'requestId'>;

/** 阅读器应答的上限：重新抽取正常几十毫秒 */
export const LOCATE_TIMEOUT_MS = 5000;

/** 引用高亮的样式（名字与 page/locate.ts 的 HIGHLIGHT_NAME 一致）。浅黄底，深色网页上也看得清字 */
export const HIGHLIGHT_CSS =
  '::highlight(ra-citation){background-color:rgba(255,213,79,0.55);color:inherit;text-decoration:underline 2px rgba(214,150,0,0.9);}';

interface Pending {
  tabId: number;
  documentId: string;
  finish: (r: { level: Level; back: boolean }) => void;
}

export type Citations = ReturnType<typeof createCitations>;

export function createCitations(deps: BackgroundDeps, jobs: Pick<Jobs, 'settled'>) {
  const pending = new Map<string, Pending>();
  /** 已注入高亮样式的文档；后台重启后会再注入一次，同样的样式叠一份没有影响 */
  const styled = new Set<string>();
  /** 每个标签页最近一次定位用的文档：回到刚才的位置只发给它 */
  const lastDoc = new Map<number, string>();

  function askReader(tabId: number, documentId: string, msg: ToReader) {
    const requestId = deps.newId();
    return new Promise<{ level: Level; back: boolean }>((resolve) => {
      const timer = setTimeout(() => finish({ level: 'none', back: false }), LOCATE_TIMEOUT_MS);
      function finish(r: { level: Level; back: boolean }): void {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        clearTimeout(timer);
        resolve(r);
      }
      pending.set(requestId, { tabId, documentId, finish });
      deps
        .sendToFrame(tabId, 0, documentId, { type: 'page/locate', requestId, ...msg })
        .catch(() => finish({ level: 'none', back: false }));
    });
  }

  /**
   * 注入阅读器、给文档补上高亮样式、让阅读器定位并高亮（引用跳回与收藏回原文共用）。
   * 锚点缺省时只靠块号（页面没变才有用）；注入不了返回 ok: false
   */
  async function locateIn(
    tabId: number,
    req: { anchor: Anchor | undefined; blockId?: string; contentVersion?: string },
  ): Promise<{ ok: true; level: Level; back: boolean } | { ok: false }> {
    let documentId: string;
    try {
      documentId = await deps.injectReader(tabId);
    } catch {
      return { ok: false };
    }
    if (!styled.has(documentId)) {
      styled.add(documentId);
      await deps.insertCss?.(tabId, documentId, HIGHLIGHT_CSS).catch((e: unknown) => {
        styled.delete(documentId);
        deps.log('citation/styleFailed', { error: e instanceof Error ? e.name : 'unknown' });
      });
    }
    lastDoc.set(tabId, documentId);
    const r = await askReader(tabId, documentId, {
      // 快照过期又没有原文：只能靠块号（页面没变时阅读器直接用它），锚点留空
      anchor: req.anchor
        ? { ...req.anchor, headingPath: [...req.anchor.headingPath] }
        : {
            exact: '',
            prefix: '',
            suffix: '',
            blockDigest: '',
            headingPath: [],
            scrollRatio: 0,
            offsetInBlock: 0,
          },
      highlight: true,
      ...(req.blockId === undefined ? {} : { blockId: req.blockId }),
      ...(req.contentVersion === undefined ? {} : { contentVersion: req.contentVersion }),
    });
    return { ok: true, ...r };
  }

  return {
    /**
     * citation/locate。tabId 由对话端口给出（小窗：令牌绑定的标签页；侧边栏：所订阅、且仍在本窗口的标签页），
     * 不取自消息（规则 7）
     */
    async locate(tabId: number, msg: LocateMsg, reply: Reply): Promise<void> {
      const done = (level: Level, extra: { reason?: CitationFailReason; back?: boolean } = {}) => {
        deps.log('citation/located', { level, ...extra });
        reply({ type: 'citation/located', requestId: msg.requestId, level, ...extra });
      };
      const fail = (reason: CitationFailReason) => done('none', { reason });

      await jobs.settled();
      const m = await deps.db.getMessage(msg.messageId);
      const plan = m?.role === 'assistant' ? m.plan : undefined;
      if (!m || !plan) return fail('notCited');
      const want = normalizeCitationNumber(msg.citation);
      const blockId = plan.sentBlockIds.find((id) => citationNumberOf(id) === want);
      if (blockId === undefined) return fail('notCited');

      const url = await deps.getTabUrl?.(tabId).catch(() => undefined);
      const pageKey = url === undefined ? undefined : toPageKey(url);
      if (plan.pageKey === undefined || pageKey !== plan.pageKey) return fail('otherPage');
      const loaded = await deps.loadSettings();
      if (loaded.ok && siteLevelForUrl(url, loaded.settings.sites) === 'noRead') return fail('siteBlocked');

      const snap =
        m.contextSnapshotId === undefined ? undefined : await deps.db.getSnapshot(m.contextSnapshotId);
      const live = snap && (snap.refCount > 0 || snap.expiresAt > deps.now()) ? snap : undefined;
      const block = live?.blocks.find((b) => b.id === blockId);
      // 块来自内嵌页面（iframe）：本版本只读取、不在子框架里定位，给出明确原因（D10）
      if (block?.frameId !== undefined && block.frameId !== 0) return fail('subframe');
      // 原文只在快照的块里找；快照过期时它是唯一的依据，必须在回答原文里出现过（界面报来的不直接采信）
      const quote = block
        ? msg.quote
        : msg.quote === undefined
          ? undefined
          : citationInText(segmentsText(m.segments), msg.citation, msg.quote).quote;
      const anchor = citationAnchor({
        ...(block ? { block } : {}),
        ...(quote ? { quote } : {}),
        scrollRatio: 0,
      });

      const contentVersion = live?.contentVersion ?? plan.contentVersion;
      const r = await locateIn(tabId, {
        anchor,
        blockId,
        ...(contentVersion === undefined ? {} : { contentVersion }),
      });
      if (!r.ok) return fail('unavailable');
      if (r.level === 'none') return fail(anchor ? 'notFound' : 'expired');
      done(r.level, r.back ? { back: true } : {});
    },

    /**
     * 让所给标签页顶层的阅读器定位并高亮一个锚点（引用跳回与收藏「回到原文」共用，决策 098）。
     * 调用方负责先核对站点策略、页面身份。注入不了（浏览器内部页面等）返回 ok: false；阅读器没应答、找不到按 level: none
     */
    locateAnchor: (tabId: number, anchor: Anchor) => locateIn(tabId, { anchor }),

    /** citation/back：回到上次跳转前的阅读位置。这个标签页没定位过就拒绝 */
    async back(tabId: number): Promise<boolean> {
      const documentId = lastDoc.get(tabId);
      if (documentId === undefined) return false;
      lastDoc.delete(tabId);
      await deps.sendToFrame(tabId, 0, documentId, { type: 'page/back' }).catch(() => undefined);
      return true;
    },

    /** page/locateResult：只认这次定位的标签页、顶层框架、同一文档（规则 7） */
    onLocateResult(msg: LocateResult, s: PageSender): boolean {
      const p = pending.get(msg.requestId);
      if (!p || p.tabId !== s.tabId || s.frameId !== 0 || s.documentId !== p.documentId) return false;
      p.finish({ level: msg.level, back: msg.back === true });
      return true;
    },

    forgetTab(tabId: number): void {
      lastDoc.delete(tabId);
      for (const p of [...pending.values()]) if (p.tabId === tabId) p.finish({ level: 'none', back: false });
    },
  };
}
