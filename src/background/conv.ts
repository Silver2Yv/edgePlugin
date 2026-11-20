// 对话流端口（CONV_PORT，5.12）：角色只取自 sender（规则 7），每条消息都过 parseFrom；
// 握手前只收 helloFloat / resumeFloat / helloSidepanel。拒绝时只回 conv/rejected，不写入、不发请求。
// 同一端口的消息按到达顺序串行处理（握手写完绑定后才处理订阅）。

import { bindingMatches } from '@/core/domain/float';
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

interface PortState {
  role: SenderRole;
  handshaken: boolean;
  /** 小窗绑定的标签页（握手成功后才有） */
  tabId: number | undefined;
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

export function createConv(deps: BackgroundDeps, store: Store, hub: Hub, host: FloatHost, jobs: Jobs) {
  return function onConnect(port: ConvPort): void {
    if (port.name !== CONV_PORT) return;
    const sender = port.sender ?? {};
    const st: PortState = { role: senderRole(sender, deps.self), handshaken: false, tabId: undefined };
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
          st.handshaken = true;
          return post({ type: 'conv/ready', role: 'sidepanel', protocolVersion: PROTOCOL_VERSION });
        default:
          break;
      }
      // 以下需要小窗绑定的标签页。侧边栏的订阅与发问本版本不做
      const tabId = st.tabId;
      if (st.role !== 'float' || tabId === undefined) return reject('notAllowed', msg);
      switch (msg.type) {
        case 'conv/subscribe': {
          if (msg.tabId !== undefined && msg.tabId !== tabId) return reject('notOwner', msg);
          const owner = msg.conversationId === undefined ? undefined : jobs.ownerOf(msg.conversationId);
          if (owner !== undefined && owner !== tabId) return reject('notOwner', msg);
          hub.subscribe(tabId, port);
          const sel = await store.getSelection(tabId);
          if (sel) post(quoteOf(sel));
          if (msg.resume) await jobs.replay(tabId, msg.resume, post);
          // 最后发快照：它是「这次订阅的初始推送（引用、续播的增量）已经发完」的标志
          post({ type: 'conv/snapshot', messages: [], done: true, conversationRevision: 0 });
          return;
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
        default:
          // 切换档位与模型、转侧边栏本版本不做
          return reject('notAllowed', msg);
      }
    }

    let chain: Promise<void> = Promise.resolve();
    port.onMessage.addListener((raw) => {
      chain = chain
        .then(() => handle(raw))
        .catch((e: unknown) => deps.log('conv/error', { error: e instanceof Error ? e.name : 'unknown' }));
    });
    port.onDisconnect.addListener(() => hub.unsubscribe(port));
  };
}
