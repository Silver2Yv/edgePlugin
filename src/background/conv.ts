// 对话流端口（CONV_PORT，5.12）：角色只取自 sender（规则 7），每条消息都过 parseFrom；
// 握手前只收 helloFloat / resumeFloat / helloSidepanel。拒绝时只回 conv/rejected，不写入、不发请求。
// 同一端口的消息按到达顺序串行处理（握手写完绑定后才处理订阅）。
//
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
import type { BackgroundDeps, ConvPort } from './deps';
import type { FloatHost } from './float-host';
import type { Hub } from './hub';
import type { Jobs } from './jobs';
import { quoteOf } from './quote';
import { senderRole, senderSummary } from './roles';
import type { Store } from './store';

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

export function createConv(deps: BackgroundDeps, store: Store, hub: Hub, host: FloatHost, jobs: Jobs) {
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
     * 先做完所有 await，再在一个同步段里换订阅、发标记、补发、登记订阅者：补发与之后的实时推送不交错、不漏。
     * 快照最后发：它是「这次订阅的初始推送已经发完」的标志
     */
    async function pushSubscription(tabId: number, msg: SubscribeMsg): Promise<void> {
      await jobs.ready;
      const sel = await store.getSelection(tabId);
      const url =
        msg.conversationId === undefined ? await deps.getTabUrl?.(tabId).catch(() => undefined) : undefined;
      const notice = st.role === 'sidepanel' ? store.takeNotice(tabId) : undefined;
      // —— 同步段开始
      hub.unsubscribe(port);
      st.tabId = tabId;
      const cur = jobs.current(tabId, msg.conversationId, url === undefined ? undefined : toPageKey(url));
      const resumed = msg.resume ? jobs.jobOf(tabId, msg.resume.jobId) : undefined;
      const job = resumed ?? cur?.job;
      post({
        type: 'conv/subscribed',
        tabId,
        ...(cur ? { conversationId: cur.conversationId } : {}),
        ...(job ? { job } : {}),
      });
      if (notice) post({ type: 'conv/notice', kind: notice });
      if (sel) post(quoteOf(sel));
      if (job) jobs.replayNow(tabId, job.jobId, resumed && msg.resume ? msg.resume.lastSeq : 0, post);
      hub.subscribe(tabId, port);
      // —— 同步段结束。续播的任务不在内存（后台重启过）：只能报热副本里的状态
      if (msg.resume && !resumed) await jobs.replay(tabId, msg.resume, post);
      post({ type: 'conv/snapshot', messages: [], done: true, conversationRevision: 0 });
    }

    async function subscribeSidepanel(msg: SubscribeMsg): Promise<void> {
      const tabId = msg.tabId;
      if (tabId === undefined) return reject('invalid', msg);
      if (!(await inPanelWindow(tabId))) return reject('notOwner', msg);
      const owner = msg.conversationId === undefined ? undefined : jobs.ownerOf(msg.conversationId);
      if (owner !== undefined && owner !== tabId) return reject('notOwner', msg);
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
      const owner = conversationId === undefined ? undefined : jobs.ownerOf(conversationId);
      if (owner !== undefined && owner !== tabId) return reject('notOwner', msg);
      // 对话不在了（后台重启过，本版本对话只在内存）：转过去侧边栏也显示不出来，不转，小窗留着这份回答
      if (conversationId !== undefined && owner === undefined) return reject('gone', msg);
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
      // 以下需要目标标签页：小窗是令牌绑定的那个，侧边栏是当前订阅的那个（须仍在本窗口）
      const tabId = st.tabId;
      if (tabId === undefined) return reject('notAllowed', msg);
      if (st.role === 'sidepanel' && !(await inPanelWindow(tabId))) return reject('notOwner', msg);
      switch (msg.type) {
        case 'conv/subscribe': {
          if (msg.tabId !== undefined && msg.tabId !== tabId) return reject('notOwner', msg);
          const owner = msg.conversationId === undefined ? undefined : jobs.ownerOf(msg.conversationId);
          if (owner !== undefined && owner !== tabId) return reject('notOwner', msg);
          return pushSubscription(tabId, msg);
        }
        case 'conv/ask':
          // 发问的端口也收这次任务的推送
          hub.subscribe(tabId, port);
          return jobs.ask(tabId, msg, post);
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
        default:
          // 切换档位与模型、历史、收藏、引用跳回本版本不做
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
