// 后台运行时状态（5.5）：真相在 storage.session（键见 SESSION_KEYS），内存只做缓存。
// 后台空闲约 30 秒会被回收、内存清空（网络诊断包真机结论），所以读取都是先看内存，没有再读 storage.session。
import {
  type FloatBinding,
  type FloatReadiness,
  type FloatToken,
  type Handoff,
  TOKEN_TTL_MS,
} from '@/core/domain/float';
import type { JobRecord } from '@/core/domain/job';
import type { PanelNoticeKind } from '@/core/domain/messages';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import type { SessionArea } from './deps';

/** action/click 存下的选区：选中文字只在这里，conv/ask 按 selectionRevision 引用 */
export interface StoredSelection {
  frameId: number;
  documentId?: string;
  selectionRevision: number;
  text: string;
  truncated: boolean;
  originalLength: number;
  inCode: boolean;
  at: number;
}

const JOB_PREFIX = SESSION_KEYS.job('');
/** 侧边栏顶部说明等多久没被侧边栏取走就作废（用户没打开侧边栏，过后再开不该看到旧原因） */
export const NOTICE_TTL_MS = 30_000;
const FLOAT_PREFIX = SESSION_KEYS.float(0).replace(/0$/, '');
const HANDOFF_PREFIX = SESSION_KEYS.handoff('');

export type Store = ReturnType<typeof createStore>;

export function createStore(session: SessionArea, now: () => number, newToken: () => string) {
  const tokens = new Map<string, FloatToken>();
  /** 正在从 storage.session 回退读取的令牌：同一令牌第二次 hello 直接拒绝 */
  const pendingTokens = new Set<string>();
  const selections = new Map<number, StoredSelection>();
  const bindings = new Map<number, FloatBinding>();
  /**
   * 小窗就绪状态的内存副本：「问」被点击时要在同一个同步段里决定是否打开侧边栏（规则 10），
   * 来不及读 storage.session。后台刚被唤醒、副本还没从 storage.session 补回来时按 unknown 处理（走小窗）
   */
  const readiness = new Map<number, FloatReadiness>();
  /** 待侧边栏取走的顶部说明（5.4），只在内存：后台重启后丢了也只是少一行说明 */
  const notices = new Map<number, { kind: PanelNoticeKind; at: number }>();

  async function read<T>(key: string): Promise<T | undefined> {
    const got = await session.get(key);
    return got[key] as T | undefined;
  }

  return {
    async issueToken(tabId: number, documentId: string): Promise<FloatToken> {
      const t: FloatToken = { token: newToken(), tabId, documentId, expiresAt: now() + TOKEN_TTL_MS };
      for (const [k, v] of tokens) {
        if (v.expiresAt > now()) continue;
        tokens.delete(k);
        void session.remove(SESSION_KEYS.token(k));
      }
      tokens.set(t.token, t);
      await session.set({ [SESSION_KEYS.token(t.token)]: t });
      return t;
    },

    /**
     * 原子消费（5.3）：在调用的同步段里从内存读出即删，两次 hello 不会都成功。
     * 内存为空（后台重启过）才回退 storage.session；回退期间同一令牌再来直接拒绝。
     * 只核对存在与否，tabId、有效期由调用方核对。
     */
    takeToken(token: string): Promise<FloatToken | undefined> {
      const key = SESSION_KEYS.token(token);
      const hit = tokens.get(token);
      if (hit) {
        tokens.delete(token);
        return session.remove(key).then(() => hit);
      }
      if (tokens.size > 0 || pendingTokens.has(token)) return Promise.resolve(undefined);
      pendingTokens.add(token);
      return (async () => {
        try {
          const t = await read<FloatToken>(key);
          if (t) await session.remove(key);
          return t;
        } finally {
          pendingTokens.delete(token);
        }
      })();
    },

    async getBinding(tabId: number): Promise<FloatBinding | undefined> {
      const mem = bindings.get(tabId);
      if (mem) return mem;
      const b = await read<FloatBinding>(SESSION_KEYS.floatBinding(tabId));
      if (b) bindings.set(tabId, b);
      return b;
    },
    async putBinding(b: FloatBinding): Promise<void> {
      bindings.set(b.tabId, b);
      await session.set({ [SESSION_KEYS.floatBinding(b.tabId)]: b });
    },
    async deleteBinding(tabId: number): Promise<void> {
      bindings.delete(tabId);
      await session.remove(SESSION_KEYS.floatBinding(tabId));
    },

    /** 内存同步写入（随后的订阅马上读得到），返回 storage.session 的写入 */
    putSelection(tabId: number, sel: StoredSelection): Promise<void> {
      selections.set(tabId, sel);
      return session.set({ [SESSION_KEYS.selection(tabId)]: sel });
    },
    async getSelection(tabId: number): Promise<StoredSelection | undefined> {
      const mem = selections.get(tabId);
      if (mem) return mem;
      const s = await read<StoredSelection>(SESSION_KEYS.selection(tabId));
      if (s) selections.set(tabId, s);
      return s;
    },

    setReadiness(tabId: number, r: FloatReadiness): Promise<void> {
      readiness.set(tabId, r);
      return session.set({ [SESSION_KEYS.float(tabId)]: r });
    },
    /** 同步读内存副本（见 readiness 注释） */
    readinessNow: (tabId: number): FloatReadiness => readiness.get(tabId) ?? 'unknown',
    /** 后台启动时从 storage.session 补回就绪状态的内存副本（尽力而为，不阻塞监听器） */
    async warmReadiness(): Promise<void> {
      const all = await session.get(null);
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith(FLOAT_PREFIX)) continue;
        const tabId = Number(k.slice(FLOAT_PREFIX.length));
        if (Number.isInteger(tabId) && !readiness.has(tabId)) readiness.set(tabId, v as FloatReadiness);
      }
    },

    putNotice(tabId: number, kind: PanelNoticeKind): void {
      notices.set(tabId, { kind, at: now() });
    },
    /** 侧边栏订阅这个标签页时取走（取一次就没了）；过期的不给 */
    takeNotice(tabId: number): PanelNoticeKind | undefined {
      const n = notices.get(tabId);
      notices.delete(tabId);
      return n && now() - n.at < NOTICE_TTL_MS ? n.kind : undefined;
    },

    /** 「开关侧边栏」命令的时间（5.4）：面板加载时读，晚于自己创建时间就自行关闭 */
    setPanelToggle(windowId: number, at: number): Promise<void> {
      return session.set({ [SESSION_KEYS.sidepanelToggle(windowId)]: at });
    },

    putHandoff(h: Handoff): Promise<void> {
      return session.set({ [SESSION_KEYS.handoff(h.handoffId)]: h });
    },
    getHandoff(id: string): Promise<Handoff | undefined> {
      return read<Handoff>(SESSION_KEYS.handoff(id));
    },
    deleteHandoff(id: string): Promise<void> {
      return session.remove(SESSION_KEYS.handoff(id));
    },
    /** 某窗口未过期的转接，最新的在前；过期的顺手删掉 */
    async handoffsFor(windowId: number): Promise<Handoff[]> {
      const all = await session.get(null);
      const out: Handoff[] = [];
      const stale: string[] = [];
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith(HANDOFF_PREFIX)) continue;
        const h = v as Handoff;
        if (h.expiresAt <= now()) stale.push(k);
        else if (h.windowId === windowId) out.push(h);
      }
      if (stale.length > 0) await session.remove(stale);
      return out.sort((a, b) => b.expiresAt - a.expiresAt);
    },

    putJob(r: JobRecord): Promise<void> {
      return session.set({ [SESSION_KEYS.job(r.jobId)]: r });
    },
    getJob(jobId: string): Promise<JobRecord | undefined> {
      return read<JobRecord>(SESSION_KEYS.job(jobId));
    },
    async allJobs(): Promise<JobRecord[]> {
      const all = await session.get(null);
      return Object.entries(all)
        .filter(([k]) => k.startsWith(JOB_PREFIX))
        .map(([, v]) => v as JobRecord);
    },

    setEpoch(epoch: string): Promise<void> {
      return session.set({ [SESSION_KEYS.workerEpoch]: epoch });
    },

    /** 标签页关闭：选区、绑定、就绪状态、该页的令牌一并删除 */
    async forgetTab(tabId: number): Promise<void> {
      selections.delete(tabId);
      bindings.delete(tabId);
      readiness.delete(tabId);
      notices.delete(tabId);
      const keys = [
        SESSION_KEYS.selection(tabId),
        SESSION_KEYS.floatBinding(tabId),
        SESSION_KEYS.float(tabId),
      ];
      for (const [k, v] of tokens) {
        if (v.tabId !== tabId) continue;
        tokens.delete(k);
        keys.push(SESSION_KEYS.token(k));
      }
      await session.remove(keys);
    },
  };
}
