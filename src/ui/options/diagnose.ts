// 测试连接失败时「可能的原因」（H9、5.8 错误分类与下一步）：按错误分类给一两句，网络层再按浏览器错误码细分
// （域名解析、连不上、证书、代理）。只列可能性，不单凭一个现象下断言。
import type { ModelError } from '@/core/llm/adapter';
import { S } from './strings';

/** 浏览器错误码（net::ERR_*）归到哪一类网络问题；认不出的用笼统的那一句 */
export function netErrorCause(netError: string | undefined): string {
  const code = netError ?? '';
  if (/NAME_NOT_RESOLVED|DNS/.test(code)) return S.cause.netDns;
  if (/CERT|SSL/.test(code)) return S.cause.netCert;
  if (/PROXY|TUNNEL/.test(code)) return S.cause.netProxy;
  if (
    /CONNECTION_(REFUSED|TIMED_OUT|RESET|CLOSED|FAILED)|ADDRESS_UNREACHABLE|TIMED_OUT|INTERNET_DISCONNECTED/.test(
      code,
    )
  )
    return S.cause.netConnect;
  return S.cause.network;
}

/** 一条错误对应的原因说明（一到两句），供设置页、向导在错误标题下方直接显示 */
export function causesOf(error: ModelError): string[] {
  const out = [error.kind === 'network' ? netErrorCause(error.netError) : S.cause[error.kind]];
  if (error.suspectParam) out.push(S.cause.suspectParam(error.suspectParam));
  return out;
}
