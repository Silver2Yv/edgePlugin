// 后台各模块的依赖（扩展接口、网络、时间、随机数）。真实实现在 browser-deps.ts，
// 其余模块只依赖这里的接口，单测换成假的。

import type { BackgroundToContent, BackgroundToPages } from '@/core/domain/messages';
import type { MigrateResult } from '@/core/domain/settings';
import type { InterfaceType, ModelAdapter } from '@/core/llm/adapter';
import type { ConvDb } from '@/platform/conv-db';
import type { NetDiagnostics } from './net-diagnostics';

/** 只用到的 sender 字段；与 runtime.MessageSender 兼容 */
export interface SenderLike {
  id?: string | undefined;
  url?: string | undefined;
  origin?: string | undefined;
  tab?: { id?: number | undefined; windowId?: number | undefined } | undefined;
  frameId?: number | undefined;
  documentId?: string | undefined;
  documentLifecycle?: string | undefined;
}

/** runtime.Port 里用到的部分 */
export interface ConvPort {
  readonly name: string;
  readonly sender?: SenderLike;
  postMessage(msg: unknown): void;
  disconnect(): void;
  readonly onMessage: { addListener(cb: (msg: unknown) => void): void };
  readonly onDisconnect: { addListener(cb: () => void): void };
}

/** storage.session 里用到的部分 */
export interface SessionArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface SelfInfo {
  runtimeId: string;
  /** 扩展页面的协议（runtime.getURL 的协议），如 chrome-extension: */
  protocol: string;
}

export interface BackgroundDeps {
  self: SelfInfo;
  session: SessionArea;
  loadSettings(): Promise<MigrateResult>;
  /** 确保顶层框架注入了阅读器（同一文档只注入一次），返回顶层文档的 documentId */
  injectReader(tabId: number): Promise<string>;
  /**
   * 标签页当前的顶层地址（tabs.get；有主机权限才看得到）。站点策略按它判定：子框架取「顶层与框架来源」更严，
   * 发问前决定读不读页面（4.1）。取不到返回 undefined。可选只是为了不打扰只测别的模块的单测，真实实现一定提供
   */
  getTabUrl?(tabId: number): Promise<string | undefined>;
  /**
   * 打开指定窗口的侧边栏（sidePanel.open）。必须在用户手势的同步路径上调用，之前不得 await（规则 10）：
   * 调用方在事件处理的同步段里直接调它，再处理返回的 Promise。没有手势时 Promise 被拒
   */
  openSidePanel(windowId: number): Promise<void>;
  /** 标签页所在窗口（tabs.get）；标签页不在了返回 undefined */
  tabWindow(tabId: number): Promise<number | undefined>;
  /** 窗口是否存在（windows.get） */
  windowExists(windowId: number): Promise<boolean>;
  /**
   * 按 documentId 反查侧边栏所在窗口（runtime.getContexts，5.4、5.12）。反查不了返回 undefined——
   * Chrome 159 / Edge 157 实测侧边栏的 windowId 是 -1，端口 sender 也不带 documentId（V-11）
   */
  panelWindowOf(documentId: string): Promise<number | undefined>;
  /**
   * 现在有没有任何侧边栏开着（runtime.getContexts）。只能看「有没有」：给全局侧边栏的窗口号是 -1，分不出是哪个窗口的
   */
  sidePanelOpen(): Promise<boolean>;
  /** 叫醒断线的侧边栏后等它握手的上限（默认 1.5 秒）；可选只是为了单测缩短 */
  panelWakeMs?: number;
  /** 广播给扩展页面（runtime.sendMessage）；没有页面在收时不算失败 */
  notifyPages(msg: BackgroundToPages): Promise<void>;
  /** 指令只发给指定框架的指定文档；文档已不在时失败 */
  sendToFrame(tabId: number, frameId: number, documentId: string, msg: BackgroundToContent): Promise<void>;
  /**
   * contract-v1.5 增量（live）：指令广播给这个标签页的所有框架（不指定 frameId/documentId），
   * 每个框架的哨兵各自收到。标签页没有内容脚本在听时不算失败
   */
  broadcastToTab(tabId: number, msg: BackgroundToContent): Promise<void>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  adapters: Partial<Record<InterfaceType, ModelAdapter>>;
  now(): number;
  /** 编号（满足 ID_PATTERN） */
  newId(): string;
  /** 握手令牌：128 位随机，32 个十六进制字符 */
  newToken(): string;
  /** 本地诊断日志：只记事件与字段名、原因，不记内容、令牌、Key */
  log(event: string, detail?: Record<string, unknown>): void;
  /** 收紧 storage.local 访问级别为仅扩展自身（5.11、AR-18）；失败抛错，不当作安全保证 */
  lockStorage(): Promise<void>;
  /** 测试连接的总超时（毫秒），默认 30 秒；单测用它调小，不必真的等 30 秒 */
  connectionTestTimeoutMs?: number;
  /** 拉取模型列表（含 /v1 探测）的超时（毫秒），默认 15 秒 */
  listModelsTimeoutMs?: number;
  /** 发问等待响应头的超时（毫秒），默认见 JOB_LIMITS.connectTimeoutMs；单测用它调小（V-01） */
  askConnectTimeoutMs?: number;
  /** 对话数据库（5.11）：后台是唯一写入者。真实实现是 IndexedDB（platform/conv-db.ts），单测换成内存实现 */
  db: ConvDb;
  /** 只读网络诊断（H9）：webRequest 能力不可用（如单测）时不提供，调用方按 undefined 处理 */
  netDiagnostics?: NetDiagnostics;
  /**
   * 往指定标签页顶层框架的指定文档注入样式（scripting.insertCSS，cite 块）：引用高亮的 ::highlight 样式（5.7）。
   * 可选只是为了不打扰只测别的模块的单测，真实实现一定提供
   */
  insertCss?(tabId: number, documentId: string, css: string): Promise<void>;
}
