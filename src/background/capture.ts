// 框选截图（5.13、E1–E4）：后台一侧的流程、身份核对与待确认截图的保管。
//
// 流程：快捷键（commands.ts）或输入区「截图」按钮（conv.ts）→ 注入阅读器（三级站点都允许，4.1）→ capture/start，
// 阅读器显示遮罩 → 用户拖出矩形，阅读器回 capture/rect（视口坐标 + 按下鼠标时的视口修订号 + 视口尺寸）→
// 核对（下表）→ capture/hideOverlay：阅读器隐藏遮罩与小窗、等两帧，应答当前修订号 → 再核对 → captureVisibleTab →
// capture/end：阅读器恢复小窗，应答修订号 → 截图期间也没变才算数 → 裁剪（按实际图片尺寸 ÷ 视口换算，不假定 DPR）→
// 存成待确认截图（storage.session，只在内存）→ conv/capture 把缩略图推给这个标签页的小窗 / 侧边栏 → 用户发问即确认，
// 后台在接单事务里把原图写进 blobs 表（jobs.ts），原图随这一问发给模型。
//
// 身份绑定 windowId + tabId + documentId + viewportRevision：
// | 核对 | 对不上 |
// | capture/rect 的 captureId 是这个标签页当前进行中的那次 | 拒绝（notOwner），不截图 |
// | 发送者是顶层框架、文档就是开始时注入的那个（sender.documentId） | 拒绝（notOwner） |
// | 标签页仍是所在窗口的活动标签页、窗口没变 | 丢弃（changed），请用户重选 |
// | 隐藏遮罩后、截图后阅读器报的修订号与视口尺寸都和框选时相同（滚动、缩放、窗口尺寸、侧边栏开合、切窗都会让它变） | 丢弃（changed） |
// | 图片横纵比例与视口一致 | 丢弃（changed） |
//
// 原图不经网页 DOM、不进界面（规则 4）：界面只拿到缩略图（conv/capture、image/thumb，单条远小于 64 KB）；
// 原图只在后台、storage.session、数据库与发给模型的请求里。
import { base64ToBytes, parseDataUrl } from '@/core/capture/data-url';
import { type CssRect, type Size, sameViewport } from '@/core/capture/geometry';
import { floatHostable } from '@/core/domain/float';
import type {
  BackgroundToClient,
  CaptureFailReason,
  CaptureFrameReply,
  ClientToBackground,
  ContentToBackground,
  RejectReason,
} from '@/core/domain/messages';
import type { BlobRecord, ConversationRecord, MessageImage } from '@/core/domain/records';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import type { CommandTab } from './commands';
import type { BackgroundDeps } from './deps';
import type { FloatHost } from './float-host';
import type { Hub } from './hub';
import type { Route } from './route';
import type { Store } from './store';

/** 谁发起的：快捷键、小窗的按钮、侧边栏的按钮。决定截好后去哪显示预览 */
export type CaptureOrigin = 'command' | 'float' | 'panel';

/** 进行中的框选（storage.session，后台在用户拖框期间被回收也接得上） */
export interface CaptureStart {
  captureId: string;
  tabId: number;
  windowId: number;
  /** 注入阅读器时的顶层文档 */
  documentId: string;
  origin: CaptureOrigin;
  /** 快捷键处理时已经替用户打开了侧边栏（小窗用不了） */
  toPanel: boolean;
  at: number;
}

/** 待确认的截图（storage.session，内存型，不落盘）：发问时取走 */
export interface PendingCapture {
  captureId: string;
  tabId: number;
  windowId: number;
  documentId: string;
  dataUrl: string;
  mime: string;
  width: number;
  height: number;
  thumb: string;
  at: number;
}

/** 发问时取出的截图：图片记录（接单事务里写进 blobs）、消息里的引用、发给模型的 data URL */
export interface TakenCapture {
  dataUrl: string;
  image: MessageImage;
  blob: BlobRecord;
}

/** 用户迟迟不拖框，进行中的框选多久作废 */
export const CAPTURE_START_TTL_MS = 5 * 60_000;
/** 待确认的截图多久没被发问取走就作废 */
export const PENDING_CAPTURE_TTL_MS = 30 * 60_000;
/** 最多同时保管几张待确认截图（每张标签页一张；storage.session 总共只有 10 MB） */
export const MAX_PENDING_CAPTURES = 3;
/** captureVisibleTab 每秒最多 2 次（MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND）：两次之间至少隔这么久 */
const SHOT_INTERVAL_MS = 550;
/** 历史缩略图的内存缓存条数 */
const THUMB_CACHE = 24;

const CAPTURE_PREFIX = SESSION_KEYS.capture(0).replace(/0$/, '');

type RectMsg = Extract<ContentToBackground, { type: 'capture/rect' }>;
type Reply = (msg: BackgroundToClient) => void;

/**
 * capture/rect 的身份核对（纯函数，单测直接测）。notOwner：不是这个标签页当前进行中的那次、或不是开始时的那个文档，
 * 不截图；changed：标签页不再是活动页、挪到了别的窗口，丢弃并请用户重选
 */
export function verifyRect(
  start: CaptureStart | undefined,
  msg: Pick<RectMsg, 'captureId'>,
  sender: { tabId: number; frameId: number; documentId: string | undefined },
  tab: { active: boolean; windowId: number } | undefined,
  now: number,
): 'ok' | 'notOwner' | 'changed' {
  if (!start || start.captureId !== msg.captureId || start.tabId !== sender.tabId) return 'notOwner';
  if (sender.frameId !== 0 || sender.documentId !== start.documentId) return 'notOwner';
  if (now - start.at > CAPTURE_START_TTL_MS) return 'notOwner';
  if (!tab?.active || tab.windowId !== start.windowId) return 'changed';
  return 'ok';
}

/** 阅读器的应答（hideOverlay / end）与框选时一致：同一次、修订号相同、视口尺寸相同 */
export function sameFrame(
  rect: Pick<RectMsg, 'captureId' | 'viewportRevision' | 'viewport'>,
  reply: unknown,
) {
  const r = reply as Partial<CaptureFrameReply> | undefined;
  return (
    r !== undefined &&
    r !== null &&
    r.captureId === rect.captureId &&
    r.viewportRevision === rect.viewportRevision &&
    typeof r.viewport?.w === 'number' &&
    typeof r.viewport?.h === 'number' &&
    sameViewport(r.viewport as Size, rect.viewport)
  );
}

export const previewOf = (p: PendingCapture): Extract<BackgroundToClient, { type: 'conv/capture' }> => ({
  type: 'conv/capture',
  captureId: p.captureId,
  thumb: p.thumb,
  width: p.width,
  height: p.height,
});

const errName = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : 'unknown');

export type Capture = ReturnType<typeof createCapture>;

export function createCapture(deps: BackgroundDeps, store: Store, hub: Hub, host: FloatHost, route: Route) {
  const starts = new Map<number, CaptureStart>();
  const thumbs = new Map<string, string>();
  let lastShotAt = Number.NEGATIVE_INFINITY;

  async function getStart(tabId: number): Promise<CaptureStart | undefined> {
    const mem = starts.get(tabId);
    if (mem) return mem;
    const key = SESSION_KEYS.captureStart(tabId);
    return (await deps.session.get(key))[key] as CaptureStart | undefined;
  }

  async function clearStart(tabId: number, captureId: string): Promise<void> {
    if (starts.get(tabId)?.captureId === captureId) starts.delete(tabId);
    await deps.session.remove(SESSION_KEYS.captureStart(tabId));
  }

  async function getPending(tabId: number): Promise<PendingCapture | undefined> {
    const key = SESSION_KEYS.capture(tabId);
    const p = (await deps.session.get(key))[key] as PendingCapture | undefined;
    if (p && deps.now() - p.at > PENDING_CAPTURE_TTL_MS) {
      await deps.session.remove(key);
      hub.toTab(tabId, { type: 'conv/captureCleared', captureId: p.captureId });
      return undefined;
    }
    return p;
  }

  /** 存下待确认的截图：同一标签页的旧截图被替换；总数超出时丢掉最早的（它们的界面收到 captureCleared） */
  async function putPending(p: PendingCapture): Promise<void> {
    const all = await deps.session.get(null);
    const others: PendingCapture[] = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(CAPTURE_PREFIX)) continue;
      const x = v as PendingCapture;
      if (x.tabId === p.tabId) hub.toTab(x.tabId, { type: 'conv/captureCleared', captureId: x.captureId });
      else others.push(x);
    }
    others.sort((a, b) => a.at - b.at);
    const drop = others.slice(0, Math.max(0, others.length - (MAX_PENDING_CAPTURES - 1)));
    if (drop.length > 0) await deps.session.remove(drop.map((x) => SESSION_KEYS.capture(x.tabId)));
    for (const x of drop) hub.toTab(x.tabId, { type: 'conv/captureCleared', captureId: x.captureId });
    await deps.session.set({ [SESSION_KEYS.capture(p.tabId)]: p });
  }

  /** 截图没成功：告诉这个标签页的界面；页面变了的再在网页上提示一行（用户此刻看着网页，可能没开界面） */
  function failed(tabId: number, reason: CaptureFailReason, documentId?: string): void {
    deps.log('capture/failed', { reason });
    hub.toTab(tabId, { type: 'conv/captureFailed', reason });
    if (documentId === undefined || reason === 'unsupported') return;
    void deps
      .sendToFrame(tabId, 0, documentId, {
        type: 'page/notice',
        kind: reason === 'changed' ? 'captureChanged' : 'captureFailed',
      })
      .catch(() => undefined);
  }

  function unsupportedNotice(tabId: number): void {
    deps.log('capture/failed', { reason: 'unsupported' });
    store.putNotice(tabId, 'captureUnsupported');
    hub.toTab(tabId, { type: 'conv/notice', kind: 'captureUnsupported' });
  }

  const frame = (st: CaptureStart, type: 'capture/hideOverlay' | 'capture/end') =>
    deps.requestFrame
      ? deps.requestFrame(st.tabId, 0, st.documentId, { type, captureId: st.captureId })
      : Promise.reject(new Error('requestFrame 不可用'));

  /** 开始框选：注入阅读器（同一文档只注入一次），记下这次框选，让阅读器显示遮罩 */
  async function begin(
    tabId: number,
    windowId: number,
    origin: CaptureOrigin,
    toPanel = false,
  ): Promise<void> {
    let documentId: string;
    try {
      documentId = await deps.injectReader(tabId);
    } catch (e) {
      deps.log('capture/injectFailed', { error: errName(e) });
      // 快捷键发起的在侧边栏顶部说明（界面可能还没打开）；按钮发起的在那个界面里提示
      if (origin === 'command') return unsupportedNotice(tabId);
      return failed(tabId, 'unsupported');
    }
    const st: CaptureStart = {
      captureId: deps.newId(),
      tabId,
      windowId,
      documentId,
      origin,
      toPanel,
      at: deps.now(),
    };
    starts.set(tabId, st);
    await deps.session.set({ [SESSION_KEYS.captureStart(tabId)]: st });
    try {
      await deps.sendToFrame(tabId, 0, documentId, { type: 'capture/start', captureId: st.captureId });
    } catch (e) {
      await clearStart(tabId, st.captureId);
      deps.log('capture/startFailed', { error: errName(e) });
      failed(tabId, 'failed');
    }
  }

  /** 截好之后在哪显示预览：按「问」的去向规则（5.4）。按钮发起的留在原处（预览已推给它） */
  async function present(st: CaptureStart): Promise<void> {
    if (st.origin !== 'command' || st.toPanel) return;
    if (await route.panelOpenIn(st.windowId)) return;
    await host.show(st.tabId);
  }

  async function shoot(st: CaptureStart, msg: RectMsg): Promise<void> {
    let ended = false;
    const end = async () => {
      if (ended) return undefined;
      ended = true;
      return frame(st, 'capture/end').catch(() => undefined);
    };
    try {
      // 隐藏遮罩与小窗、等两帧（阅读器做），应答的修订号与视口仍是框选时的才截
      const hidden = await frame(st, 'capture/hideOverlay').catch(() => undefined);
      if (!sameFrame(msg, hidden)) {
        await end();
        return failed(st.tabId, 'changed', st.documentId);
      }
      const wait = lastShotAt + SHOT_INTERVAL_MS - deps.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastShotAt = deps.now();
      if (!deps.captureVisibleTab || !deps.captureImages) throw new Error('截图能力不可用');
      const shot = await deps.captureVisibleTab(st.windowId);
      // 截图期间也不能变：阅读器恢复小窗时再报一次修订号；标签页仍是活动页（截的就是它）
      const after = await end();
      const tab = await deps.tabState?.(st.tabId);
      if (!sameFrame(msg, after) || !tab?.active || tab.windowId !== st.windowId)
        return failed(st.tabId, 'changed', st.documentId);
      const img = await deps.captureImages.process(shot, msg.rect as CssRect, msg.viewport);
      if (img === 'mismatch') return failed(st.tabId, 'changed', st.documentId);
      const pending: PendingCapture = {
        captureId: st.captureId,
        tabId: st.tabId,
        windowId: st.windowId,
        documentId: st.documentId,
        ...img,
        at: deps.now(),
      };
      await putPending(pending);
      hub.toTab(st.tabId, previewOf(pending));
      deps.log('capture/ready', { origin: st.origin, width: img.width, height: img.height, mime: img.mime });
      await present(st).catch((e: unknown) => deps.log('capture/presentFailed', { error: errName(e) }));
    } catch (e) {
      await end();
      deps.log('capture/shotFailed', { error: errName(e) });
      failed(st.tabId, 'failed', st.documentId);
    }
  }

  async function freeTake(tabId: number, captureId: string): Promise<void> {
    const p = await getPending(tabId);
    if (p?.captureId !== captureId) return;
    await deps.session.remove(SESSION_KEYS.capture(tabId));
    hub.toTab(tabId, { type: 'conv/captureCleared', captureId });
  }

  return {
    /**
     * 快捷键「框选截图」：在命令处理的同步段里调用。去向同「问」（5.4）：小窗失败过、这一页放不了小窗时当场 open 侧边栏
     * （规则 10，之前不 await）；这一页截不了图（浏览器内部页面）时侧边栏顶部说明原因
     */
    command(tab: CommandTab): void {
      const { id: tabId, windowId } = tab;
      if (tabId === undefined || windowId === undefined) return;
      const hostable = floatHostable(tab.url);
      const d = route.decide(tabId, windowId, { forcePanel: !hostable });
      if (d.toPanel) void route.finish(tabId, d, hostable).catch(() => undefined);
      if (!hostable) {
        unsupportedNotice(tabId);
        return;
      }
      void begin(tabId, windowId, 'command', d.toPanel).catch((e: unknown) =>
        deps.log('capture/beginFailed', { error: errName(e) }),
      );
    },

    /** 输入区的「截图」按钮（小窗、侧边栏是扩展页面，点按钮是合法手势；截图本身不需要手势） */
    async fromClient(tabId: number, windowId: number | undefined, origin: 'float' | 'panel'): Promise<void> {
      const w = windowId ?? (await deps.tabWindow(tabId));
      if (w === undefined) return failed(tabId, 'failed');
      await begin(tabId, w, origin);
    },

    /** capture/rect：核对身份 → 隐藏遮罩、截图、裁剪 → 存成待确认截图并推预览 */
    async onRect(
      msg: RectMsg,
      sender: { tabId: number; frameId: number; documentId: string | undefined },
    ): Promise<RejectReason | undefined> {
      const st = await getStart(sender.tabId);
      const tab = await deps.tabState?.(sender.tabId);
      const verdict = verifyRect(st, msg, sender, tab, deps.now());
      if (verdict === 'notOwner' || !st) return 'notOwner';
      await clearStart(st.tabId, st.captureId);
      if (verdict === 'changed') {
        await frame(st, 'capture/end').catch(() => undefined);
        failed(st.tabId, 'changed', st.documentId);
        return undefined;
      }
      await shoot(st, msg);
      return undefined;
    },

    /** capture/cancel：用户取消（阅读器已自己移除遮罩） */
    async onCancel(
      msg: Extract<ContentToBackground, { type: 'capture/cancel' }>,
      sender: { tabId: number; frameId: number; documentId: string | undefined },
    ): Promise<RejectReason | undefined> {
      const st = await getStart(sender.tabId);
      if (!st || st.captureId !== msg.captureId || sender.documentId !== st.documentId) return 'notOwner';
      await clearStart(st.tabId, st.captureId);
      deps.log('capture/cancelled', { origin: st.origin });
      return undefined;
    },

    /** 订阅时补发：这个标签页有待确认的截图就给预览 */
    async preview(tabId: number): Promise<BackgroundToClient | undefined> {
      const p = await getPending(tabId);
      return p ? previewOf(p) : undefined;
    },

    /**
     * 发问时取截图（jobs.ts 接单时调用）：编号对得上才给；只读不删，接单成功后再 consumed。
     * 给出的图片记录 refCount 为 1，与用户消息在同一个事务里写进库
     */
    async take(tabId: number, captureId: string): Promise<TakenCapture | undefined> {
      const p = await getPending(tabId);
      if (p?.captureId !== captureId) return undefined;
      const parsed = parseDataUrl(p.dataUrl);
      if (!parsed) return undefined;
      const blobId = deps.newId();
      return {
        dataUrl: p.dataUrl,
        image: { blobId, mime: p.mime, width: p.width, height: p.height },
        blob: {
          id: blobId,
          mime: p.mime,
          data: new Blob([base64ToBytes(parsed.base64) as BlobPart], { type: p.mime }),
          refCount: 1,
          createdAt: deps.now(),
        },
      };
    },

    /** 接单成功：截图已随这一问存进库，待确认的那份删掉，各界面收起预览 */
    consumed: freeTake,

    /** capture/discard：用户点了预览上的 × */
    discard: freeTake,

    /**
     * image/get：历史消息里的图 → 缩略图。view 按端口的授权范围核对对话（小窗只能看所在页面的，侧边栏任意），
     * 对不上拒绝；图已不在（对话删了）回 gone
     */
    async sendImage(
      msg: Extract<ClientToBackground, { type: 'image/get' }>,
      view: (conversationId: string) => Promise<{ conversation?: ConversationRecord } | 'notOwner'>,
      reply: Reply,
      reject: (reason: RejectReason, raw: unknown) => void,
    ): Promise<void> {
      const m = await deps.db.getMessage(msg.messageId).catch(() => undefined);
      const ref = m?.images?.[msg.index];
      if (!m || !ref) return reject('gone', msg);
      const v = await view(m.conversationId).catch(() => 'notOwner' as const);
      if (v === 'notOwner' || !v.conversation) return reject('notOwner', msg);
      let thumb = thumbs.get(ref.blobId);
      if (thumb === undefined) {
        const blob = await deps.db.getBlob(ref.blobId).catch(() => undefined);
        if (!blob || !deps.captureImages) return reject('gone', msg);
        thumb = await deps.captureImages.thumbnail(blob.data).catch(() => undefined);
        if (thumb === undefined) return reject('gone', msg);
        thumbs.set(ref.blobId, thumb);
        for (const k of thumbs.keys()) if (thumbs.size > THUMB_CACHE) thumbs.delete(k);
      }
      reply({
        type: 'image/thumb',
        requestId: msg.requestId,
        messageId: msg.messageId,
        index: msg.index,
        thumb,
      });
    },

    /** 标签页关闭：进行中的框选与待确认的截图一并作废 */
    async forgetTab(tabId: number): Promise<void> {
      starts.delete(tabId);
      await deps.session.remove([SESSION_KEYS.captureStart(tabId), SESSION_KEYS.capture(tabId)]);
    },
  };
}
