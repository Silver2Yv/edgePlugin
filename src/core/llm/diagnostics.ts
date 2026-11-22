// 诊断信息纯文本（H9、5.8「网络层诊断」）：设置页「一键复制」用（按钮下一轮接，这里只给生成函数）。
// Key、敏感请求头、URL 查询串统一脱敏；服务端原始报错已在 adapter 产出前脱敏限长，这里不重复处理。
import type { InterfaceType, ModelError } from './adapter';

const SENSITIVE_HEADER = /auth|key|token|secret|cookie/i;

/** 去掉查询串与片段（公司中转站有时把 Key 放在查询串里，CLAUDE.md 安全约定） */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return (url.split(/[?#]/)[0] ?? url).trim();
  }
}

export interface DiagnosticsInput {
  connectionName: string;
  baseUrl: string;
  interfaceType: InterfaceType;
  model: string;
  headers: Readonly<Record<string, string>>;
  error: ModelError;
  elapsedMs?: number;
  at: number;
}

/** 生成一段纯文本诊断信息，供用户复制粘贴反馈问题 */
export function buildDiagnosticsText(input: DiagnosticsInput): string {
  const headerEntries = Object.entries(input.headers);
  const headerLines = headerEntries
    .map(([k, v]) => `  ${k}: ${SENSITIVE_HEADER.test(k) ? '***' : v}`)
    .join('\n');
  const lines = [
    `连接：${input.connectionName}`,
    `接口类型：${input.interfaceType}`,
    `地址：${redactUrl(input.baseUrl)}`,
    `模型：${input.model}`,
    `时间：${new Date(input.at).toISOString()}`,
    ...(input.elapsedMs !== undefined ? [`耗时：${input.elapsedMs}ms`] : []),
    `错误类型：${input.error.kind}`,
    ...(input.error.status !== undefined ? [`状态码：${input.error.status}`] : []),
    ...(input.error.netError ? [`浏览器错误码：${input.error.netError}`] : []),
    ...(input.error.serverMessage ? [`服务端报错：${input.error.serverMessage}`] : []),
    ...(input.error.suspectParam ? [`可疑参数：${input.error.suspectParam}`] : []),
    ...(headerLines ? ['请求头：', headerLines] : []),
  ];
  return lines.join('\n');
}
