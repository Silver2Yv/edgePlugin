// 历史（5.11、C5）：侧边栏的历史查询与删除，「总结本页」的上次总结，站点改为「不读取页面内容」后清掉该站的旧正文。
// 读写都经后台（后台是对话数据的唯一写入者）；读库前先等排队中的写完成（jobs.settled）。
// 搜索先不建全文索引（5.11「达到实测阈值后再考虑」）：按页面与时间缩小范围，逐个对话比对标题与消息正文，单次查询最多看
// SEARCH_SCAN_MAX 个对话，没看完就给 nextBefore 让界面接着翻。
import { segmentsText } from '@/core/domain/conversation';
import { JOB_LIMITS } from '@/core/domain/job';
import { type BackgroundToClient, type ClientToBackground, messageBytes } from '@/core/domain/messages';
import type { ConversationRecord, MessageRecord, PageRecord } from '@/core/domain/records';
import type { Settings } from '@/core/domain/settings';
import { siteLevelForUrl } from '@/core/domain/site-policy';
import { stripPageContent } from '@/core/prompt/ask';
import type { BackgroundDeps } from './deps';
import type { Jobs } from './jobs';

type QueryMsg = Extract<ClientToBackground, { type: 'history/query' }>;
type DeleteMsg = Extract<ClientToBackground, { type: 'history/delete' }>;
type PageMsg = Extract<BackgroundToClient, { type: 'history/page' }>;
type Reply = (msg: BackgroundToClient) => void;

/** 文字搜索时每次从库里取多少个对话 */
const SEARCH_BATCH = 50;
/** 文字搜索单次查询最多比对多少个对话 */
export const SEARCH_SCAN_MAX = 500;

export interface HistoryResult {
  items: ConversationRecord[];
  /** 还有更早的：下一页的 before；可能翻到空页（恰好在最后一个对话处凑满一页） */
  nextBefore?: number;
}

/** 查询结果按 64 KB 分条（done 为真是最后一条，nextBefore 只在最后一条） */
export function historyPages(
  queryId: string,
  r: HistoryResult,
  maxBytes = JOB_LIMITS.maxMessageBytes,
): PageMsg[] {
  const last: PageMsg = {
    type: 'history/page',
    queryId,
    items: [],
    done: true,
    ...(r.nextBefore !== undefined ? { nextBefore: r.nextBefore } : {}),
  };
  const base = messageBytes(last);
  const out: PageMsg[] = [];
  let cur: ConversationRecord[] = [];
  let size = base;
  for (const c of r.items) {
    const n = messageBytes(c) + (cur.length > 0 ? 1 : 0);
    if (cur.length > 0 && size + n > maxBytes) {
      out.push({ type: 'history/page', queryId, items: cur, done: false });
      cur = [];
      size = base;
    }
    size += messageBytes(c) + (cur.length > 0 ? 1 : 0);
    cur.push(c);
  }
  out.push({ ...last, items: cur });
  return out;
}

const lower = (s: string) => s.toLocaleLowerCase();

function messageMatches(m: MessageRecord, needle: string): boolean {
  return lower(segmentsText(m.segments)).includes(needle) || lower(m.selection?.text ?? '').includes(needle);
}

export type History = ReturnType<typeof createHistory>;

export function createHistory(deps: BackgroundDeps, jobs: Jobs) {
  const db = deps.db;

  async function search(q: Omit<QueryMsg, 'type' | 'queryId'>): Promise<HistoryResult> {
    await jobs.settled();
    const scope = q.pageKey === undefined ? {} : { pageKey: q.pageKey };
    const needle = lower(q.text?.trim() ?? '');
    if (needle === '') {
      const rows = await db.listConversations({
        ...scope,
        ...(q.before !== undefined ? { before: q.before } : {}),
        limit: q.limit + 1,
      });
      const items = rows.slice(0, q.limit);
      const tail = items.at(-1);
      return rows.length > q.limit && tail ? { items, nextBefore: tail.updatedAt } : { items };
    }
    const items: ConversationRecord[] = [];
    let cursor = q.before;
    let scanned = 0;
    for (;;) {
      const rows = await db.listConversations({
        ...scope,
        ...(cursor !== undefined ? { before: cursor } : {}),
        limit: SEARCH_BATCH,
      });
      for (const c of rows) {
        scanned++;
        cursor = c.updatedAt;
        const hit =
          lower(c.title).includes(needle) ||
          (await db.getMessages(c.id)).some((m) => messageMatches(m, needle));
        if (hit) items.push(c);
        if (items.length >= q.limit || scanned >= SEARCH_SCAN_MAX) return { items, nextBefore: cursor };
      }
      if (rows.length < SEARCH_BATCH) return { items };
    }
  }

  return {
    search,

    /** history/query：回 history/page（可能分几条）；读库失败拒绝（storageFailed） */
    async query(
      msg: QueryMsg,
      post: Reply,
      reject: (reason: 'storageFailed', raw: unknown) => void,
    ): Promise<void> {
      let r: HistoryResult;
      try {
        r = await search(msg);
      } catch (e) {
        deps.log('history/queryFailed', { error: e instanceof Error ? e.name : 'unknown' });
        return reject('storageFailed', msg);
      }
      for (const p of historyPages(msg.queryId, r)) post(p);
    },

    /** history/delete：事务提交后才回 history/deleted */
    async remove(
      msg: DeleteMsg,
      post: Reply,
      reject: (reason: 'busy' | 'storageFailed', raw: unknown) => void,
    ): Promise<void> {
      const reason = await jobs.deleteConversation(msg.conversationId);
      if (reason === 'busy' || reason === 'storageFailed') return reject(reason, msg);
      deps.log('history/deleted', {});
      post({ type: 'history/deleted', requestId: msg.requestId, conversationId: msg.conversationId });
    },

    /**
     * 这一页上次的总结（6.2、验收第 8 条）：PageRecord.lastSummary 指向的消息还在、且已完成才给。
     * contentVersion 是总结所基于的内容版本，与当前版本不同时界面标注「基于旧版本」
     */
    async lastSummary(
      pageKey: string,
    ): Promise<{ page: PageRecord; message: MessageRecord; contentVersion: string } | undefined> {
      await jobs.settled();
      const page = await db.getPage(pageKey);
      if (!page?.lastSummary) return undefined;
      const message = await db.getMessage(page.lastSummary.messageId);
      if (message?.status !== 'completed') return undefined;
      return { page, message, contentVersion: page.lastSummary.contentVersion };
    },

    /**
     * 站点改为「不读取页面内容」（4.1「缓存正文：否，且清除该站旧缓存」）：删掉该站的快照（不论有没有被引用）；
     * 该站对话里用户消息的实际发送全文（sentText）去掉页面片段（stripPageContent）。显示用的问题、选区、回答不动
     * （4.1「该站已有的历史消息照常显示」）；装配时本来也会去掉，这里是不让旧正文继续留在库里
     */
    async purgeNoRead(settings: Settings): Promise<{ snapshots: number; messages: number }> {
      await jobs.settled();
      const noRead = (pageKey: string | undefined) =>
        pageKey !== undefined && siteLevelForUrl(pageKey, settings.sites) === 'noRead';
      const snapshots = await db.deleteSnapshotsWhere((s) => noRead(s.pageKey));
      let messages = 0;
      let before: number | undefined;
      for (;;) {
        const rows = await db.listConversations({
          ...(before !== undefined ? { before } : {}),
          limit: SCRUB_BATCH,
        });
        for (const c of rows) {
          before = c.updatedAt;
          if (!noRead(c.pageKey)) continue;
          const scrubbed = (await db.getMessages(c.id)).flatMap((m) => {
            if (m.sentText === undefined) return [];
            const sentText = stripPageContent(m.sentText);
            return sentText === m.sentText ? [] : [{ ...m, sentText }];
          });
          if (scrubbed.length === 0) continue;
          await db.write({ messages: scrubbed });
          messages += scrubbed.length;
        }
        if (rows.length < SCRUB_BATCH) break;
      }
      return { snapshots, messages };
    },
  };
}

/** 清旧正文时每次从库里取多少个对话 */
const SCRUB_BATCH = 200;
