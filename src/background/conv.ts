// 对话流端口（CONV_PORT，5.12）：角色只取自 sender（规则 7），每条消息都过 parseFrom；
// 握手前只收 helloFloat / resumeFloat / helloSidepanel。拒绝时只回 conv/rejected，不写入、不发请求。
// 同一端口的消息按到达顺序串行处理（握手写完绑定后才处理订阅）。
//
// 对话属于页面（pageKey，contract-v1.4）：小窗只能订阅、续接所在标签页当前页面的对话；侧边栏可以查看任意历史对话
// （conv/subscribe 指定对话），但续接发问时页面上下文来自所订阅的标签页，对话不属于它当前的页面就拒绝。
// 侧边栏（5.4、5.12）：只能订阅、发问、停止、重试本窗口标签页的对话。窗口在握手时定下（见 helloSidepanel），
// 订阅与每次发问、停止、重试都按 tabs.get 核对目标标签页仍在这个窗口里。选区引用取所订阅标签页存下的那份。
// 转到侧边栏（6.4、AR-19）：小窗 handoff/start → 后台记下 windowId + tabId + conversationId（storage.session，
// 短期有效）→ 侧边栏带 handoffId 订阅、初始推送发完 → 后台才通知小窗 handoff/done，小窗收到再收起。

import { toPageKey } from '@/core/context/page-key';
import { bindingMatches, HANDOFF_TTL_MS, type Handoff, handoffMatches } from '@/core/domain/float';
import { ID_PATTERN } from '@/core/domain/ids';
import {
  type BackgroundToClient,
  type ClientToBackground,
  CONV_PORT,
  clientToBackground,
  PROTOCOL_VERSION,
  parseFrom,
  type RejectReason,
  type SenderRole,
} from '@/core/domain/messages';
import type { ConversationRecord } from '@/core/domain/records';
import type { Capture } from './capture';
import type { Citations } from './citations';
import type { BackgroundDeps, ConvPort } from './deps';
import type { Favorites } from './favorites';
import type { FloatHost } from './float-host';
import type { History } from './history';
import type { Hub } from './hub';
import type { Jobs } from './jobs';
import { quoteOf } from './quote';
import { senderRole, senderSummary } from './roles';
import type { Store } from './store';
import type { Summary } from './summary';

const HELLO: ReadonlySet<string> = new Set(['conv/helloFloat', 'conv/resumeFloat', 'conv/helloSidepanel']);

type SubscribeMsg = Extract<ClientToBackground, { type: 'conv/subscribe' }>;

interface PortState {
  role: SenderRole;
  handshaken: boolean;
  /** 小窗：令牌绑定的标签页（握手成功后才有）；侧边栏：当前订阅的标签页 */
  tabId: number | undefined;
  /** 侧边栏所在窗口（握手时定下，之后不变） */
  windowId: number | undefined;
}

/** 被拒消息里的类型与关联编号；只取形状合法的字段，不回显内容 */
function refOf(raw: unknown): { refType?: string; refId?: string } {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: { refType?: string; refId?: string } = {};
  if (typeof r.type === 'string' && r.type.length <= 64) out.refType = r.type;
  for (const k of ['clientRequestId', 'jobId', 'queryId', 'requestId']) {
    const v = r[k];
    if (typeof v === 'string' && ID_PATTERN.test(v)) {
      out.refId = v;
      break;
    }
  }
  return out;
}

const pendingMsg = (h: Handoff): BackgroundToClient => ({
  type: 'handoff/pending',
  handoffId: h.handoffId,
  tabId: h.tabId,
  ...(h.conversationId === undefined ? {} : { conversationId: h.conversationId }),
});

export function createConv(
  deps: BackgroundDeps,
  store: Store,
  hub: Hub,
  host: FloatHost,
  jobs: Jobs,
  history: History,
  favorites: Favorites,
  /** cite 块：引用跳回、上次总结；capture 块：框选截图（都可选只是为了不打扰只测别的模块的单测） */
  extra: { citations?: Citations; summary?: Summary; capture?: Capture } = {},
) {
  const { capture } = extra;
  return function onConnect(port: ConvPort): void {
    if (port.name !== CONV_PORT) return;
    const sender = port.sender ?? {};
    const st: PortState = {
      role: senderRole(sender, deps.self),
      handshaken: false,
      tabId: undefined,
      windowId: undefined,
    };
    const post = (msg: BackgroundToClient) => hub.post(port, msg);
    const reject = (reason: RejectReason, raw: unknown) => {
      deps.log('conv/rejected', { role: st.role, reason, ...refOf(raw) });
      post({ type: 'conv/rejected', reason, ...refOf(raw) });
    };

    if (st.role !== 'float' && st.role !== 'sidepanel') {
      reject('notAllowed', undefined);
      port.disconnect();
      return;
    }

    async function helloFloat(token: string): Promise<void> {
      // 同一个同步段里读出即删（原子消费）；之后才有 await
      const taken = store.takeToken(token);
      deps.log('float/sender', { via: 'helloFloat', ...senderSummary(sender, deps.self) });
      const t = await taken;
      const tabId = sender.tab?.id;
      const { frameId, documentId } = sender;
      const hostDoc = tabId === undefined ? undefined : host.currentDoc(tabId);
      if (
        !t ||
        tabId === undefined ||
        frameId === undefined ||
        documentId === undefined ||
        t.tabId !== tabId ||
        t.expiresAt <= deps.now() ||
        (hostDoc !== undefined && hostDoc !== t.documentId)
      ) {
        // 握手失败的小窗用不了：下次显示带新令牌，阅读器据此重建（不再显示这个失效的）
        if (tabId !== undefined) host.markFloatFailed(tabId);
        return reject('badToken', { type: 'conv/helloFloat' });
      }
      await store.putBinding({
        tabId,
        frameId,
        floatDocumentId: documentId,
        hostDocumentId: t.documentId,
        boundAt: deps.now(),
      });
      st.handshaken = true;
      st.tabId = tabId;
      post({ type: 'conv/ready', role: 'float', protocolVersion: PROTOCOL_VERSION });
    }

    async function resumeFloat(): Promise<void> {
      deps.log('float/sender', { via: 'resumeFloat', ...senderSummary(sender, deps.self) });
      const tabId = sender.tab?.id;
      const b = tabId === undefined ? undefined : await store.getBinding(tabId);
      const who = {
        ...(tabId === undefined ? {} : { tabId }),
        ...(sender.frameId === undefined ? {} : { frameId: sender.frameId }),
        ...(sender.documentId === undefined ? {} : { documentId: sender.documentId }),
      };
      if (tabId === undefined || !bindingMatches(b, who))
        return reject('badToken', { type: 'conv/resumeFloat' });
      st.handshaken = true;
      st.tabId = tabId;
      post({ type: 'conv/ready', role: 'float', protocolVersion: PROTOCOL_VERSION });
    }

    /**
     * 侧边栏握手。窗口能反查就以反查为准（runtime.getContexts 按 sender.documentId，5.12），对不上拒绝；
     * 反查不了（Chrome 159 / Edge 157 实测 sender 不带 documentId、getContexts 的 windowId 为 -1）就用面板
     * 自己 windows.getCurrent() 报的窗口，只核对它存在（决策 072）。同一端口不能改报别的窗口
     */
    async function helloSidepanel(hint: number | undefined): Promise<void> {
      const raw = { type: 'conv/helloSidepanel' };
      if (hint === undefined) return reject('invalid', raw);
      const real =
        sender.documentId === undefined
          ? undefined
          : await deps.panelWindowOf(sender.documentId).catch(() => undefined);
      if (real !== undefined && real !== hint) return reject('notOwner', raw);
      if (st.windowId !== undefined && st.windowId !== hint) return reject('notOwner', raw);
      if (!(await deps.windowExists(hint))) return reject('notOwner', raw);
      deps.log('sidepanel/hello', { windowFrom: real === undefined ? 'hint' : 'contexts' });
      st.windowId = hint;
      st.handshaken = true;
      hub.addPanel(hint, port);
      post({ type: 'conv/ready', role: 'sidepanel', protocolVersion: PROTOCOL_VERSION });
      // 侧边栏是被「转到侧边栏」打开的：告诉它有待接的转接（6.4）
      const [pending] = await store.handoffsFor(hint);
      if (pending) post(pendingMsg(pending));
    }

    /** 侧边栏操作的标签页必须仍在本窗口（标签页可能被拖到了别的窗口） */
    async function inPanelWindow(tabId: number): Promise<boolean> {
      return st.windowId !== undefined && (await deps.tabWindow(tabId)) === st.windowId;
    }

    /**
     * 订阅的初始推送：conv/subscribed → 顶部说明 → 引用 → 接上的任务（发送计划、seq 之后的增量、状态）→ 快照。
     * 先做完选对话等 await，再在一个同步段里换订阅、发标记、补发、登记订阅者：补发与之后的实时推送不交错、不漏。
     * 快照（对话与消息，从库里读）最后发：它是「这次订阅的初始推送已经发完」的标志。
     * 要显示的对话见 jobs.viewFor：小窗只能看所在标签页当前页面的对话，侧边栏指定了对话可以看任意历史对话（5.12）
     */
    async function pushSubscription(tabId: number, msg: SubscribeMsg): Promise<void> {
      await jobs.ready;
      const sel = await store.getSelection(tabId);
      const url = await deps.getTabUrl?.(tabId).catch(() => undefined);
      const pageKey = url === undefined ? undefined : toPageKey(url);
      const view = await jobs
        .viewFor(tabId, msg.conversationId, pageKey, st.role === 'sidepanel' ? 'any' : 'page')
        .catch((e: unknown): { conversation?: ConversationRecord } => {
          // 读库失败：照常订阅这个标签页，显示空对话
          deps.log('db/viewFailed', { error: e instanceof Error ? e.name : 'unknown' });
          return {};
        });
      if (view === 'notOwner') return reject('notOwner', msg);
      const conversationId = view.conversation?.id;
      const notice = st.role === 'sidepanel' ? store.takeNotice(tabId) : undefined;
      // 这个标签页待确认的截图（5.13 预览），随引用一起补发
      const shot = await capture?.preview(tabId).catch(() => undefined);
      // —— 同步段开始
      hub.unsubscribe(port);
      st.tabId = tabId;
      const live = conversationId === undefined ? undefined : jobs.liveJob(conversationId, tabId);
      const resumed = msg.resume ? jobs.jobOf(tabId, msg.resume.jobId) : undefined;
      const job = resumed ?? live;
      post({
        type: 'conv/subscribed',
        tabId,
        ...(conversationId !== undefined ? { conversationId } : {}),
        ...(job ? { job } : {}),
      });
      if (notice) post({ type: 'conv/notice', kind: notice });
      if (sel) post(quoteOf(sel));
      if (shot) post(shot);
      if (job) jobs.replayNow(tabId, job.jobId, resumed && msg.resume ? msg.resume.lastSeq : 0, post);
      hub.subscribe(tabId, port);
      // —— 同步段结束。续播的任务不在内存（后台重启过）：只能报热副本里的状态
      if (msg.resume && !resumed) await jobs.replay(tabId, msg.resume, post);
      const batches = await jobs.snapshot(conversationId).catch((e: unknown) => {
        deps.log('db/snapshotFailed', { error: e instanceof Error ? e.name : 'unknown' });
        return undefined;
      });
      for (const b of batches ?? [
        { type: 'conv/snapshot' as const, messages: [], done: true, conversationRevision: 0 },
      ])
        post(b);
    }

    async function subscribeSidepanel(msg: SubscribeMsg): Promise<void> {
      const tabId = msg.tabId;
      if (tabId === undefined) return reject('invalid', msg);
      if (!(await inPanelWindow(tabId))) return reject('notOwner', msg);
      const h = msg.handoffId === undefined ? undefined : await store.getHandoff(msg.handoffId);
      const handoff =
        st.windowId !== undefined &&
        handoffMatches(h, {
          windowId: st.windowId,
          tabId,
          conversationId: msg.conversationId,
          now: deps.now(),
        })
          ? h
          : undefined;
      if (msg.handoffId !== undefined && !handoff) deps.log('handoff/invalid', { found: h !== undefined });
      await pushSubscription(tabId, msg);
      if (!handoff) return;
      // 侧边栏已收到完整的初始推送：这时才让小窗收起（AR-19）
      await store.deleteHandoff(handoff.handoffId);
      hub.toTab(tabId, { type: 'handoff/done', handoffId: handoff.handoffId });
      deps.log('handoff/done', { withConversation: handoff.conversationId !== undefined });
    }

    async function startHandoff(
      tabId: number,
      msg: Extract<ClientToBackground, { type: 'handoff/start' }>,
    ): Promise<void> {
      const { conversationId } = msg;
      if (conversationId !== undefined) {
        // 小窗只能转它所在标签页当前页面的对话；对话在库里就能转（后台重启过也行），库里没有（已删除）才回 gone
        const url = await deps.getTabUrl?.(tabId).catch(() => undefined);
        const v = await jobs
          .viewFor(tabId, conversationId, url === undefined ? undefined : toPageKey(url), 'page')
          .catch(() => 'failed' as const);
        if (v === 'notOwner') return reject('notOwner', msg);
        if (v === 'failed') return reject('storageFailed', msg);
        if (!v.conversation) return reject('gone', msg);
      }
      const windowId = sender.tab?.windowId ?? (await deps.tabWindow(tabId));
      if (windowId === undefined) return reject('notOwner', msg);
      const h: Handoff = {
        handoffId: deps.newId(),
        windowId,
        tabId,
        ...(conversationId === undefined ? {} : { conversationId }),
        expiresAt: deps.now() + HANDOFF_TTL_MS,
      };
      await store.putHandoff(h);
      post({ type: 'handoff/created', handoffId: h.handoffId });
      // 侧边栏已经连着（先连上、转接后到）：直接推给它；开着但断了线在闲着的，叫它重连（重连后在 hello 里取到）
      for (const p of hub.panelsIn(windowId)) hub.post(p, pendingMsg(h));
      void deps.notifyPages({ type: 'sidepanel/wake', windowId });
      deps.log('handoff/created', { withConversation: conversationId !== undefined });
    }

    async function handle(raw: unknown): Promise<void> {
      const parsed = parseFrom(st.role, clientToBackground, raw);
      if (!parsed.ok) return reject(parsed.reason, raw);
      const msg: ClientToBackground = parsed.msg;
      if (!st.handshaken && !HELLO.has(msg.type)) return reject('notHandshaken', msg);
      switch (msg.type) {
        case 'conv/helloFloat':
          return helloFloat(msg.token);
        case 'conv/resumeFloat':
          return resumeFloat();
        case 'conv/helloSidepanel':
          return helloSidepanel(msg.windowId);
        default:
          break;
      }
      if (st.role === 'sidepanel' && msg.type === 'conv/subscribe') return subscribeSidepanel(msg);
      // 历史（仅侧边栏，授权表已限定）：不针对某个标签页
      if (msg.type === 'history/query') return history.query(msg, post, reject);
      if (msg.type === 'history/delete') return history.remove(msg, post, reject);
      // 收藏（小窗与侧边栏，contract-v1.5）：不针对某个标签页，按对话/消息或收藏编号直接操作
      if (msg.type === 'favorite/add') return favorites.addFromMessage(msg, post, reject);
      if (msg.type === 'favorite/update') return favorites.update(msg, post, reject);
      if (msg.type === 'favorite/remove') return favorites.remove(msg, post, reject);
      // 以下需要目标标签页：小窗是令牌绑定的那个，侧边栏是当前订阅的那个（须仍在本窗口）
      const tabId = st.tabId;
      if (tabId === undefined) return reject('notAllowed', msg);
      if (st.role === 'sidepanel' && !(await inPanelWindow(tabId))) return reject('notOwner', msg);
      switch (msg.type) {
        case 'conv/subscribe': {
          if (msg.tabId !== undefined && msg.tabId !== tabId) return reject('notOwner', msg);
          return pushSubscription(tabId, msg);
        }
        case 'conv/ask':
          // 发问的端口也收这次任务的推送。小窗带的对话不属于当前页面（单页应用换了地址、后台重启过）时按续接规则；
          // 侧边栏是用户明确选的对话，对不上就拒绝（5.12）
          hub.subscribe(tabId, port);
          return jobs.ask(tabId, msg, post, { otherPage: st.role === 'float' ? 'fallback' : 'reject' });
        case 'conv/stop': {
          const reason = jobs.stop(tabId, msg.jobId);
          if (reason) reject(reason, msg);
          return;
        }
        case 'conv/retry': {
          const reason = jobs.retry(tabId, msg.jobId);
          if (reason) reject(reason, msg);
          return;
        }
        case 'handoff/start':
          return startHandoff(tabId, msg);
        // 引用跳回（5.7）与上次总结（6.2）：都针对这个标签页，内容由后台从库里取（规则 7、9）。
        // 要等阅读器抽取页面（最多几秒），不占着这个端口的串行队列：期间的停止、发问照常处理
        case 'citation/locate':
          if (!extra.citations) return reject('notAllowed', msg);
          void extra.citations.locate(tabId, msg, post).catch((e: unknown) => {
            deps.log('citation/error', { error: e instanceof Error ? e.name : 'unknown' });
            post({
              type: 'citation/located',
              requestId: msg.requestId,
              level: 'none',
              reason: 'unavailable',
            });
          });
          return;
        case 'citation/back':
          if (!(await extra.citations?.back(tabId))) return reject('notAllowed', msg);
          return;
        case 'summary/get':
          if (!extra.summary) return reject('notAllowed', msg);
          void extra.summary.get(tabId, msg, post).catch((e: unknown) => {
            deps.log('summary/error', { error: e instanceof Error ? e.name : 'unknown' });
            post({ type: 'summary/last', requestId: msg.requestId, tabId });
          });
          return;
        // 框选截图（5.13）：小窗截所在标签页，侧边栏截订阅的标签页（上面已核对仍在本窗口）
        case 'capture/begin':
          if (!capture) return reject('notAllowed', msg);
          return capture.fromClient(
            tabId,
            st.role === 'sidepanel' ? st.windowId : sender.tab?.windowId,
            st.role === 'sidepanel' ? 'panel' : 'float',
          );
        case 'capture/discard':
          return capture?.discard(tabId, msg.captureId);
        case 'image/get': {
          if (!capture) return reject('notAllowed', msg);
          const url = await deps.getTabUrl?.(tabId).catch(() => undefined);
          const pageKey = url === undefined ? undefined : toPageKey(url);
          const scope = st.role === 'sidepanel' ? 'any' : 'page';
          return capture.sendImage(msg, (cid) => jobs.viewFor(tabId, cid, pageKey, scope), post, reject);
        }
        default:
          // 切换档位与模型本版本不做
          return reject('notAllowed', msg);
      }
    }

    let chain: Promise<void> = Promise.resolve();
    port.onMessage.addListener((raw) => {
      chain = chain
        .then(() => handle(raw))
        .catch((e: unknown) => deps.log('conv/error', { error: e instanceof Error ? e.name : 'unknown' }));
    });
    port.onDisconnect.addListener(() => {
      hub.unsubscribe(port);
      if (st.windowId !== undefined) hub.removePanel(st.windowId, port);
    });
  };
}
