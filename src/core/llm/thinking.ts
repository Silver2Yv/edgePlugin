// 思考字段映射（H6、5.8）：按厂商发正确的参数名。各家字段名、取值核实自官方文档（出处见各分支注释）；
// 思考开关属于「语义敏感」参数（adapter.ts SEMANTIC_PARAMS），不得因为参数被拒就静默去掉不发
// （被拒重试见 param-retry.ts，重试本身会在界面上写明去掉了哪个参数）。
import type { ThinkingLevel } from '../context/plan';
import { type ModelVendor, vendorOfModel } from './capabilities';

export type { ThinkingLevel };

type Effort = Exclude<ThinkingLevel, 'off'>;

/** ChatRequest.thinking → 统一的档位；'on' 没有具体强度，按中档处理 */
export function thinkingLevelOf(
  thinking: 'off' | 'on' | { effort: Effort } | undefined,
): ThinkingLevel | undefined {
  if (thinking === undefined) return undefined;
  if (thinking === 'off') return 'off';
  if (thinking === 'on') return 'medium';
  return thinking.effort;
}

type Vendor = ModelVendor | 'other';

/** 按连接的预设名识别厂商；自定义 / 认不出的一律按 other */
function vendorOfPreset(preset: string): Vendor {
  const p = preset.toLowerCase();
  if (p === 'deepseek') return 'deepseek';
  if (p === 'qwen' || p === 'bailian' || p === 'dashscope') return 'qwen';
  if (p === 'openai') return 'openai';
  if (p === 'claude' || p === 'anthropic') return 'claude';
  if (p === 'gemini' || p === 'google') return 'gemini';
  return 'other';
}

/**
 * 先按模型标识识别厂商（和 capabilities.ts 同一套正则）——公司中转站这类「自定义」预设上常常挂着
 * 上百个不同厂商的模型，连接预设认不出具体是谁；模型标识认出了就不看连接预设，认不出再退回预设名，
 * 两边都认不出才是 other（5.8：其他模型默认按「关」处理，不是「这个预设认不出就都按关」）。
 */
function resolveVendor(preset: string, model: string): Vendor {
  return vendorOfModel(model) ?? vendorOfPreset(preset);
}

/** DeepSeek 的 reasoning_effort 只接受 low/high/max；medium 映射到 high
 * （api-docs.deepseek.com/zh-cn/guides/thinking_mode：请求 medium/high 都映射到实际 high，max 才是最高） */
const DEEPSEEK_EFFORT: Readonly<Record<Effort, 'low' | 'high' | 'max'>> = {
  low: 'low',
  medium: 'high',
  high: 'high',
  max: 'max',
};

/** Claude 扩展思考用固定预算（docs.anthropic.com/en/api/openai-sdk：budget_tokens ≥ 1024）；
 * 没有官方「最高」档，max 兜底按 high 的预算 */
const CLAUDE_BUDGET: Readonly<Record<Effort, number>> = {
  low: 2_000,
  medium: 4_096,
  high: 8_192,
  max: 8_192,
};

/** 其他厂商没有官方依据的 max：兜底按 high（界面上这些模型的档位里本来就没有 max，见 capabilities.ts） */
const capAtHigh = (level: Effort): Exclude<Effort, 'max'> => (level === 'max' ? 'high' : level);

/**
 * 按模型标识 + 连接预设生成思考相关的请求字段，合并进请求体顶层（chat-completions.ts 的
 * buildChatBody）。level 为 undefined 表示调用方没填 thinking（如辅助任务可能显式传 'off'，这里统一
 * 处理）。declaredEffort 为真表示用户在设置里声明了这个模型「可调强度」（capabilities.ts
 * declaresThinkingEffort）：认不出厂商的模型按 OpenAI 兼容写法发 reasoning_effort，OpenAI / Gemini 的
 * 档位原样发（含用户勾选的 max）。
 */
export function buildThinkingBody(
  preset: string,
  model: string,
  level: ThinkingLevel | undefined,
  declaredEffort = false,
): Record<string, unknown> {
  if (level === undefined) return {};
  const vendor = resolveVendor(preset, model);
  if (level === 'off') return buildOff(vendor);
  switch (vendor) {
    case 'deepseek':
      // 思考开关与思考强度都显式发送（H6）
      return { thinking: { type: 'enabled' }, reasoning_effort: DEEPSEEK_EFFORT[level] };
    case 'qwen':
      // 只支持开关（help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions 的
      // enable_thinking）；低/中/高/最高都按开（5.8：只支持开关的模型，各档都按开）
      return { enable_thinking: true };
    case 'openai':
      // reasoning_effort：low/medium/high（platform.openai.com/docs/guides/reasoning）；没有官方「最高」档，
      // max 兜底按 high，除非用户声明了这个模型的档位
      return { reasoning_effort: declaredEffort ? level : capAtHigh(level) };
    case 'claude':
      // OpenAI 兼容层的 thinking 字段（docs.anthropic.com/en/api/openai-sdk）；该层忽略
      // reasoning_effort，所以不发它
      return { thinking: { type: 'enabled', budget_tokens: CLAUDE_BUDGET[level] } };
    case 'gemini':
      // reasoning_effort（ai.google.dev/gemini-api/docs/openai）；max 兜底同 openai
      return { reasoning_effort: declaredEffort ? level : capAtHigh(level) };
    case 'other':
      // 认不出的厂商：不知道字段名，发了可能被拒，默认按「关」处理——什么都不发；
      // 用户声明了「可调强度」才按 OpenAI 兼容写法发
      return declaredEffort ? { reasoning_effort: level } : {};
  }
}

function buildOff(vendor: Vendor): Record<string, unknown> {
  switch (vendor) {
    case 'deepseek':
      return { thinking: { type: 'disabled' } };
    case 'qwen':
      return { enable_thinking: false };
    case 'gemini':
      // 2.5 系列可用 'none' 关闭；3 / 2.5 Pro 关不掉由服务端自己处理，这里统一按用户设置发送
      return { reasoning_effort: 'none' };
    // OpenAI 首期直接不发字段，不强行传不被广泛支持的 'none'；Claude 部分新模型本就默认开启，
    // 没有文档化的显式关闭写法，省略最安全；认不出的厂商什么都不发
    case 'openai':
    case 'claude':
    case 'other':
      return {};
  }
}
