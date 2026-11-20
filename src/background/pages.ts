// 页面读取与缓存（5.6、6.1、4.1）：发问时按档位与站点策略决定读不读；要读就让顶层框架的阅读器抽取（page/read），
// 收齐 page/docPart 后用 pageDocSchema 校验、按同一算法重算内容指纹核对，再按 sender 盖章（规则 7：
// documentId、块的 frameId 取自 sender，pageKey 与 url 取自标签页当前地址（浏览器给的，与 sender 同源），一律不信消息体）。
// 缓存按标签页存最近一份，按 contentVersion 失效：每次使用前都让阅读器重新抽取核对，指纹没变才回 page/docUnchanged。
// 「不读取」站点不抽取、不缓存，并清掉该标签页的旧缓存；策略变更时整体清空（4.1「旧缓存标记失效」）。
// 选区所在块：阅读器在同一次读取里先发 selection/anchored；版本对得上直接用块号，对不上用锚点重新定位，
// 定位不了就不猜（不把旧锚点套到无关的新文档上，V-06）。
import { type Anchor, matchAnchor } from '@/core/anchor/anchor';
import { contentVersionOf } from '@/core/context/content-version';
import type { Block, PageDoc } from '@/core/context/page-doc';
import { toPageKey } from '@/core/context/page-key';
import type { ContextTier } from '@/core/context/plan';
import { type ContentToBackground, pageDocSchema, type RejectReason } from '@/core/domain/messages';
import type { Settings } from '@/core/domain/settings';
import { type SiteLevel, siteLevelForUrl } from '@/core/domain/site-policy';
import type { AskPage } from '@/core/prompt/ask';
import type { BackgroundDeps } from './deps';
import type { StoredSelection } from './store';

type DocPart = Extract<ContentToBackground, { type: 'page/docPart' }>;
type DocUnchanged = Extract<ContentToBackground, { type: 'page/docUnchanged' }>;
type Anchored = Extract<ContentToBackground, { type: 'selection/anchored' }>;

export interface PageSender {
  tabId: number;
  frameId: number;
  documentId: string | undefined;
  url: string | undefined;
}

/** 读取超时：阅读器在时间片里抽取，正常几十毫秒；超时按读取失败处理，只发选区 */
export const READ_TIMEOUT_MS = 5000;
/** 缓存上限（5.15）：最多 3 页、5 MB（按回传的 JSON 字节粗算） */
const CACHE_MAX_PAGES = 3;
const CACHE_MAX_BYTES = 5 * 1024 * 1024;

interface Cached {
  doc: PageDoc;
  bytes: number;
  at: number;
}

interface PendingRead {
  tabId: number;
  documentId: string;
  known: Cached | undefined;
  parts: (string | undefined)[];
  finish: (r: ReadResult) => void;
}

type ReadResult =
  | { ok: true; doc: PageDoc; bytes: number; unchanged: boolean }
  | { ok: false; error: string };

interface AnchoredSel {
  revision: number;
  documentId: string | undefined;
  contentVersion: string | undefined;
  anchor: Anchor;
  blockIds: readonly string[];
}

/** 一次发问的页面上下文：装配（assembleAsk）的输入，以及后台复核策略用的依据 */
export interface PageContext {
  page?: AskPage;
  selectionBlockIds: readonly string[];
  /** 站点为「不读取」：不带页面内容，历史里的旧正文也去掉 */
  siteNoRead: boolean;
  /** 判定时用的顶层地址与级别；发请求前用最新设置复核，级别变了就取消（D-01） */
  topUrl: string | undefined;
  level: SiteLevel;
  notes: string[];
}

const NOTE = {
  subframe: '选区在子框架里，没有读取页面正文',
  inject: '这个页面不允许读取（浏览器内部页面或拒绝注入），只发送了选中文字',
  timeout: '页面读取超时，只发送了选中文字',
  failed: '页面读取失败，只发送了选中文字',
  staleSelection: '选区来自之前打开的页面，没有按选区取前后段落',
  lostSelection: '页面内容已变化，没能在新内容里找到选区',
  ambiguous: '选区文字在页面里出现多处、位置不确定，没有按选区取前后段落',
  notFound: '没能在页面正文里找到选区（可能在折叠、表单或子框架里），没有按选区取前后段落',
  navigated: '页面在读取期间发生了跳转，没有使用这次读到的内容，只发送了选中文字',
} as const;

const normalize = (s: string) => s.replace(/\s+/g, '');

/** 没有锚点时退回按文字找：选区第一行在哪些块里；多处出现就判为不确定（重复文本不取第一个） */
function locateByText(blocks: readonly Block[], text: string): { ids: string[]; ambiguous: boolean } {
  const head = normalize(text.trim().split('\n')[0] ?? '');
  if (head.length < 2) return { ids: [], ambiguous: false };
  const hits = blocks.filter((b) => normalize(b.text).includes(head));
  if (hits.length === 1) return { ids: [(hits[0] as Block).id], ambiguous: false };
  return { ids: [], ambiguous: hits.length > 1 };
}

export type Pages = ReturnType<typeof createPages>;

export function createPages(deps: BackgroundDeps) {
  const cache = new Map<number, Cached>();
  const reads = new Map<string, PendingRead>();
  const anchors = new Map<number, AnchoredSel>();

  function evict(): void {
    let bytes = [...cache.values()].reduce((n, c) => n + c.bytes, 0);
    while (cache.size > CACHE_MAX_PAGES || (bytes > CACHE_MAX_BYTES && cache.size > 0)) {
      let oldest: number | undefined;
      for (const [tab, c] of cache)
        if (oldest === undefined || c.at < (cache.get(oldest)?.at ?? 0)) oldest = tab;
      if (oldest === undefined) break;
      bytes -= cache.get(oldest)?.bytes ?? 0;
      cache.delete(oldest);
      deps.log('page/cacheEvicted', { tabId: oldest });
    }
  }

  /** 校验 sender 与这次读取的对象一致（规则 7）：标签页、顶层框架、文档都要对上 */
  function pendingFor(readId: string, s: PageSender): PendingRead | undefined {
    const p = reads.get(readId);
    if (!p || p.tabId !== s.tabId || s.frameId !== 0 || s.documentId !== p.documentId) return undefined;
    return p;
  }

  function stamp(doc: Omit<PageDoc, 'pageKey' | 'url' | 'documentId'>, s: PageSender): PageDoc | undefined {
    const pageKey = s.url === undefined ? undefined : toPageKey(s.url);
    if (pageKey === undefined || s.url === undefined || s.documentId === undefined) return undefined;
    return { ...doc, pageKey, url: s.url, documentId: s.documentId };
  }

  function read(tabId: number, documentId: string, known: Cached | undefined): Promise<ReadResult> {
    const readId = deps.newId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), READ_TIMEOUT_MS);
      function finish(r: ReadResult): void {
        if (!reads.has(readId)) return;
        reads.delete(readId);
        clearTimeout(timer);
        deps.log(
          'page/read',
          r.ok
            ? { result: r.unchanged ? 'unchanged' : 'parts', blocks: r.doc.blocks.length }
            : { result: r.error },
        );
        resolve(r);
      }
      reads.set(readId, { tabId, documentId, known, parts: [], finish });
      deps
        .sendToFrame(tabId, 0, documentId, {
          type: 'page/read',
          readId,
          ...(known ? { knownContentVersion: known.doc.contentVersion } : {}),
        })
        .catch(() => finish({ ok: false, error: 'sendFailed' }));
    });
  }

  /** 选区所在块：锚点（同一文档、同一次选区）优先，版本不同就用锚点重新定位；没有锚点按文字找 */
  function selectionBlocks(
    tabId: number,
    doc: PageDoc,
    sel: StoredSelection,
    notes: string[],
  ): readonly string[] {
    if (sel.frameId !== 0) return [];
    if (sel.documentId !== undefined && sel.documentId !== doc.documentId) {
      notes.push(NOTE.staleSelection);
      return [];
    }
    const a = anchors.get(tabId);
    // 锚点取自读取那一刻网页上的选区；网页脚本可能已改写了选中的那段（修订号没变），
    // 锚点文字不在点「问」时存下的选区文字里，就不信它（V-06：不把旧选区套到改过的内容上）
    const fits = a !== undefined && normalize(sel.text).includes(normalize(a.anchor.exact));
    if (a && fits && a.revision === sel.selectionRevision && a.documentId === doc.documentId) {
      if (a.contentVersion === doc.contentVersion) {
        const known = new Set(doc.blocks.map((b) => b.id));
        const ids = a.blockIds.filter((id) => known.has(id));
        if (ids.length > 0) return ids;
      }
      const m = matchAnchor(a.anchor, doc.blocks);
      if (m.level === 'exact' || (m.level === 'fuzzy' && m.score > 0)) return [m.blockId];
      notes.push(NOTE.lostSelection);
      return [];
    }
    const found = locateByText(doc.blocks, sel.text);
    if (found.ids.length === 0) notes.push(found.ambiguous ? NOTE.ambiguous : NOTE.notFound);
    return found.ids;
  }

  /** 注入阅读器、读取、核对地址、缓存、定位选区；结果写进 ctx */
  async function readInto(
    ctx: PageContext,
    tabId: number,
    selection: StoredSelection | undefined,
  ): Promise<void> {
    const { topUrl } = ctx;
    let documentId: string;
    try {
      documentId = await deps.injectReader(tabId);
    } catch {
      ctx.notes.push(NOTE.inject);
      return;
    }
    const cached = cache.get(tabId);
    const known = cached?.doc.documentId === documentId ? cached : undefined;
    const r = await read(tabId, documentId, known);
    if (!r.ok) {
      ctx.notes.push(r.error === 'timeout' ? NOTE.timeout : NOTE.failed);
      return;
    }
    // 地址以标签页为准（V-06 实测：hash 路由、pushState 之后 sender.url 仍是文档创建时的地址，
    // 而标签页地址跟着变）。读取前后标签页地址必须一致、且与 sender 同源，否则说明读取期间换了页，不用这份正文
    const afterUrl = deps.getTabUrl ? await deps.getTabUrl(tabId).catch(() => undefined) : r.doc.url;
    const docUrl = afterUrl ?? r.doc.url;
    const pageKey = toPageKey(docUrl);
    if (
      afterUrl !== topUrl ||
      pageKey === undefined ||
      new URL(docUrl).origin !== new URL(r.doc.url).origin
    ) {
      deps.log('page/read', { result: 'navigatedDuringRead' });
      ctx.notes.push(NOTE.navigated);
      return;
    }
    const doc: PageDoc = { ...r.doc, url: docUrl, pageKey };
    cache.set(tabId, { doc, bytes: r.bytes, at: deps.now() });
    evict();
    ctx.page = {
      pageKey: doc.pageKey,
      documentId: doc.documentId,
      contentVersion: doc.contentVersion,
      title: doc.title,
      blocks: doc.blocks,
      textLength: doc.textLength,
      notes: doc.notes,
    };
    if (selection) ctx.selectionBlockIds = selectionBlocks(tabId, doc, selection, ctx.notes);
  }

  return {
    /** 阅读器回传的正文分片；收齐后校验、核对指纹、盖章 */
    onDocPart(msg: DocPart, s: PageSender): RejectReason | undefined {
      const p = pendingFor(msg.readId, s);
      if (!p) return 'notOwner';
      if (p.parts.length === 0) p.parts = new Array<string | undefined>(msg.total).fill(undefined);
      if (p.parts.length !== msg.total || msg.index >= msg.total) {
        p.finish({ ok: false, error: 'badParts' });
        return 'invalid';
      }
      p.parts[msg.index] = msg.data;
      if (p.parts.some((x) => x === undefined)) return undefined;
      const json = p.parts.join('');
      let raw: unknown;
      try {
        raw = JSON.parse(json);
      } catch {
        p.finish({ ok: false, error: 'badJson' });
        return 'invalid';
      }
      const parsed = pageDocSchema.parse(raw);
      if (!parsed.ok) {
        p.finish({ ok: false, error: 'invalid' });
        return 'invalid';
      }
      const report = parsed.value;
      // 指纹按同一算法重算：阅读器自报的版本对不上就不采信
      if (contentVersionOf(report.title, report.blocks) !== report.contentVersion) {
        p.finish({ ok: false, error: 'versionMismatch' });
        return 'invalid';
      }
      const doc = stamp({ ...report, blocks: report.blocks.map((b) => ({ ...b, frameId: s.frameId })) }, s);
      if (!doc) {
        p.finish({ ok: false, error: 'noIdentity' });
        return 'invalid';
      }
      p.finish({ ok: true, doc, bytes: json.length, unchanged: false });
      return undefined;
    },

    /** 指纹没变：只在同一文档已有这个版本的缓存时采信；地址按 sender 重新盖章（pushState 换了查询参数） */
    onDocUnchanged(msg: DocUnchanged, s: PageSender): RejectReason | undefined {
      const p = pendingFor(msg.readId, s);
      if (!p) return 'notOwner';
      const k = p.known;
      if (!k || k.doc.documentId !== s.documentId || k.doc.contentVersion !== msg.contentVersion) {
        p.finish({ ok: false, error: 'unknownVersion' });
        return 'invalid';
      }
      const doc = stamp(k.doc, s);
      if (!doc) {
        p.finish({ ok: false, error: 'noIdentity' });
        return 'invalid';
      }
      p.finish({ ok: true, doc, bytes: k.bytes, unchanged: true });
      return undefined;
    },

    /** 选区锚点只收顶层框架阅读器发的（阅读器只在顶层） */
    onAnchored(msg: Anchored, s: PageSender): boolean {
      if (s.frameId !== 0) return false;
      anchors.set(s.tabId, {
        revision: msg.selectionRevision,
        documentId: s.documentId,
        contentVersion: msg.contentVersion,
        anchor: msg.anchor,
        blockIds: msg.blockIds,
      });
      return true;
    },

    /**
     * 发问前取页面上下文。tier 为 selection 时不读；站点「不读取」时不注入、不抽取、清掉该页旧缓存；
     * 选区在子框架里时不读（顶层正文不是选区所在的文档，且不知道框架来源的策略）
     */
    async prepare(
      tabId: number,
      tier: ContextTier,
      selection: StoredSelection | undefined,
      settings: Settings,
    ): Promise<PageContext> {
      const topUrl = await deps.getTabUrl?.(tabId).catch(() => undefined);
      const level = siteLevelForUrl(topUrl, settings.sites);
      const ctx: PageContext = { selectionBlockIds: [], siteNoRead: false, topUrl, level, notes: [] };
      if (level === 'noRead') {
        ctx.siteNoRead = true;
        if (cache.delete(tabId)) deps.log('page/cachePurged', { tabId, reason: 'noRead' });
        anchors.delete(tabId);
        return ctx;
      }
      if (tier === 'selection') return ctx;
      if (selection && selection.frameId !== 0) {
        ctx.notes.push(NOTE.subframe);
        return ctx;
      }
      // 读取出任何意外都只当作没读成：这次只发选区，不让任务卡在已接单
      try {
        await readInto(ctx, tabId, selection);
      } catch (e) {
        deps.log('page/read', { result: 'error', error: e instanceof Error ? e.name : 'unknown' });
        delete ctx.page;
        ctx.selectionBlockIds = [];
        ctx.notes.push(NOTE.failed);
      }
      return ctx;
    },

    /** 发请求前复核：用最新设置重算顶层级别，与读取时不同就说明策略变了（D-01：未发出的取消） */
    levelChanged(ctx: PageContext, settings: Settings): boolean {
      return siteLevelForUrl(ctx.topUrl, settings.sites) !== ctx.level;
    },

    /** 站点策略变更：旧缓存全部失效（4.1） */
    purge(reason: string): void {
      if (cache.size > 0) deps.log('page/cachePurged', { reason, pages: cache.size });
      cache.clear();
      anchors.clear();
    },

    forgetTab(tabId: number): void {
      cache.delete(tabId);
      anchors.delete(tabId);
      for (const p of [...reads.values()]) if (p.tabId === tabId) p.finish({ ok: false, error: 'tabClosed' });
    },

    /** 单测与诊断：某标签页缓存的版本 */
    cachedVersion: (tabId: number): string | undefined => cache.get(tabId)?.doc.contentVersion,
  };
}
