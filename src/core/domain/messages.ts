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
import { BLOCK_KINDS } from '../context/page-doc';
import type { RequestContextPlan } from '../context/plan';
import type { ModelErrorKind } from '../llm/adapter';
import { BUILTIN_ACTION_IDS } from './actions';
import type { AskRoute } from './float';
import { TOKEN_PATTERN } from './float';
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
  /** 阅读器给选区补上锚点与所在块（选区就绪后异步算出） */
  'selection/anchored': obj({
    type: lit('selection/anchored'),
    selectionRevision: int({ min: 0 }),
    anchor: anchorSchema,
    blockIds: arr(blockId, { max: 200 }),
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
  toolbarActions: readonly { id: string; label: string }[];
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
      kind: oneOf(['visibilityUncertain', 'fallbackBodyText', 'tooLittleText', 'frameSkipped']),
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
  'capture/start': obj({ type: lit('capture/start'), captureId: id }),
  'capture/hideOverlay': obj({ type: lit('capture/hideOverlay'), captureId: id }),
});
export type BackgroundToContent = Infer<typeof backgroundToContent>;

// ───────────── 对话流：小窗 / 侧边栏 → 后台（端口 CONV_PORT） ─────────────

const thinking = oneOf(['off', 'low', 'medium', 'high']);

const askBody = {
  clientRequestId: id,
  /** 不填表示新对话 */
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
   * 侧边栏：windowId 只作提示，后台用 runtime.getContexts 按 sender.documentId 反查真实窗口。
   * 不需要令牌，断线重连时再发一次即可
   */
  'conv/helloSidepanel': obj({ type: lit('conv/helloSidepanel'), windowId: opt(int({ min: 0 })) }),
  /** 订阅：小窗只能订阅令牌绑定标签页的对话；侧边栏只能订阅本窗口的标签页 */
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
  /** 小窗点「转到侧边栏」：后台生成 handoffId */
  'handoff/start': obj({ type: lit('handoff/start'), conversationId: id }),
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
});
export type ClientToBackground = Infer<typeof clientToBackground>;

/** 后台 → 小窗 / 侧边栏。后台自己产出，不做运行时校验，只用类型约束 */
export type BackgroundToClient =
  | { type: 'conv/ready'; role: 'float' | 'sidepanel'; protocolVersion: typeof PROTOCOL_VERSION }
  | {
      type: 'conv/snapshot';
      /** 新对话时为空 */
      conversation?: ConversationRecord;
      /** 按 ordinal 升序分批发送，每批不超过 64 KB；done 为真是最后一批 */
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
    }
  | { type: 'handoff/created'; handoffId: string }
  | { type: 'handoff/done'; handoffId: string }
  | { type: 'history/page'; queryId: string; items: readonly ConversationRecord[]; done: boolean }
  | { type: 'favorite/saved'; favoriteId: string }
  | { type: 'citation/located'; requestId: string; level: 'exact' | 'fuzzy' | 'scroll' | 'none' }
  | {
      type: 'conv/rejected';
      reason: RejectReason;
      refType?: string;
      /** 被拒消息里的关联编号（clientRequestId、jobId、queryId 等），界面据此把对应操作标为失败 */
      refId?: string;
    };

// ───────────── 设置页 / 欢迎页 → 后台（runtime.sendMessage，一问一答） ─────────────

export const optionsToBackground = tagged({
  /** 写 Key 之前确认 storage.local 已收紧为仅扩展自身（5.11、AR-18）；应答 { locked: boolean } */
  'settings/ensureLocked': obj({ type: lit('settings/ensureLocked') }),
  /** 测试已保存的连接；请求由后台发出（规则 1）。应答 { ok: true } 或脱敏后的 ModelError */
  'connection/test': obj({ type: lit('connection/test'), connectionId: id }),
  /** 拉取模型列表；应答 { models: string[] } 或 ModelError */
  'connection/listModels': obj({ type: lit('connection/listModels'), connectionId: id }),
});
export type OptionsToBackground = Infer<typeof optionsToBackground>;

// ───────────── 小窗私有端口：小窗 ↔ 阅读器（FLOAT_PORT） ─────────────

export const floatToReader = tagged({
  'float/move': obj({ type: lit('float/move'), dx: num(), dy: num() }),
  'float/resize': obj({ type: lit('float/resize'), w: num({ min: 200 }), h: num({ min: 160 }) }),
  'float/collapse': obj({ type: lit('float/collapse') }),
  'anchor/jump': obj({ type: lit('anchor/jump'), anchor: anchorSchema }),
  'anchor/back': obj({ type: lit('anchor/back') }),
});
export type FloatToReader = Infer<typeof floatToReader>;

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
  ]),
  options: new Set(Object.keys(optionsToBackground.variants)),
  unknown: new Set(),
};

export type RejectReason = 'tooLarge' | 'invalid' | 'notAllowed' | 'notHandshaken' | 'badToken' | 'notOwner';

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
