// 思考字段映射（H6、5.8）：按厂商发正确的参数名。各家字段名、取值核实自官方文档（出处见各分支注释）；
// 思考开关属于「语义敏感」参数（adapter.ts SEMANTIC_PARAMS），不得因为参数被拒就静默去掉不发
// （被拒重试见 param-retry.ts，重试本身会在界面上写明去掉了哪个参数）。

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** ChatRequest.thinking → 统一的档位；'on' 没有具体强度，按中档处理 */
export function thinkingLevelOf(
  thinking: 'off' | 'on' | { effort: 'low' | 'medium' | 'high' } | undefined,
): ThinkingLevel | undefined {
  if (thinking === undefined) return undefined;
  if (thinking === 'off') return 'off';
  if (thinking === 'on') return 'medium';
  return thinking.effort;
}

type Vendor = 'deepseek' | 'qwen' | 'openai' | 'claude' | 'gemini' | 'other';

/** 按连接的预设名识别厂商；自定义 / 认不出的一律按 other（5.8：其他模型默认按「关」处理） */
function vendorOf(preset: string): Vendor {
  const p = preset.toLowerCase();
  if (p === 'deepseek') return 'deepseek';
  if (p === 'qwen' || p === 'bailian' || p === 'dashscope') return 'qwen';
  if (p === 'openai') return 'openai';
  if (p === 'claude' || p === 'anthropic') return 'claude';
  if (p === 'gemini' || p === 'google') return 'gemini';
  return 'other';
}

/** DeepSeek 的 reasoning_effort 只接受 low/high/max；我们没有 max 档，medium 映射到 high
 * （api-docs.deepseek.com/zh-cn/guides/thinking_mode：请求 medium/high 都映射到实际 high） */
const DEEPSEEK_EFFORT: Readonly<Record<'low' | 'medium' | 'high', 'low' | 'high'>> = {
  low: 'low',
  medium: 'high',
  high: 'high',
};

/** Claude 扩展思考用固定预算（docs.anthropic.com/en/api/openai-sdk：budget_tokens ≥ 1024） */
const CLAUDE_BUDGET: Readonly<Record<'low' | 'medium' | 'high', number>> = {
  low: 2_000,
  medium: 4_096,
  high: 8_192,
};

/**
 * 按连接预设生成思考相关的请求字段，合并进请求体顶层（chat-completions.ts 的 buildChatBody）。
 * level 为 undefined 表示调用方没填 thinking（如辅助任务可能显式传 'off'，这里统一处理）。
 */
export function buildThinkingBody(preset: string, level: ThinkingLevel | undefined): Record<string, unknown> {
  if (level === undefined) return {};
  const vendor = vendorOf(preset);
  const on = level !== 'off';
  switch (vendor) {
    case 'deepseek':
      // 思考开关与思考强度都显式发送（H6）
      return {
        thinking: { type: on ? 'enabled' : 'disabled' },
        ...(on ? { reasoning_effort: DEEPSEEK_EFFORT[level] } : {}),
      };
    case 'qwen':
      // 只支持开关（help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions 的
      // enable_thinking）；低/中/高都按开（5.8：只支持开关的模型，各档都按开）
      return { enable_thinking: on };
    case 'openai':
      // reasoning_effort：low/medium/high（platform.openai.com/docs/guides/reasoning）；关闭时
      // 首期直接不发这个字段，不强行传不被广泛支持的 'none'
      return on ? { reasoning_effort: level } : {};
    case 'claude':
      // OpenAI 兼容层的 thinking 字段（docs.anthropic.com/en/api/openai-sdk）；该层忽略
      // reasoning_effort，所以不发它。关闭时不发 thinking（部分新模型本就默认开启，没有文档化的
      // 显式关闭写法，省略最安全）
      return on ? { thinking: { type: 'enabled', budget_tokens: CLAUDE_BUDGET[level] } } : {};
    case 'gemini':
      // reasoning_effort：2.5 系列可用 'none' 关闭（ai.google.dev/gemini-api/docs/openai）；
      // 3 / 2.5 Pro 关不掉由服务端自己处理，这里统一按用户设置发送
      return { reasoning_effort: on ? level : 'none' };
    case 'other':
      // 认不出的厂商：不知道字段名，发了可能被拒，默认按「关」处理——什么都不发
      return {};
  }
}
