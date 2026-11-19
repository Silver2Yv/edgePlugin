// 错误分类的界面文案（ARCHITECTURE 5.8「错误分类与下一步」、H9）；Record 保证新增分类时这里不会漏。
// FloatApp 与 OptionsApp 共用，避免两边各存一份容易漏改的文案。
import type { ModelErrorKind } from '@/core/llm/adapter';

export const ERROR_LABEL: Readonly<Record<ModelErrorKind, string>> = {
  htmlInsteadOfJson: '地址可能不对（返回的是网页，多半缺 /v1）',
  auth: 'Key 无效或被拒绝',
  notFound: '接口路径或接口类型不对',
  paramRejected: '有参数不被支持',
  redirected: '接口地址发生了重定向',
  network: '网络连接失败',
  streamBroken: '回答中途断开',
  server: '模型服务出错',
  rateLimited: '请求太频繁，被限流',
  badResponse: '模型服务返回了无法识别的内容',
  timeout: '等待超时',
  noContent: '模型没有返回正文',
  contextOverflow: '内容超出模型上下文长度',
  aborted: '已中止',
};
