// 后台运行时状态（5.5）：真相在 storage.session（键见 SESSION_KEYS），内存只做缓存。
// 后台空闲约 30 秒会被回收、内存清空（网络诊断包真机结论），所以读取都是先看内存，没有再读 storage.session。
import { type FloatBinding, type FloatReadiness, type FloatToken, TOKEN_TTL_MS } from '@/core/domain/float';
import type { JobRecord } from '@/core/domain/job';
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

export type Store = ReturnType<typeof createStore>;

export function createStore(session: SessionArea, now: () => number, newToken: () => string) {
  const tokens = new Map<string, FloatToken>();
  /** 正在从 storage.session 回退读取的令牌：同一令牌第二次 hello 直接拒绝 */
  const pendingTokens = new Set<string>();
  const selections = new Map<number, StoredSelection>();
  const bindings = new Map<number, FloatBinding>();

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
      return session.set({ [SESSION_KEYS.float(tabId)]: r });
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
