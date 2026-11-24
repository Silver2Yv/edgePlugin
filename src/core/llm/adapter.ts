// 模型网关契约（5.8、5.14）。适配器是纯逻辑：把请求变成 fetch 参数、把字节流变成事件；
// 真正的 fetch 由后台执行，所以适配器不碰网络与扩展 API。
import type { ThinkingLevel } from '../context/plan';
import type { ConnectionId } from '../domain/ids';

export type InterfaceType = 'chatCompletions' | 'responses' | 'anthropic' | 'gemini';

export interface Connection {
  id: ConnectionId;
  name: string;
  /** 预设名（如 deepseek、公司中转站）；custom 表示手填 */
  preset: string;
  /** 基础地址（以 /v1 结尾）或完整接口地址 */
  baseUrl: string;
  /** 只在设置存储里；任何导出、日志、诊断都脱敏 */
  apiKey: string;
  headers: Readonly<Record<string, string>>;
  interfaceType: InterfaceType;
  /** 逐字输出开关（流式） */
  stream: boolean;
  /** 额外请求参数（JSON 对象）；受保护字段被忽略 */
  extraParams: Readonly<Record<string, unknown>>;
  /** 配置版本：改动任何影响请求的字段就加一，能力学习按它失效 */
  configVersion: number;
  /** 按模型手动覆盖能力表（H11）；键为模型标识，值只需写要覆盖的字段，没写的字段仍按内置默认显示 */
  capabilityOverrides?: Readonly<Record<string, Partial<Omit<ModelCapabilities, 'quirks'>>>>;
  /** 用户勾选的常用模型（H5 下拉框下一轮接） */
  models?: readonly string[];
}

/** 界面显示的名称就是实际发送的标识（J10） */
export interface ModelRef {
  connectionId: ConnectionId;
  model: string;
}

export type Tri = 'yes' | 'no' | 'unknown';

/** 能力表：未知就显示未知，不默认成「已关闭 / 已支持」 */
export interface ModelCapabilities {
  thinking: 'none' | 'toggle' | 'effort' | 'unknown';
  /**
   * 「可调强度」模型实际支持的思考档位（含是否有「关」），决策 100 / contract-v1.6 增量；
   * 没写按 DEFAULT_THINKING_LEVELS（关/低/中/高）。只在 thinking 为 effort 时有意义
   */
  thinkingLevels?: readonly ThinkingLevel[];
  vision: Tri;
  contextWindow?: number;
  /** 学到的怪癖，如某参数被拒 */
  quirks: readonly string[];
}

/** 能力学习的绑定键（AR-09） */
export const capabilityKey = (c: Pick<Connection, 'id' | 'interfaceType' | 'configVersion'>, model: string) =>
  `${c.id}|${c.interfaceType}|${model}|${c.configVersion}`;

/** 参数分类（AR-09）：受保护字段由适配器决定，extraParams 里同名的被忽略。按接口类型分，各家字段名不同 */
export const PROTECTED_PARAMS: Readonly<Record<InterfaceType, readonly string[]>> = {
  chatCompletions: ['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice'],
  responses: ['model', 'input', 'instructions', 'stream', 'tools', 'tool_choice', 'previous_response_id'],
  anthropic: ['model', 'messages', 'system', 'stream', 'tools', 'tool_choice'],
  gemini: ['contents', 'systemInstruction', 'tools', 'toolConfig'],
};
export const SEMANTIC_PARAMS: readonly string[] = [
  'thinking',
  'reasoning_effort',
  'enable_search',
  'web_search',
];

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatPart = { kind: 'text'; text: string } | { kind: 'image'; dataUrl: string };
export interface ChatMessage {
  role: ChatRole;
  content: readonly ChatPart[];
}

export interface ChatRequest {
  model: string;
  messages: readonly ChatMessage[];
  stream: boolean;
  maxTokens?: number;
  /** 不填就不发思考相关字段；辅助任务（问题建议）必须显式关思考 */
  thinking?: 'off' | 'on' | { effort: 'low' | 'medium' | 'high' | 'max' };
  signal?: AbortSignal;
}

/**
 * 交给后台 fetch 的参数。`redirect` 固定为 manual（D-05）：
 * 跨源重定向只去掉 Authorization，不去掉自定义请求头，所以重定向一律视为错误。
 * manual 下拿不到重定向目标（opaqueredirect），诊断用的目标地址由后台从 webRequest.onBeforeRedirect 取。
 */
export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Readonly<Record<string, string>>;
  body?: string;
  redirect: 'manual';
}

export const MODEL_FETCH_REDIRECT = 'manual' as const;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export type FinishReason = 'stop' | 'length' | 'contentFilter' | 'other';

export type StreamEvent =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'finish'; reason: FinishReason; rawReason?: string }
  | { kind: 'error'; error: ModelError };

/** 错误分类（H9）；界面动作按 kind 决定 */
export type ModelErrorKind =
  | 'htmlInsteadOfJson'
  | 'auth'
  | 'notFound'
  | 'paramRejected'
  | 'redirected'
  | 'network'
  | 'streamBroken'
  | 'server'
  | 'rateLimited'
  | 'badResponse'
  /** 连接或首字超时 */
  | 'timeout'
  /** 正常结束但没有任何正文（只有思考或什么都没有） */
  | 'noContent'
  /** 服务端明确报上下文超长；界面建议降档 */
  | 'contextOverflow'
  | 'aborted';

export interface ModelError {
  kind: ModelErrorKind;
  status?: number;
  /** 服务端原始报错，已脱敏、限长 */
  serverMessage?: string;
  /** 浏览器网络错误码，取自 webRequest.onErrorOccurred，如 net::ERR_NAME_NOT_RESOLVED */
  netError?: string;
  /** 400 时可疑的参数名，用于自动去掉重试一次 */
  suspectParam?: string;
}

export interface HttpResponseHead {
  status: number;
  contentType: string;
  /** 正文开头若干字节的文本（用于识别 HTML） */
  bodyHead: string;
}

/** 增量流解析器：容忍任意换行、注释行、流中错误对象、事件跨网络块（H7） */
export interface StreamParser {
  push(chunk: string): StreamEvent[];
  end(): StreamEvent[];
}

export interface ModelAdapter {
  readonly interfaceType: InterfaceType;
  /** excludeParams：参数被拒自动重试、怪癖学习都用它去掉指定的顶层字段（H7、AR-09） */
  buildChat(conn: Connection, req: ChatRequest, opts?: { excludeParams?: readonly string[] }): HttpRequest;
  buildListModels(conn: Connection): HttpRequest;
  /** 先看内容类型与正文开头；200 不等于成功 */
  classifyHead(head: HttpResponseHead): ModelError | undefined;
  createStreamParser(): StreamParser;
  /** 服务端忽略流式时按整段处理 */
  parseWhole(body: string): StreamEvent[];
  parseModelList(body: string): string[];
}
