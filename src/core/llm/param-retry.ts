// 参数被拒自动重试一次（H7、5.8）：只在「明确的参数拒绝（400，报错认出了参数）且尚未收到任何可用
// 内容」时，去掉可疑参数重发一次；流已经开始就不重发。纯逻辑，判断与改body都不碰网络。

import type { ModelError } from './adapter';
import { SEMANTIC_PARAMS } from './adapter';

export interface ParamRetryDecision {
  /** 要去掉的参数名 */
  param: string;
  /** 是否语义敏感（5.8：语义敏感参数不得静默去掉，界面必须能写明「已去掉 xx 参数重试」） */
  semantic: boolean;
}

/**
 * 判断这次失败是否该自动去掉参数重试一次。
 * 条件：这次尝试还没重试过；还没收到任何正文/思考内容；错误是 paramRejected 且认出了参数名。
 */
export function decideParamRetry(
  error: ModelError,
  opts: { hasContent: boolean; alreadyRetried: boolean },
): ParamRetryDecision | undefined {
  if (opts.alreadyRetried || opts.hasContent) return undefined;
  if (error.kind !== 'paramRejected' || !error.suspectParam) return undefined;
  const param = error.suspectParam;
  return { param, semantic: (SEMANTIC_PARAMS as readonly string[]).includes(param) };
}

/** 去掉请求体顶层的一个字段；字段本不存在时原样返回 */
export function withoutParam<T extends Record<string, unknown>>(body: T, param: string): T {
  if (!(param in body)) return body;
  const rest = { ...body };
  delete rest[param];
  return rest;
}
