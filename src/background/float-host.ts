// 小窗宿主调度（5.2、5.3）：确保顶层框架注入了阅读器（每个文档一次），按需发预热与显示指令。
// 指令只发给 frameId 0 的那个文档（documentId 来自注入结果），宿主导航后旧文档收不到。
// 同一标签页的操作排队执行：预热与点击同时到达时不会发出两个令牌。
import type { BackgroundToContent } from '@/core/domain/messages';
import type { BackgroundDeps } from './deps';
import type { Store } from './store';

interface TabState {
  chain: Promise<unknown>;
  /** 阅读器注入，结果是顶层文档的 documentId */
  reader: Promise<string> | undefined;
  docId: string | undefined;
  /** 本进程给哪个文档建过小窗（预热或现建），令牌何时过期 */
  floatFor: { docId: string; expiresAt: number } | undefined;
}

export type FloatHost = ReturnType<typeof createFloatHost>;

export function createFloatHost(deps: BackgroundDeps, store: Store) {
  const tabs = new Map<number, TabState>();

  function stateOf(tabId: number): TabState {
    let st = tabs.get(tabId);
    if (!st) {
      st = { chain: Promise.resolve(), reader: undefined, docId: undefined, floatFor: undefined };
      tabs.set(tabId, st);
    }
    return st;
  }

  function reset(st: TabState): void {
    st.reader = undefined;
    st.docId = undefined;
    st.floatFor = undefined;
  }

  function queue<T>(tabId: number, op: () => Promise<T>): Promise<T> {
    const st = stateOf(tabId);
    const run = st.chain.then(op, op);
    st.chain = run.catch(() => undefined);
    return run;
  }

  /** 用户点得很快时，点击与预热共用同一次注入 */
  function ensureReader(tabId: number): Promise<string> {
    const st = stateOf(tabId);
    if (st.reader) return st.reader;
    const p = deps.injectReader(tabId).then((docId) => {
      if (st.reader === p) st.docId = docId;
      return docId;
    });
    st.reader = p;
    p.catch(() => {
      if (st.reader === p) st.reader = undefined;
    });
    return p;
  }

  /** 这个文档已有小窗：握手过（有绑定），或本进程建过且令牌未过期 */
  async function hasFloat(st: TabState, tabId: number, docId: string): Promise<boolean> {
    const b = await store.getBinding(tabId);
    if (b?.hostDocumentId === docId) return true;
    return st.floatFor?.docId === docId && st.floatFor.expiresAt > deps.now();
  }

  async function newToken(st: TabState, tabId: number, docId: string): Promise<string> {
    const t = await store.issueToken(tabId, docId);
    st.floatFor = { docId, expiresAt: t.expiresAt };
    return t.token;
  }

  const send = (tabId: number, docId: string, msg: BackgroundToContent) =>
    deps.sendToFrame(tabId, 0, docId, msg);

  async function sendShow(st: TabState, tabId: number, docId: string): Promise<void> {
    if (await hasFloat(st, tabId, docId)) return send(tabId, docId, { type: 'float/show', focusInput: true });
    const token = await newToken(st, tabId, docId);
    return send(tabId, docId, { type: 'float/show', token, focusInput: true });
  }

  return {
    ensureReader,
    /** 已知的顶层文档（本进程注入过才知道） */
    currentDoc: (tabId: number): string | undefined => tabs.get(tabId)?.docId,

    /** 顶层框架报来的文档与记下的不同：宿主导航了，旧的注入记录、小窗与绑定都作废 */
    async noteTopDocument(tabId: number, documentId: string): Promise<void> {
      const st = tabs.get(tabId);
      if (st?.docId !== undefined && st.docId !== documentId) reset(st);
      const b = await store.getBinding(tabId);
      if (b && b.hostDocumentId !== documentId) await store.deleteBinding(tabId);
    },

    /** 预热：每个标签页文档只建一次隐藏小窗 */
    prewarm(tabId: number): Promise<void> {
      return queue(tabId, async () => {
        const st = stateOf(tabId);
        const docId = await ensureReader(tabId);
        if (await hasFloat(st, tabId, docId)) return;
        const token = await newToken(st, tabId, docId);
        try {
          await send(tabId, docId, { type: 'float/prewarm', token });
        } catch (e) {
          reset(st);
          throw e;
        }
      });
    },

    /** 显示小窗；这个文档还没有可用的小窗就带新令牌现建 */
    show(tabId: number): Promise<void> {
      return queue(tabId, async () => {
        const st = stateOf(tabId);
        const docId = await ensureReader(tabId);
        try {
          await sendShow(st, tabId, docId);
        } catch (e) {
          // 发送失败多半是宿主导航了：重新确认阅读器，文档变了就再试一次
          reset(st);
          const again = await ensureReader(tabId);
          if (again === docId) throw e;
          await sendShow(st, tabId, again);
        }
      });
    },

    /** 阅读器报告小窗加载失败：下次显示带新令牌重建 */
    markFloatFailed(tabId: number): void {
      const st = tabs.get(tabId);
      if (st) st.floatFor = undefined;
    },

    forget(tabId: number): void {
      tabs.delete(tabId);
    },
  };
}
