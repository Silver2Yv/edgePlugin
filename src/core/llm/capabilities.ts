// 能力表（H11、5.8）：按模型标识内置常见厂商的默认能力，未知就是「未知」，不默认成「不支持」或
// 「已关闭」。允许按连接、按模型手动覆盖（Connection.capabilityOverrides，adapter.ts）。
// 纯逻辑：只按模型标识字符串匹配正则，不碰网络、不碰扩展 API。
import type { Connection, ModelCapabilities, Tri } from './adapter';
import { normalizeThinkingLevels } from './thinking-levels';

type BuiltinCapability = Omit<ModelCapabilities, 'quirks'>;

/** 思考映射（thinking.ts）也按同一套规则识别厂商：模型标识认出了就不看连接预设 */
export type ModelVendor = 'deepseek' | 'qwen' | 'openai' | 'claude' | 'gemini';

const UNKNOWN: BuiltinCapability = { thinking: 'unknown', vision: 'unknown' };

const DEEPSEEK_LEVELS = ['off', 'low', 'high', 'max'] as const;

interface Rule {
  test: RegExp;
  vendor: ModelVendor;
  capability: BuiltinCapability;
}

/**
 * 按出现顺序匹配，取第一条命中的规则；越具体的型号放在前面。
 * 数字与窗口大小是文档发布时的近似值，厂商更新型号后可能变化——这正是允许手动覆盖的原因。
 */
const RULES: readonly Rule[] = [
  // DeepSeek（api-docs.deepseek.com/zh-cn/guides/thinking_mode）：思考开关 + reasoning_effort 只收
  // low / high / max（传 medium 会被当 high），所以没有「中」档（决策 100）
  {
    test: /deepseek.*(reasoner|r1)/i,
    vendor: 'deepseek',
    capability: {
      thinking: 'effort',
      thinkingLevels: DEEPSEEK_LEVELS,
      vision: 'no',
      contextWindow: 65_536,
    },
  },
  {
    test: /deepseek.*(chat|v3)/i,
    vendor: 'deepseek',
    capability: { thinking: 'none', vision: 'no', contextWindow: 65_536 },
  },
  {
    test: /deepseek/i,
    vendor: 'deepseek',
    capability: { thinking: 'effort', thinkingLevels: DEEPSEEK_LEVELS, vision: 'unknown' },
  },

  // 通义千问 / 阿里云百炼（help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions）
  {
    test: /qwen.*(vl|omni)/i,
    vendor: 'qwen',
    capability: { thinking: 'toggle', vision: 'yes', contextWindow: 131_072 },
  },
  { test: /qwen/i, vendor: 'qwen', capability: { thinking: 'toggle', vision: 'no', contextWindow: 131_072 } },

  // OpenAI（platform.openai.com/docs/guides/reasoning）
  {
    test: /^o[1-9]/i,
    vendor: 'openai',
    capability: { thinking: 'effort', vision: 'yes', contextWindow: 200_000 },
  },
  {
    test: /gpt-5/i,
    vendor: 'openai',
    capability: { thinking: 'effort', vision: 'yes', contextWindow: 272_000 },
  },
  {
    test: /gpt-4o|gpt-4\.1|gpt-4-/i,
    vendor: 'openai',
    capability: { thinking: 'none', vision: 'yes', contextWindow: 128_000 },
  },
  { test: /gpt-/i, vendor: 'openai', capability: { thinking: 'unknown', vision: 'unknown' } },

  // Claude（docs.anthropic.com/en/api/openai-sdk，扩展思考）
  {
    test: /claude-(opus|sonnet|haiku)-[3-9]/i,
    vendor: 'claude',
    capability: { thinking: 'effort', vision: 'yes', contextWindow: 200_000 },
  },
  { test: /claude/i, vendor: 'claude', capability: { thinking: 'unknown', vision: 'unknown' } },

  // Gemini（ai.google.dev/gemini-api/docs/openai）
  {
    test: /gemini-(2\.5|3)/i,
    vendor: 'gemini',
    capability: { thinking: 'effort', vision: 'yes', contextWindow: 1_048_576 },
  },
  { test: /gemini/i, vendor: 'gemini', capability: { thinking: 'unknown', vision: 'unknown' } },
];

/** 内置默认能力；没有一条规则命中就整表未知 */
export function builtinCapabilities(model: string): ModelCapabilities {
  for (const r of RULES) if (r.test.test(model)) return { ...r.capability, quirks: [] };
  return { ...UNKNOWN, quirks: [] };
}

/** 按模型标识识别厂商；认不出返回 undefined（调用方再看连接预设，见 thinking.ts） */
export function vendorOfModel(model: string): ModelVendor | undefined {
  for (const r of RULES) if (r.test.test(model)) return r.vendor;
  return undefined;
}

const isTri = (v: unknown): v is Tri => v === 'yes' || v === 'no' || v === 'unknown';

/**
 * 有效能力 = 内置默认 ⊕ 连接上按模型手动覆盖的字段 ⊕ 已学到的怪癖（quirks 单独合并，覆盖不含它）。
 * 覆盖只需写要改的字段；没写的字段仍按内置默认或未知显示。
 */
export function effectiveCapabilities(
  conn: Pick<Connection, 'capabilityOverrides'>,
  model: string,
  learnedQuirks: readonly string[] = [],
): ModelCapabilities {
  const base = builtinCapabilities(model);
  const override = conn.capabilityOverrides?.[model];
  const thinking =
    override?.thinking === 'none' ||
    override?.thinking === 'toggle' ||
    override?.thinking === 'effort' ||
    override?.thinking === 'unknown'
      ? override.thinking
      : base.thinking;
  const vision = isTri(override?.vision) ? override.vision : base.vision;
  const contextWindow = override?.contextWindow ?? base.contextWindow;
  // 自填的档位（设置页勾选）盖过内置；一档都没有当没写
  const thinkingLevels = normalizeThinkingLevels(override?.thinkingLevels) ?? base.thinkingLevels;
  return {
    thinking,
    ...(thinkingLevels ? { thinkingLevels } : {}),
    vision,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    quirks: learnedQuirks,
  };
}

/**
 * 用户在设置里明确说「这个模型可调强度」：把思考覆盖成 effort，或自填了档位且有效能力是 effort。
 * 认不出厂商的模型（公司中转站上的自定义名字）据此按 OpenAI 兼容写法发 reasoning_effort，
 * 否则界面上能选档位、实际什么都不发（thinking.ts）
 */
export function declaresThinkingEffort(
  conn: Pick<Connection, 'capabilityOverrides'>,
  model: string,
): boolean {
  const o = conn.capabilityOverrides?.[model];
  if (!o) return false;
  if (effectiveCapabilities(conn, model).thinking !== 'effort') return false;
  return o.thinking === 'effort' || normalizeThinkingLevels(o.thinkingLevels) !== undefined;
}
