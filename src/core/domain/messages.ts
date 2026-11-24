// 消息协议（5.12）：所有跨上下文消息都在这里定义。后台入口用 parseFrom() 做运行时校验，
// 授权表之外、未知类型、未知字段、超限的一律拒绝，且拒绝无写入、无网络副作用。
//
// 通道（5.12）
// | 通道 | 方向 | 机制 |
// | 意图 | 内容脚本 → 后台 | runtime.sendMessage |
// | 指令 | 后台 → 指定框架 | tabs.sendMessage（指定 frameId + documentId） |
// | 对话流 | 小窗 / 侧边栏 ↔ 后台 | runtime.connect，端口名 CONV_PORT |
// | 小窗私有 | 小窗 ↔ 所在标签页的阅读器 | tabs.connect，端口名 FLOAT_PORT |
// | 设置变更 | 后台 → 扩展页面 | storage.onChanged（不在本文件） |
//
// 身份（tabId、frameId、documentId、来源）一律取自 sender，消息体里没有这些字段（规则 7）。
// 内容脚本的消息不能携带请求地址或密钥（规则 6）：下面的意图消息没有任何 URL / Key 字段，未知字段被拒。
//
// 大小（5.12）：整条消息 JSON 序列化后不超过 64 KB。大字段按 JSON 字节设上限（maxBytes，见 bytes.ts），
// 每条消息的字段上限之和都小于 64 KB，所以「字段合法」就一定「不超限」（单测逐条核对）。
import { PASTE_CHUNK_CHARS, PASTE_MIMES } from '../capture/paste';
import { BLOCK_KINDS, PAGE_NOTE_KINDS } from '../context/page-doc';
import type { ContextTier, RequestContextPlan } from '../context/plan';
import type { ModelError, ModelErrorKind, Usage } from '../llm/adapter';
import { type ActionSummary, BUILTIN_ACTION_IDS } from './actions';
import type { AskRoute } from './float';
import { FLOAT_LIMITS, TOKEN_PATTERN } from './float';
import { ID_PATTERN } from './ids';
import { JOB_LIMITS, type JobState } from './job';
import type { ConversationRecord, MessageRecord } from './records';
import { arr, bool, type Infer, int, lit, num, obj, oneOf, opt, type Result, str, tagged } from './schema';
import type { SiteLevel } from './site-policy';

export const CONV_PORT = 'conv';
export const FLOAT_PORT = 'float';

/** 协议版本：conv/ready 带上，扩展更新后旧页面与新后台对不上时界面提示刷新 */
export const PROTOCOL_VERSION = 1;

const KB = 1024;
const id = str({ pattern: ID_PATTERN });
/** 选中文字：内容脚本按 JSON 字节截断到 48 KB（约 1.6 万汉字），truncated 记入「实际发送说明」 */
const selectionText = str({ maxBytes: JOB_LIMITS.maxFieldBytes });
const actionId = str({
  max: 80,
  pattern: new RegExp(`^(${BUILTIN_ACTION_IDS.join('|')}|custom:[a-z0-9-]{8,64})$`),
});
const modelRef = obj({ connectionId: id, model: str({ min: 1, max: 200 }) });
const lengthTier = oneOf(['brief', 'normal', 'detailed']);
const contextTier = oneOf(['selection', 'nearby', 'fullPage']);

export const anchorSchema = obj({
  exact: str({ maxBytes: 12 * KB }),
  prefix: str({ maxBytes: KB }),
  suffix: str({ maxBytes: KB }),
  blockDigest: str({ max: 128, pattern: /^[0-9a-z]*$/ }),
  headingPath: arr(str({ maxBytes: KB }), { max: 12 }),
  scrollRatio: num({ min: 0, max: 1 }),
  offsetInBlock: int({ min: 0 }),
});

const blockId = str({ min: 1, max: 32, pattern: /^[\w-]+$/ });

/** 阅读器上报的块；frameId 不在这里，由后台按 sender 盖章 */
const blockSchema = obj({
  id: blockId,
  kind: oneOf(BLOCK_KINDS),
  level: opt(int({ min: 1, max: 6 })),
  text: str({ max: 60_000 }),
  headingPath: arr(str({ max: 500 }), { max: 12 }),
  lang: opt(str({ max: 40 })),
});

// ───────────── 意图：内容脚本（哨兵 / 阅读器）→ 后台 ─────────────

export const contentToBackground = tagged({
  /** 选区就绪：用于预热与回告去向（B7）。不带选中文字，点击时才带 */
  'selection/ready': obj({
    type: lit('selection/ready'),
    selectionRevision: int({ min: 0 }),
    textLength: int({ min: 0 }),
    inCode: bool,
  }),
  /**
   * 动作点击（工具栏），必须来自 isTrusted 事件。选中文字只在这里传一次：
   * 后台按 sender（tabId + frameId + documentId）存进 storage.session，之后 conv/ask 只引用 selectionRevision。
   */
  'action/click': obj({
    type: lit('action/click'),
    actionId,
    selectionRevision: int({ min: 0 }),
    text: selectionText,
    /** 原文超过 48 KB 被截断 */
    truncated: bool,
    /** 截断前的字数（码点） */
    originalLength: int({ min: 0 }),
    inCode: bool,
  }),
  /**
   * 阅读器给选区补上锚点与所在块（选区就绪后异步算出）。
   * contentVersion（contract-v1.3 增量，可选）：blockIds 属于哪一次抽取；后台只在版本对得上时直接采用块号，
   * 对不上就用锚点在新版本里重新定位，不把旧块号套到新内容上（V-06）
   */
  'selection/anchored': obj({
    type: lit('selection/anchored'),
    selectionRevision: int({ min: 0 }),
    anchor: anchorSchema,
    blockIds: arr(blockId, { max: 200 }),
    contentVersion: opt(str({ max: 128 })),
  }),
  /** 请求页面侧配置（工具栏按钮、站点级别、去向） */
  'config/get': obj({ type: lit('config/get') }),
  /** 回传页面模型分片（应答 page/read）；拼齐后按 PageDoc 校验 */
  'page/docPart': obj({
    type: lit('page/docPart'),
    readId: id,
    index: int({ min: 0, max: 999 }),
    total: int({ min: 1, max: 1000 }),
    /** PageDocReport 的 JSON 文本按 JSON 字节切片（splitByJsonBytes） */
    data: str({ maxBytes: JOB_LIMITS.maxFieldBytes }),
  }),
  /**
   * 应答 page/read（contract-v1.3 增量）：重新抽取后指纹与 knownContentVersion 相同，不再回传正文。
   * 后台只在同一文档（sender.documentId）已有这个版本的缓存时采信，否则当作读取失败
   */
  'page/docUnchanged': obj({
    type: lit('page/docUnchanged'),
    readId: id,
    contentVersion: str({ max: 128 }),
  }),
  /**
   * 定位与高亮结果（应答 page/locate）。
   * back（contract-v1.5 增量）：阅读器已记下跳转前的阅读位置，可以「回到刚才阅读的位置」（F4）
   */
  'page/locateResult': obj({
    type: lit('page/locateResult'),
    requestId: id,
    level: oneOf(['exact', 'fuzzy', 'scroll', 'none']),
    back: opt(bool),
  }),
  /**
   * 框选完成：视口坐标（CSS 像素）与视口修订号。contract-v1.5 增量 viewport：框选时的视口尺寸（CSS 像素），
   * 后台按「图片尺寸 ÷ 视口尺寸」换算坐标（5.13，不假定 devicePixelRatio）。viewportRevision 是按下鼠标那一刻的；
   * 之后滚动、缩放、窗口尺寸变化都会让阅读器的修订号加一，后台在截图前后各核对一次，对不上就丢弃（绝不发错图）
   */
  'capture/rect': obj({
    type: lit('capture/rect'),
    captureId: id,
    viewportRevision: int({ min: 0 }),
    rect: obj({ x: num(), y: num(), w: num({ min: 1 }), h: num({ min: 1 }) }),
    viewport: obj({ w: num({ min: 1 }), h: num({ min: 1 }) }),
  }),
  'float/loadResult': obj({
    type: lit('float/loadResult'),
    result: oneOf(['ready', 'failedUnsupported', 'failedTransient']),
  }),
  /**
   * contract-v1.6 增量（决策 078/101）：阅读器把这个文档里不可见满 10 分钟的小窗 iframe 销毁了。
   * 不带内容：身份取自 sender（标签页、顶层框架、文档，规则 7）；后台据此作废这个文档的小窗绑定与令牌，
   * 下次显示按「没有小窗」走（带新令牌现建）。
   * missed 为真：销毁之后阅读器收到了后台发来的、没带令牌的显示（用户点「问」与到点销毁几乎同时，后台发出显示时
   * 还以为有小窗），这次显示落了空。后台不再清理（销毁的清理在先一条里做完了），只在确认现在没有小窗时带新令牌补发
   */
  'float/destroyed': obj({ type: lit('float/destroyed'), missed: opt(bool) }),
  /**
   * contract-v1.5 增量（live）：小窗或侧边栏开着、且订阅了这个标签页时，哨兵据后台下发的 live/toggle
   * 在选区稳定后上报这一次选中的文字，换引用条实时更新（D11、B5）。形状与 action/click 一致，但不触发任何任务、
   * 不经过路由；没有订阅者时后台会撤回 live/toggle，哨兵就不再发这个消息（隐私：没人看着就不把文字交出去）
   */
  'selection/live': obj({
    type: lit('selection/live'),
    selectionRevision: int({ min: 0 }),
    text: selectionText,
    truncated: bool,
    originalLength: int({ min: 0 }),
    inCode: bool,
  }),
  /**
   * contract-v1.5 增量（live）：阅读器在小窗或侧边栏开着期间检测到页面正文有实质变化（或 SPA 换了路由）。
   * 不带正文，只是一个信号；后台转发给该标签页的订阅者（conv/pageChanged），提示「之后的提问会用新内容」
   */
  'page/changed': obj({ type: lit('page/changed') }),
  /** contract-v1.5 增量：用户取消了框选（Esc、右键、遮罩上的「取消」）。必须来自 isTrusted 事件 */
  'capture/cancel': obj({ type: lit('capture/cancel'), captureId: id }),
});
export type ContentToBackground = Infer<typeof contentToBackground>;

/** 页面侧配置（config/get 的应答）。不含 Key、连接地址、历史 */
export interface PageConfig {
  siteLevel: SiteLevel;
  /** contract-v1.4 增量：补上 kind/needsInput/scope——工具栏据此决定点击后是等输入、直接发送、还是不发请求（A2/A3/A6） */
  toolbarActions: readonly ActionSummary[];
  /** 这次提问去小窗还是侧边栏（B7） */
  askRoute: AskRoute;
  /** contract-v1.5 增量（live）：这个标签页现在有没有小窗/侧边栏订阅者；哨兵据此决定要不要实时上报选中文字 */
  liveQuote: boolean;
}

/** 拼好的页面模型（page/docPart 合并后）的校验。身份字段不在这里（规则 7），见 PageDocReport */
export const pageDocSchema = obj({
  contentVersion: str({ max: 128 }),
  title: str({ max: 2_000 }),
  lang: opt(str({ max: 40 })),
  blocks: arr(blockSchema, { max: 20_000 }),
  notes: arr(
    obj({
      kind: oneOf(PAGE_NOTE_KINDS),
      detail: opt(str({ max: 500 })),
    }),
    { max: 100 },
  ),
  textLength: int({ min: 0 }),
  extractedAt: int({ min: 0 }),
});

// ───────────── 指令：后台 → 指定框架 ─────────────

export const backgroundToContent = tagged({
  'page/read': obj({ type: lit('page/read'), readId: id, knownContentVersion: opt(str({ max: 128 })) }),
  /**
   * 定位并高亮引用的原文（5.7）。锚点由后台按消息里的引用与快照算出，阅读器不接受别处来的锚点。
   * contract-v1.5 增量 blockId / contentVersion：引用的块与它所属的内容版本。阅读器重新抽取后版本相同才直接用块号，
   * 不同就按锚点三级降级重新定位，不把旧块号套到新内容上（V-06）
   */
  'page/locate': obj({
    type: lit('page/locate'),
    requestId: id,
    anchor: anchorSchema,
    highlight: bool,
    blockId: opt(blockId),
    contentVersion: opt(str({ max: 128 })),
  }),
  /** contract-v1.5 增量：回到上次跳转前的阅读位置（F4，只能用一次）；清掉引用高亮 */
  'page/back': obj({ type: lit('page/back') }),
  /**
   * 预热小窗：建隐藏 iframe，token 放进地址片段（#t=），小窗读取后立即用 replaceState 清掉，
   * 连接时出示（片段是否会出现在 performance 资源条目里待 V-05 实测）
   */
  'float/prewarm': obj({ type: lit('float/prewarm'), token: str({ pattern: TOKEN_PATTERN }) }),
  /** 显示小窗；未预热时带 token 现建 */
  'float/show': obj({
    type: lit('float/show'),
    token: opt(str({ pattern: TOKEN_PATTERN })),
    focusInput: bool,
  }),
  'float/hide': obj({ type: lit('float/hide') }),
  /**
   * 在网页上显示一行不挡输入的提示（M4，contract-v1.3 增量）：小窗用不了、本该改用侧边栏，
   * 但浏览器没让后台打开侧边栏时，告诉用户用快捷键或工具栏图标在侧边栏继续。只带原因，不带任何对话内容（规则 4）
   */
  'page/notice': obj({
    type: lit('page/notice'),
    // contract-v1.5 增量：captureChanged 截图前页面变了（滚动、缩放、切页）已丢弃，请重选；captureFailed 截图没成功
    kind: oneOf(['floatFailed', 'floatUnsupported', 'captureChanged', 'captureFailed']),
  }),
  /** 框选截图（5.13）：显示遮罩，等用户拖出矩形（回 capture/rect）或取消（回 capture/cancel） */
  'capture/start': obj({ type: lit('capture/start'), captureId: id }),
  /** 隐藏遮罩与小窗、等两帧后应答 CaptureFrameReply（contract-v1.5 起有应答）：后台据此核对视口没变，再截图 */
  'capture/hideOverlay': obj({ type: lit('capture/hideOverlay'), captureId: id }),
  /**
   * contract-v1.5 增量（live）：告诉这个标签页的哨兵（所有框架）开始/停止实时上报新选中的文字。
   * 后台在这个标签页的订阅者数量由 0 变正时发 enabled:true，变回 0 时发 enabled:false（撤回）。
   * 走广播（不指定 frameId/documentId），每个框架的哨兵各自收到、各自按站点级别决定要不要上报
   */
  'live/toggle': obj({ type: lit('live/toggle'), enabled: bool }),
  /**
   * contract-v1.5 增量：截图结束（成功、丢弃或失败）。阅读器移除遮罩、恢复小窗，应答 CaptureFrameReply——
   * 后台用它核对截图期间视口没有变（截图前后各核对一次）
   */
  'capture/end': obj({ type: lit('capture/end'), captureId: id }),
  /**
   * contract-v1.5 增量（E2，页面图片）：要选区所在块里已经加载出来的图片地址。阅读器只回「页面自己已经加载过」
   * 的图（img.complete && naturalWidth > 0，取 currentSrc，只收 http/https，去重，太小的装饰图跳过，最多
   * MAX_PAGE_IMAGES 张），不凭空构造或猜测地址——内容脚本本就不能携带请求地址（规则 6）指的是「替后台决定发去哪」，
   * 这里只是如实转述页面上已经在渲染的图，后台再按 contentVersion 核对块号没有套到新内容上才采信应答
   */
  'page/images': obj({
    type: lit('page/images'),
    requestId: id,
    blockIds: arr(blockId, { max: 200 }),
    contentVersion: str({ max: 128 }),
  }),
});
/** capture/hideOverlay、capture/end 的应答（阅读器自己产出）：当前视口修订号与视口尺寸 */
export interface CaptureFrameReply {
  captureId: string;
  viewportRevision: number;
  viewport: { w: number; h: number };
}
export type BackgroundToContent = Infer<typeof backgroundToContent>;

/** page/images 的应答（阅读器自己产出，contract-v1.5 增量）：后台按这份 schema 做运行时校验 */
export const MAX_PAGE_IMAGES = 3;
const pageImagesReplySchema = obj({
  requestId: id,
  contentVersion: str({ max: 128 }),
  urls: arr(str({ max: 2000, pattern: /^https?:\/\// }), { max: MAX_PAGE_IMAGES }),
});
export type PageImagesReply = Infer<typeof pageImagesReplySchema>;
export function parsePageImagesReply(v: unknown): Result<PageImagesReply> {
  return pageImagesReplySchema.parse(v);
}

// ───────────── 对话流：小窗 / 侧边栏 → 后台（端口 CONV_PORT） ─────────────

// contract-v1.6 增量：思考强度增加 max（最高，决策 100）；旧消息的四档取值仍然合法
const thinking = oneOf(['off', 'low', 'medium', 'high', 'max']);

const askBody = {
  clientRequestId: id,
  /**
   * 指定续接的对话（用户明确选的，直接续接）。不填按续接规则（D13，见 fresh）找该页近期的对话或新建。
   * 授权（contract-v1.4）：对话属于页面（pageKey）。小窗只能续接所在标签页当前页面的对话（或本进程里在这个标签页上
   * 进行过的），对不上时按不填处理；侧边栏对不上时拒绝（notOwner）
   */
  conversationId: opt(id),
  actionId,
  /** 用户输入的问题；直接发送的动作为空串 */
  text: str({ maxBytes: JOB_LIMITS.maxFieldBytes }),
  /**
   * 引用哪一次选区。选中文字与锚点不经界面转手：后台取 action/click 存下的那份
   * （小窗按令牌绑定的标签页，侧边栏按订阅的标签页），修订号对不上就拒绝
   */
  selectionRevision: opt(int({ min: 0 })),
  contextTier,
  lengthTier,
  thinking,
  model: modelRef,
  /**
   * contract-v1.4 增量：显式「新建对话」。为真时不续接该页近期的对话（D13），不能同时带 conversationId。
   * 不带 conversationId、也不带 fresh 时按续接规则：该页最近的对话距上次提问不超过 30 分钟、且轮数少于 20 才续接
   */
  fresh: opt(bool),
  /**
   * contract-v1.5 增量：附上这个标签页待确认的截图（conv/capture 给的编号）。发问即确认（AR-16）；
   * 后台按发问的标签页取，编号对不上、已被取走或过期回 gone；所选模型能力表里 vision 为 no 时回 noVision
   */
  captureId: opt(id),
} as const;

export const clientToBackground = tagged({
  /**
   * 握手。角色只取自 sender（见 SenderRole），消息里不报角色；握手前其他消息一律拒绝。
   * 小窗：令牌必填。后台核对令牌绑定的 tabId 等于 sender.tab.id，并在同一个同步段里读出即删（原子消费）。
   *   令牌里的 documentId 是宿主页面的，只用于宿主导航后作废令牌，不与 sender.documentId 比较。
   *   成功后记下小窗绑定（FloatBinding），供断线重连。
   */
  'conv/helloFloat': obj({ type: lit('conv/helloFloat'), token: str({ pattern: TOKEN_PATTERN }) }),
  /**
   * 小窗断线重连。后台空闲约 30 秒会被浏览器回收，长连接随之断开（网络诊断包真机复现），而令牌已在首次握手时消费。
   * 不带任何字段：后台核对 sender 的 tabId、frameId、documentId 与绑定一致即恢复握手，之后照常 conv/subscribe（带 resume）。
   * 绑定不存在或对不上时回 conv/rejected（badToken），小窗请宿主重建（换新令牌）。
   */
  'conv/resumeFloat': obj({ type: lit('conv/resumeFloat') }),
  /**
   * 侧边栏：windowId 是面板用 windows.getCurrent() 取到的本窗口。后台能反查时（runtime.getContexts 按
   * sender.documentId 给出窗口）以反查为准、对不上就拒绝；Chrome 159 / Edge 157 实测侧边栏端口的 sender 不带
   * documentId、getContexts 给侧边栏的 windowId 是 -1，反查不了，只能核对这个窗口存在（V-11、决策 072）。
   * 不需要令牌，断线重连时再发一次即可；后台不填 windowId 的一律拒绝
   */
  'conv/helloSidepanel': obj({ type: lit('conv/helloSidepanel'), windowId: opt(int({ min: 0 })) }),
  /**
   * 订阅：小窗只能订阅令牌绑定标签页的对话；侧边栏只能订阅本窗口的标签页（tabId 必填，后台按 tabs.get 核对窗口）。
   * 同一端口再次订阅即换订阅（侧边栏跟随切换标签页），旧标签页的推送随即停止。
   * handoffId：侧边栏接手小窗的转接（6.4）；订阅的初始推送发完后，后台才通知小窗 handoff/done
   */
  'conv/subscribe': obj({
    type: lit('conv/subscribe'),
    conversationId: opt(id),
    tabId: opt(int({ min: 0 })),
    /** 断线重连时带上，后台只补发该任务 seq 之后的增量 */
    resume: opt(obj({ jobId: id, lastSeq: int({ min: 0 }) })),
    handoffId: opt(id),
  }),
  'conv/ask': obj({ type: lit('conv/ask'), ...askBody }),
  'conv/stop': obj({ type: lit('conv/stop'), jobId: id }),
  'conv/retry': obj({ type: lit('conv/retry'), jobId: id }),
  'conv/setTier': obj({
    type: lit('conv/setTier'),
    conversationId: id,
    contextTier: opt(contextTier),
    lengthTier: opt(lengthTier),
    thinking: opt(thinking),
  }),
  'conv/setModel': obj({ type: lit('conv/setModel'), conversationId: id, model: modelRef }),
  /**
   * 小窗点「转到侧边栏」：后台生成 handoffId，绑定 windowId + tabId + conversationId（6.4、AR-19）。
   * contract-v1.3 增量：conversationId 改为可选——还没发问的小窗也能转（侧边栏接手本标签页与引用）
   */
  'handoff/start': obj({ type: lit('handoff/start'), conversationId: opt(id) }),
  /** 仅侧边栏 */
  'history/query': obj({
    type: lit('history/query'),
    queryId: id,
    pageKey: opt(str({ max: 4_000 })),
    text: opt(str({ max: 200 })),
    before: opt(int({ min: 0 })),
    limit: int({ min: 1, max: 100 }),
  }),
  'favorite/add': obj({ type: lit('favorite/add'), conversationId: id, messageId: id }),
  /**
   * contract-v1.5 增量：收藏管理（G2）的编辑与删除。仅侧边栏与小窗（见 ROLE_ALLOWED 的 CONV_COMMON）。
   * 列表与搜索由界面直接只读查询 IndexedDB（5.4）；写入经后台，成功回 favorite/updated / favorite/removed，
   * 失败回 conv/rejected（refId 为 requestId）
   */
  'favorite/update': obj({
    type: lit('favorite/update'),
    requestId: id,
    favoriteId: id,
    title: opt(str({ max: 200 })),
    note: opt(str({ max: 4_000 })),
  }),
  'favorite/remove': obj({ type: lit('favorite/remove'), requestId: id, favoriteId: id }),
  /**
   * 点引用跳回原文（5.7、F1）。后台按消息的发送计划核对编号（规则 9）、按快照算锚点，再发 page/locate 给所订阅标签页的顶层阅读器。
   * contract-v1.5：小窗也可以发（锚点要用后台库里的快照，小窗不经私有端口自己算）；字段改为 citation（回答里的编号，
   * 【12】的 12）与 quote（逐字引用【12】原文【/12】里的原文）。原文只在快照里的块内找，快照过期时须在回答原文里核对过才用。
   * 结果回 citation/located
   */
  'citation/locate': obj({
    type: lit('citation/locate'),
    requestId: id,
    messageId: id,
    citation: str({ min: 1, max: 9, pattern: /^\d+$/ }),
    quote: opt(str({ maxBytes: 12 * KB })),
  }),
  /**
   * contract-v1.4 增量，仅侧边栏：删除一个对话，连同它的消息与无人引用的快照（5.11 级联）。
   * 成功回 history/deleted；对话正有回答在生成时拒绝（busy），写库失败拒绝（storageFailed）
   */
  'history/delete': obj({ type: lit('history/delete'), requestId: id, conversationId: id }),
  /**
   * contract-v1.5 增量：回到上次点引用之前的阅读位置（F4，一次性）。只对所订阅标签页里本扩展上次定位过的文档生效；没有就拒绝（notAllowed）
   */
  'citation/back': obj({ type: lit('citation/back'), requestId: id }),
  /**
   * contract-v1.5 增量：所订阅标签页当前页面（pageKey）上次的总结（6.2、验收第 8 条）。后台让阅读器重新算一次内容指纹
   * （不发正文给模型）与总结所基于的版本比较。回 summary/last
   */
  'summary/get': obj({ type: lit('summary/get'), requestId: id }),
  /**
   * contract-v1.5 增量：输入区的「截图」按钮。小窗是令牌绑定的标签页，侧边栏是订阅的标签页（须仍在本窗口）。
   * 后台注入阅读器、显示遮罩；截好后推 conv/capture，失败推 conv/captureFailed
   */
  'capture/begin': obj({ type: lit('capture/begin') }),
  /** contract-v1.5 增量：去掉待确认的截图（预览上的 ×）。后台删掉这份截图，并推 conv/captureCleared */
  'capture/discard': obj({ type: lit('capture/discard'), captureId: id }),
  /**
   * contract-v1.5 增量：取历史消息里第 index 张图的缩略图（应答 image/thumb）。授权同订阅：
   * 小窗只能看所在标签页当前页面的对话，侧边栏任意历史对话
   */
  'image/get': obj({
    type: lit('image/get'),
    requestId: id,
    messageId: id,
    index: int({ min: 0, max: 15 }),
  }),
  /**
   * contract-v1.6 增量（外部图片粘贴，决策 099）：输入框粘贴的图片，字节分片交给后台（单条消息不超过 64 KB）。
   * paste/begin 声明类型、总字节数与片数；之后按 index 从 0 起依次发 paste/chunk（base64，每片原始 36 KB，最后一片可短）。
   * 收齐后后台核对文件头、缩放编码（同框选截图的上限），存成这个标签页待确认的图，并推 conv/capture（external 为真）；
   * 超限推 conv/captureFailed（tooLarge），不是可用图片推 badImage；顺序、片长、编号对不上拒绝（invalid）并丢弃整次。
   * 小窗是令牌绑定的标签页，侧边栏是订阅的标签页（须仍在本窗口）。声明的 size 不在这里设上限：超限回 tooLarge，而不是笼统的 invalid
   */
  'paste/begin': obj({
    type: lit('paste/begin'),
    uploadId: id,
    mime: oneOf(PASTE_MIMES),
    size: int({ min: 1 }),
    chunks: int({ min: 1 }),
  }),
  'paste/chunk': obj({
    type: lit('paste/chunk'),
    uploadId: id,
    index: int({ min: 0 }),
    data: str({ maxBytes: PASTE_CHUNK_CHARS, pattern: /^[A-Za-z0-9+/]*={0,2}$/ }),
  }),
  /**
   * contract-v1.6 增量，仅侧边栏：回到某一页（决策 098）。pageKey 是「别的页面的对话」所属的页面，favoriteId 是收藏的「回到原文」，
   * 两者恰好给一个（都给或都不给拒绝 invalid）。目标地址由后台按它们从库里取（PageRecord.url / FavoriteRecord.url），
   * 消息里没有地址（规则 6、7）；只开 http / https / file。本窗口已有这一页的标签页就切过去，没有就新开一个并等加载完成；
   * 收藏带锚点时再让阅读器定位并高亮。结果回 jump/result
   */
  'jump/open': obj({
    type: lit('jump/open'),
    requestId: id,
    pageKey: opt(str({ min: 1, max: 4_000 })),
    favoriteId: opt(id),
  }),
});
export type ClientToBackground = Infer<typeof clientToBackground>;

/** 后台 → 小窗 / 侧边栏。后台自己产出，不做运行时校验，只用类型约束 */
export type BackgroundToClient =
  | { type: 'conv/ready'; role: 'float' | 'sidepanel'; protocolVersion: typeof PROTOCOL_VERSION }
  | {
      /**
       * contract-v1.3 增量：订阅生效，是每次订阅初始推送的第一条。之后的推送属于 tabId 这个标签页；
       * 侧边栏换标签页后，收到新标签页的这一条之前到达的推送都是旧标签页的，丢弃。
       * job：这次订阅接上的任务（续播的那个，或该对话最近一次任务），随后按 seq 补发它的增量
       */
      type: 'conv/subscribed';
      tabId: number;
      conversationId?: string;
      job?: { jobId: string; messageId: string };
    }
  | {
      /**
       * contract-v1.3 增量：标签页上接了一个新任务（不论哪个界面发问的），推给该标签页的所有订阅者，
       * 让小窗与侧边栏显示同一个任务。发问的端口另外收到 conv/accepted
       */
      type: 'conv/current';
      conversationId: string;
      jobId: string;
      messageId: string;
      /**
       * contract-v1.5 增量（live）：这一轮的用户消息（问题/动作与引用摘要），供发问端口之外的其他订阅者
       * （另一个小窗、侧边栏）显示这一轮提问的是什么，而不只看到回答。发问的端口自己已经本地显示过，
       * 收到这条时 conversationId 已等于自己的 job，不会重复显示（见归约器）
       */
      userMessage?: {
        id: string;
        ordinal: number;
        /** 直接发送的动作可能是空串；界面按动作名兜底显示 */
        text: string;
        quote?: { text: string; truncated: boolean; originalLength: number };
        /**
         * contract-v1.5 增量（model）：这一轮的动作与页面档位。「换个模型再试」（H12）按它原样重问，
         * 直接发送的动作（解释、总结本页……）不会变成一句普通提问
         */
        request?: { actionId: string; contextTier: ContextTier };
      };
    }
  | {
      /** contract-v1.3 增量：侧边栏顶部的一行说明（5.4 降级提示），只带原因 */
      type: 'conv/notice';
      kind: PanelNoticeKind;
    }
  | {
      type: 'conv/snapshot';
      /** 新对话时为空；分批时只在第一批 */
      conversation?: ConversationRecord;
      /**
       * 按 ordinal 升序分批发送，每批不超过 64 KB；done 为真是最后一批。
       * contract-v1.4 增量：消息从数据库来（后台重启后也在）。一条消息自己就超过上限时切成几片，
       * 同一 id 连续出现，后面的续片只有 segments / reasoning 有意义，按顺序拼到前一片后面；
       * 选中文字连同其他字段仍放不下时 selection.text 只给前 2000 字（truncated 为真）。
       * 进行中任务的助手消息（status 为 accepted / streaming）正文可能落后：同一任务以 conv/delta、conv/jobState 为准
       */
      messages: readonly MessageRecord[];
      done: boolean;
      conversationRevision: number;
    }
  | {
      /** 选区预览，界面显示在引用条里（B2） */
      type: 'conv/quote';
      selectionRevision: number;
      /** 预览用，最多前 2000 字 */
      text: string;
      truncated: boolean;
      originalLength: number;
    }
  | {
      type: 'conv/accepted';
      clientRequestId: string;
      jobId: string;
      messageId: string;
      conversationId: string;
      /**
       * contract-v1.4 增量：没指定对话、该页有近期对话但不合续接规则（D13）而新建了对话时带上原因，
       * 界面提示「已开启新对话，旧的仍可在历史里找回」。idle：距上次提问超过 30 分钟；turnLimit：已满 20 轮
       */
      newConversation?: 'idle' | 'turnLimit';
    }
  | {
      type: 'conv/delta';
      jobId: string;
      messageId: string;
      attemptId: string;
      /** 同一任务内单调递增，不随尝试重置；客户端丢弃 seq ≤ 已见值、或不属于当前尝试的增量 */
      seq: number;
      text?: string;
      reasoning?: string;
    }
  | { type: 'conv/plan'; jobId: string; contextSnapshotId: string; plan: RequestContextPlan }
  | {
      type: 'conv/jobState';
      jobId: string;
      state: JobState;
      attemptId: string;
      /** message 已脱敏、限长 */
      error?: { kind: ModelErrorKind; message: string };
      /** contract-v1.4 增量：终态时带上用量（J9）；中转站没给就没有，不编造 */
      usage?: Usage;
      /** contract-v1.4 增量：参数自动重试去掉的参数（H7）；semantic 为真时是语义敏感参数，界面必须提示 */
      droppedParam?: { param: string; semantic: boolean };
    }
  | { type: 'handoff/created'; handoffId: string }
  | { type: 'handoff/done'; handoffId: string }
  | {
      /**
       * contract-v1.3 增量：本窗口有一个待接的转接（6.4）。侧边栏连上时（conv/ready 之后）、或转接发起时已连着，
       * 后台推给该窗口的侧边栏；侧边栏用它带 handoffId 订阅
       */
      type: 'handoff/pending';
      handoffId: string;
      tabId: number;
      conversationId?: string;
    }
  | {
      /**
       * 历史查询的结果，按 updatedAt 降序；一次查询可能分几条（每条不超过 64 KB），done 为真是最后一条。
       * contract-v1.4 增量 nextBefore：还有更早的，下一页把它作为 history/query 的 before；没有就是到底了
       */
      type: 'history/page';
      queryId: string;
      items: readonly ConversationRecord[];
      done: boolean;
      nextBefore?: number;
    }
  /** contract-v1.4 增量：history/delete 成功（事务已提交） */
  | { type: 'history/deleted'; requestId: string; conversationId: string }
  /**
   * contract-v1.4 增量：任务的终态没能写进数据库（重试一次仍失败）。回答照常显示，但不在历史里、
   * 后台重启后接着问不会带上这一轮；界面据此提示，不把「写入失败」当成「已存」（5.11 写入确认）
   */
  | { type: 'conv/saveFailed'; jobId: string; messageId: string }
  | { type: 'favorite/saved'; favoriteId: string; messageId: string }
  /** contract-v1.5 增量：favorite/update / favorite/remove 成功（事务已提交） */
  | { type: 'favorite/updated'; requestId: string; favoriteId: string }
  | { type: 'favorite/removed'; requestId: string; favoriteId: string }
  | {
      /**
       * 跳回原文的结果。fuzzy / scroll 是降级（原文可能已变化，这是最接近的位置）；none 时 reason 说明原因。
       * contract-v1.5 增量 reason、back（阅读器记下了跳转前的位置，可以回去）
       */
      type: 'citation/located';
      requestId: string;
      level: 'exact' | 'fuzzy' | 'scroll' | 'none';
      reason?: CitationFailReason;
      back?: boolean;
    }
  | {
      /**
       * contract-v1.6 增量：jump/open 的结果（决策 098）。ok 为真：已到那一页的标签页 tabId（existing 切过去的、new 新开的）；
       * 收藏回原文时再带定位结果 level / reason / back（同 citation/located；没有锚点回 reason: noAnchor，
       * 站点不读取回 siteBlocked，只打开页面）。ok 为假：reason 说明没到（页面地址变了回 redirected 等）
       */
      type: 'jump/result';
      requestId: string;
      ok: boolean;
      tabId?: number;
      opened?: 'existing' | 'new';
      level?: 'exact' | 'fuzzy' | 'scroll' | 'none';
      reason?: CitationFailReason;
      back?: boolean;
    }
  | {
      /**
       * contract-v1.5 增量：一页的上次总结（应答 summary/get 时带 requestId；后台复用上次总结、不重新请求时主动推给该标签页，
       * 不带 requestId、show 为真）。summary 不在表示这一页没有可用的上次总结。
       * current：总结所基于的内容版本与页面现在的比较——same 一致；changed 不一致（界面标「基于旧版本」）；unknown 没能核对
       * （读不了页面、站点设为不读取）。show：用户刚点了「总结本页」而后台直接复用了它，界面要把它摆到眼前
       */
      type: 'summary/last';
      requestId?: string;
      tabId: number;
      summary?: LastSummary;
      show?: boolean;
    }
  /**
   * contract-v1.5 增量（live）：这个标签页的正文在小窗/侧边栏开着期间发生了实质变化（或 SPA 换了路由），
   * 转发自阅读器的 page/changed（5.1、5.6）。只是一个提示信号，不带内容；界面显示一行，之后再问会用新内容
   */
  | { type: 'conv/pageChanged' }
  | {
      type: 'conv/rejected';
      reason: RejectReason;
      refType?: string;
      /** 被拒消息里的关联编号（clientRequestId、jobId、queryId 等），界面据此把对应操作标为失败 */
      refId?: string;
    }
  | {
      /**
       * contract-v1.5 增量：这个标签页有一张待确认的截图（5.13 预览）。推给该标签页的所有订阅者，订阅时也补发。
       * 原图只在后台（发问时才进请求），这里只给缩略图：JPEG data URL，后台保证不超过 CAPTURE_THUMB_MAX_CHARS，
       * 整条消息远小于 64 KB。width / height 是发给模型的那张图的尺寸
       */
      type: 'conv/capture';
      captureId: string;
      thumb: string;
      width: number;
      height: number;
      /** contract-v1.6 增量：外部图片（输入框粘贴，决策 099）：没有页面位置，预览旁要提示；框选截图没有这个字段 */
      external?: true;
    }
  /** contract-v1.5 增量：待确认的截图没了（已随发问取走、被 × 去掉、被新截图替换、过期） */
  | { type: 'conv/captureCleared'; captureId: string }
  /** contract-v1.5 增量：截图没成功。changed：截图前页面变了已丢弃，请重选；unsupported：这一页截不了；failed：其他 */
  | { type: 'conv/captureFailed'; reason: CaptureFailReason }
  /** contract-v1.5 增量：image/get 的应答。thumb 同 conv/capture */
  | { type: 'image/thumb'; requestId: string; messageId: string; index: number; thumb: string };

/**
 * contract-v1.6 增量：tooLarge 粘贴的图片超过 MAX_PASTE_BYTES；badImage 粘贴的内容不是（或损坏的）可用图片
 */
export type CaptureFailReason = 'changed' | 'unsupported' | 'failed' | 'tooLarge' | 'badImage';
/** 缩略图 data URL 的长度上限（字符）：conv/capture、image/thumb 单条都远小于 64 KB */
export const CAPTURE_THUMB_MAX_CHARS = 44 * 1024;

/**
 * 侧边栏顶部说明的原因（contract-v1.3 增量）。「加载失败」与「网站不支持」分开，不把前者说成后者（V-02）
 * | floatTransient | 小窗这次没加载出来（超时等偶发失败），这次改用侧边栏 |
 * | floatUnsupported | 网站结构性不能放小窗（按站点记住） |
 * | noConnection | 后台替侧边栏发起的请求（右键「总结本页」）没有可用的连接 |
 * | requestRefused | 后台替侧边栏发起的请求被拒（其余原因） |
 * | captureUnsupported | contract-v1.5 增量：快捷键截图，这一页截不了（浏览器内部页面等，阅读器注入不了） |
 */
export type PanelNoticeKind =
  | 'floatTransient'
  | 'floatUnsupported'
  | 'noConnection'
  | 'requestRefused'
  | 'captureUnsupported';

/**
 * 跳回原文失败的原因（contract-v1.5 增量）
 * | notCited | 这条消息没有这个编号的引用，或编号不在那次请求发送的块里（规则 9） |
 * | otherPage | 这条回答引用的是别的页面，所订阅标签页现在不是那一页 |
 * | expired | 快照已过期（7 天）且没有逐字原文可找 |
 * | notFound | 页面里找不到这段原文（页面已大改） |
 * | siteBlocked | 站点设为「不读取页面内容」 |
 * | unavailable | 页面不允许注入（浏览器内部页面等）或阅读器没有应答 |
 * | subframe | 这段在内嵌页面（iframe）里，本版本只读取、不能在网页上定位（D10） |
 * contract-v1.6 增量（跳回原页面，决策 098）：
 * | noRecord | 库里没有这一页或这条收藏的记录（已被删除） |
 * | badUrl | 记录里的地址不是 http / https / file，不打开 |
 * | loadTimeout | 页面加载超时，没有定位 |
 * | redirected | 页面打开后跳转到了别处（地址对不上记录），没有定位 |
 * | openFailed | 标签页没能打开，或加载中途被关掉 |
 * | noAnchor | 这条收藏没有记下原文位置，只打开了页面 |
 */
export type CitationFailReason =
  | 'notCited'
  | 'otherPage'
  | 'expired'
  | 'notFound'
  | 'siteBlocked'
  | 'unavailable'
  | 'subframe'
  | 'noRecord'
  | 'badUrl'
  | 'loadTimeout'
  | 'redirected'
  | 'openFailed'
  | 'noAnchor';

/** 上次总结（summary/last）：消息记录里去掉了思考过程，正文过长时截断 */
export interface LastSummary {
  message: MessageRecord;
  /** 总结所基于的内容版本 */
  contentVersion: string;
  current: 'same' | 'changed' | 'unknown';
}

/**
 * 后台 → 扩展页面的广播（runtime.sendMessage，contract-v1.3 增量）。后台自己产出，只用类型约束；
 * 接收方核对 sender.id 是本扩展且不在标签页里。
 * sidepanel/toggle：开关快捷键（5.4）。后台在命令处理里同步 open() 之后发出；at 是命令到达的时间，
 * 该窗口里在这之前就已存在的面板自行 window.close()（这次 open 新开的面板晚于 at，不受影响）。
 * sidepanel/wake：有东西要交给这个窗口的侧边栏（转接、改走侧边栏、总结本页）。面板若因后台被回收断了线、
 * 正闲着没重连（不主动唤醒后台，5.4），收到后立即重连并重新订阅
 */
export type BackgroundToPages =
  | { type: 'sidepanel/toggle'; windowId: number; at: number }
  | { type: 'sidepanel/wake'; windowId: number }
  /** contract-v1.5 增量：收藏新增/编辑/删除后广播给所有扩展页面，已打开的收藏视图据此重新只读查询（5.4） */
  | { type: 'favorite/changed' };

// ───────────── 设置页 / 欢迎页 → 后台（runtime.sendMessage，一问一答） ─────────────

export const optionsToBackground = tagged({
  /** 写 Key 之前确认 storage.local 已收紧为仅扩展自身（5.11、AR-18）；应答 { locked: boolean } */
  'settings/ensureLocked': obj({ type: lit('settings/ensureLocked') }),
  /**
   * 测试已保存的连接：用所选模型发一条最小对话（5.8「先选定或手填一个模型」）。请求由后台发出（规则 1），
   * Key 由后台从设置里读，不经消息。应答 ConnectionTestResult
   */
  'connection/test': obj({
    type: lit('connection/test'),
    connectionId: id,
    model: str({ min: 1, max: 200 }),
  }),
  /** 拉取模型列表；失败不否定已成功的对话测试，界面允许手填。应答 ListModelsResult */
  'connection/listModels': obj({ type: lit('connection/listModels'), connectionId: id }),
  /**
   * contract-v1.5 增量：欢迎页「快速上手」的示例文章上点了工具栏的「问」或「解释」（L3、决策 038）。
   * 内容脚本进不了扩展自己的页面，欢迎页自己装配工具栏，把选中的示例文字交给后台，在侧边栏里回答
   * （侧边栏由欢迎页在点击的同步段里自己打开）。后台只做与右键「问」相同的事：按 sender.tab 存下选区、
   * 推给该标签页的订阅者；「解释」再按默认模型起一个任务。
   * 授权：只认 sender 是本扩展 welcome.html 且在标签页顶层框架里的（设置页发来也拒绝）；选区只记在发送者
   * 自己的标签页名下。消息里没有地址、Key、标签页编号；内容脚本的角色发不了这条消息。应答 DemoAskResult
   */
  'demo/ask': obj({
    type: lit('demo/ask'),
    actionId: oneOf(['ask', 'explain']),
    selectionRevision: int({ min: 0 }),
    text: selectionText,
    truncated: bool,
    originalLength: int({ min: 0 }),
  }),
});
export type OptionsToBackground = Infer<typeof optionsToBackground>;

export interface EnsureLockedResult {
  locked: boolean;
}
/**
 * suggestedBaseUrl：返回网页（htmlInsteadOfJson）时，后台补上 /v1 再探测一次模型列表，
 * 探测成功就给出改正后的地址，界面提供「改成这个地址并重测」（5.8 响应校验链）
 */
export type ConnectionTestResult =
  | { ok: true; model: string; reply: string; elapsedMs: number; reasoning: boolean }
  | { ok: false; error: ModelError; elapsedMs: number; suggestedBaseUrl?: string };
export type ListModelsResult =
  | { ok: true; models: readonly string[] }
  | { ok: false; error: ModelError; suggestedBaseUrl?: string };
/** contract-v1.5 增量：demo/ask 的应答。noModel：还没有默认模型，「解释」没有发出（选区照样存下） */
export type DemoAskResult = { ok: true; started: boolean } | { ok: false; reason: RejectReason | 'noModel' };

// ───────────── 小窗私有端口：小窗 ↔ 阅读器（FLOAT_PORT） ─────────────

/**
 * 小窗 → 阅读器。实时拖动 / 缩放不走这个端口——V-12 实测发现 iframe 内指针捕获一旦移出 iframe
 * 渲染区域（缩放拖出、大幅拖动都会立刻发生）就收不到 pointermove，这是 pointer capture 跨
 * iframe 边界的已知限制（不是实现 bug），按 5.3 原文的退路改成宿主侧不可见把手直接处理（见
 * page/float-host.ts）。这里只保留连接时的一次性恢复（按 settings.float 回放记忆的尺寸/位置）
 * 与 Esc 收起。
 */
export const floatToReader = tagged({
  'float/resize': obj({
    type: lit('float/resize'),
    w: num({ min: FLOAT_LIMITS.minWidth }),
    h: num({ min: FLOAT_LIMITS.minHeight }),
  }),
  /** 恢复记忆位置（settings.float.placement === 'remembered'）：绝对坐标，仅连接后用一次 */
  'float/reposition': obj({ type: lit('float/reposition'), x: num(), y: num() }),
  'float/collapse': obj({ type: lit('float/collapse') }),
  'anchor/jump': obj({ type: lit('anchor/jump'), anchor: anchorSchema }),
  'anchor/back': obj({ type: lit('anchor/back') }),
  /**
   * contract-v1.4 增量：图钉（B3、B5）。pinned 为真时点网页别处不收起小窗，再点「问」也留在原处只换引用；
   * Esc 与 × 照常收起。小窗连上私有端口后先发一次当前状态（默认取 settings.float.closeMode），之后每点一次图钉再发
   */
  'float/pin': obj({ type: lit('float/pin'), pinned: bool }),
});
export type FloatToReader = Infer<typeof floatToReader>;

/**
 * 阅读器 → 小窗（同一个 FLOAT_PORT，反方向）。阅读器自己产出，不做运行时校验，只用类型约束
 * （与 BackgroundToClient 同例）：连接建立、以及 float/resize、float/reposition 生效后各回发一次
 * （`settled: false`，小窗只更新本地记忆，不落盘）；宿主侧把手完成一次拖动/缩放手势（pointerup）
 * 后也回发一次（`settled: true`），小窗据此把最终位置尺寸落盘到 settings.float.rect——写入必须
 * 由小窗（扩展页面，可信上下文）做，阅读器所在的内容脚本收紧后读不到也写不了 storage.local（5.11）。
 */
export type ReaderToFloat = {
  type: 'float/rect';
  x: number;
  y: number;
  w: number;
  h: number;
  settled: boolean;
};

// ───────────── 角色与授权（5.12） ─────────────

/**
 * 后台从 sender 推出的角色；推不出就是 unknown，一律拒绝。
 * | 角色 | 判定 |
 * | content | sender.id 是本扩展，sender.url 不是扩展页面，带 tab 与 frameId |
 * | float | sender.url 是扩展的 float.html，且在某个标签页里（sender.tab） |
 * | sidepanel | sender.url 是扩展的 sidepanel.html，不在标签页里 |
 * | options | sender.url 是扩展的 options.html 或 welcome.html |
 */
export type SenderRole = 'content' | 'float' | 'sidepanel' | 'options' | 'unknown';

type ClientType = ClientToBackground['type'];
/**
 * contract-v1.5 增量：favorite/add、favorite/update、favorite/remove 放进共用表——小窗和侧边栏的回答旁边
 * 都有「存」按钮（G3），不只是侧边栏
 */
const CONV_COMMON: readonly ClientType[] = [
  'conv/subscribe',
  'conv/ask',
  'conv/stop',
  'conv/retry',
  'conv/setTier',
  'conv/setModel',
  'favorite/add',
  'favorite/update',
  'favorite/remove',
];

const ROLE_ALLOWED: Readonly<Record<SenderRole, ReadonlySet<string>>> = {
  content: new Set(Object.keys(contentToBackground.variants)),
  float: new Set<ClientType>([
    ...CONV_COMMON,
    'conv/helloFloat',
    'conv/resumeFloat',
    'handoff/start',
    // contract-v1.5 增量
    'citation/locate',
    'citation/back',
    'summary/get',
    'capture/begin',
    'capture/discard',
    'image/get',
    // contract-v1.6 增量
    'paste/begin',
    'paste/chunk',
  ]),
  sidepanel: new Set<ClientType>([
    ...CONV_COMMON,
    'conv/helloSidepanel',
    'history/query',
    'citation/locate',
    'history/delete',
    // contract-v1.5 增量
    'citation/back',
    'summary/get',
    'capture/begin',
    'capture/discard',
    'image/get',
    // contract-v1.6 增量
    'paste/begin',
    'paste/chunk',
    // contract-v1.6 增量：只有侧边栏能让后台开标签页（决策 098）
    'jump/open',
  ]),
  // contract-v1.5：欢迎页没有另开角色，仍是 options。其中 demo/ask 只有 welcome.html 所在标签页能发，
  // 这一层由处理函数按 sender 再核对（background/welcome-demo.ts），设置页发来也拒绝
  options: new Set(Object.keys(optionsToBackground.variants)),
  unknown: new Set(),
};

/**
 * busy（contract-v1.3 增量）：同一对话正有回答在生成（决策 062）。两个界面几乎同时向同一对话发问时，
 * 后到的那一条收到它（V-03），界面据此提示「回答进行中」，而不是笼统的「消息格式不对」。
 * gone（contract-v1.3 增量）：要转到侧边栏的对话后台已经没有了。contract-v1.4 起对话在数据库里，
 *   后台重启不再丢对话；只有对话已被删除（库里没有）时才回它。
 * storageFailed（contract-v1.4 增量）：数据库写入或读取失败（接单要先落库，落不了就不发请求）
 * modelGone（contract-v1.5 增量）：conv/ask 里 model 指向的连接已不存在（被删了）。后台不再静默
 *   退回默认模型（V-07）；界面据此提示并自己切回设置里的默认模型
 * noVision（contract-v1.5 增量）：发问附了截图，但所选模型能力表里 vision 为 no（E3），界面提示换能看图的模型
 */
export type RejectReason =
  | 'tooLarge'
  | 'invalid'
  | 'notAllowed'
  | 'notHandshaken'
  | 'badToken'
  | 'notOwner'
  | 'busy'
  | 'gone'
  | 'storageFailed'
  | 'modelGone'
  | 'noVision';

/** JSON 序列化后的 UTF-8 字节数；序列化失败（循环引用、BigInt）返回 Infinity */
export function messageBytes(msg: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(msg) ?? '').length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 后台入口统一用它：先限长，再查角色授权（只看 type），最后按通道校验形状。
 * detail 只含字段路径与原因，不回显消息内容。
 * 会话归属、令牌、握手状态由调用方在此之后检查（需要运行时状态）。
 */
export function parseFrom<T extends { type: string }>(
  role: SenderRole,
  schema: { parse: (v: unknown) => Result<T> },
  raw: unknown,
): { ok: true; msg: T } | { ok: false; reason: RejectReason; detail?: string } {
  if (messageBytes(raw) > JOB_LIMITS.maxMessageBytes) return { ok: false, reason: 'tooLarge' };
  const type = typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
  if (typeof type !== 'string') return { ok: false, reason: 'invalid', detail: '$.type: 缺失' };
  if (!ROLE_ALLOWED[role].has(type)) return { ok: false, reason: 'notAllowed' };
  const r = schema.parse(raw);
  if (!r.ok) return { ok: false, reason: 'invalid', detail: r.error };
  return { ok: true, msg: r.value };
}
