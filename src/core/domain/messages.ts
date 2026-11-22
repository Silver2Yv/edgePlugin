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
import { BLOCK_KINDS, PAGE_NOTE_KINDS } from '../context/page-doc';
import type { RequestContextPlan } from '../context/plan';
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
  /** 定位与高亮结果（应答 page/locate） */
  'page/locateResult': obj({
    type: lit('page/locateResult'),
    requestId: id,
    level: oneOf(['exact', 'fuzzy', 'scroll', 'none']),
  }),
  /** 框选完成：视口坐标（CSS 像素）与视口修订号 */
  'capture/rect': obj({
    type: lit('capture/rect'),
    captureId: id,
    viewportRevision: int({ min: 0 }),
    rect: obj({ x: num(), y: num(), w: num({ min: 1 }), h: num({ min: 1 }) }),
  }),
  'float/loadResult': obj({
    type: lit('float/loadResult'),
    result: oneOf(['ready', 'failedUnsupported', 'failedTransient']),
  }),
});
export type ContentToBackground = Infer<typeof contentToBackground>;

/** 页面侧配置（config/get 的应答）。不含 Key、连接地址、历史 */
export interface PageConfig {
  siteLevel: SiteLevel;
  /** contract-v1.4 增量：补上 kind/needsInput/scope——工具栏据此决定点击后是等输入、直接发送、还是不发请求（A2/A3/A6） */
  toolbarActions: readonly ActionSummary[];
  /** 这次提问去小窗还是侧边栏（B7） */
  askRoute: AskRoute;
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
  'page/locate': obj({ type: lit('page/locate'), requestId: id, anchor: anchorSchema, highlight: bool }),
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
  'page/notice': obj({ type: lit('page/notice'), kind: oneOf(['floatFailed', 'floatUnsupported']) }),
  'capture/start': obj({ type: lit('capture/start'), captureId: id }),
  'capture/hideOverlay': obj({ type: lit('capture/hideOverlay'), captureId: id }),
});
export type BackgroundToContent = Infer<typeof backgroundToContent>;

// ───────────── 对话流：小窗 / 侧边栏 → 后台（端口 CONV_PORT） ─────────────

const thinking = oneOf(['off', 'low', 'medium', 'high']);

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
  /** 仅侧边栏：点引用跳回原文。后台按消息里的引用与快照算锚点，再发 page/locate（规则 9） */
  'citation/locate': obj({
    type: lit('citation/locate'),
    requestId: id,
    messageId: id,
    segmentIndex: int({ min: 0, max: 10_000 }),
  }),
  /**
   * contract-v1.4 增量，仅侧边栏：删除一个对话，连同它的消息与无人引用的快照（5.11 级联）。
   * 成功回 history/deleted；对话正有回答在生成时拒绝（busy），写库失败拒绝（storageFailed）
   */
  'history/delete': obj({ type: lit('history/delete'), requestId: id, conversationId: id }),
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
  | { type: 'favorite/saved'; favoriteId: string }
  | { type: 'citation/located'; requestId: string; level: 'exact' | 'fuzzy' | 'scroll' | 'none' }
  | {
      type: 'conv/rejected';
      reason: RejectReason;
      refType?: string;
      /** 被拒消息里的关联编号（clientRequestId、jobId、queryId 等），界面据此把对应操作标为失败 */
      refId?: string;
    };

/**
 * 侧边栏顶部说明的原因（contract-v1.3 增量）。「加载失败」与「网站不支持」分开，不把前者说成后者（V-02）
 * | floatTransient | 小窗这次没加载出来（超时等偶发失败），这次改用侧边栏 |
 * | floatUnsupported | 网站结构性不能放小窗（按站点记住） |
 * | noConnection | 后台替侧边栏发起的请求（右键「总结本页」）没有可用的连接 |
 * | requestRefused | 后台替侧边栏发起的请求被拒（其余原因） |
 */
export type PanelNoticeKind = 'floatTransient' | 'floatUnsupported' | 'noConnection' | 'requestRefused';

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
  | { type: 'sidepanel/wake'; windowId: number };

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
const CONV_COMMON: readonly ClientType[] = [
  'conv/subscribe',
  'conv/ask',
  'conv/stop',
  'conv/retry',
  'conv/setTier',
  'conv/setModel',
];

const ROLE_ALLOWED: Readonly<Record<SenderRole, ReadonlySet<string>>> = {
  content: new Set(Object.keys(contentToBackground.variants)),
  float: new Set<ClientType>([...CONV_COMMON, 'conv/helloFloat', 'conv/resumeFloat', 'handoff/start']),
  sidepanel: new Set<ClientType>([
    ...CONV_COMMON,
    'conv/helloSidepanel',
    'history/query',
    'favorite/add',
    'citation/locate',
    'history/delete',
  ]),
  options: new Set(Object.keys(optionsToBackground.variants)),
  unknown: new Set(),
};

/**
 * busy（contract-v1.3 增量）：同一对话正有回答在生成（决策 062）。两个界面几乎同时向同一对话发问时，
 * 后到的那一条收到它（V-03），界面据此提示「回答进行中」，而不是笼统的「消息格式不对」。
 * gone（contract-v1.3 增量）：要转到侧边栏的对话后台已经没有了。contract-v1.4 起对话在数据库里，
 *   后台重启不再丢对话；只有对话已被删除（库里没有）时才回它。
 * storageFailed（contract-v1.4 增量）：数据库写入或读取失败（接单要先落库，落不了就不发请求）
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
  | 'storageFailed';

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
