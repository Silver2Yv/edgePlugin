// 能力表（H11、5.8）：按模型标识内置常见厂商的默认能力，未知就是「未知」，不默认成「不支持」或
// 「已关闭」。允许按连接、按模型手动覆盖（Connection.capabilityOverrides，adapter.ts）。
// 纯逻辑：只按模型标识字符串匹配正则，不碰网络、不碰扩展 API。
import type { Connection, ModelCapabilities, Tri } from './adapter';

type BuiltinCapability = Omit<ModelCapabilities, 'quirks'>;

const UNKNOWN: BuiltinCapability = { thinking: 'unknown', vision: 'unknown' };

interface Rule {
  test: RegExp;
  capability: BuiltinCapability;
}

/**
 * 按出现顺序匹配，取第一条命中的规则；越具体的型号放在前面。
 * 数字与窗口大小是文档发布时的近似值，厂商更新型号后可能变化——这正是允许手动覆盖的原因。
 */
const RULES: readonly Rule[] = [
  // DeepSeek（api-docs.deepseek.com/zh-cn/guides/thinking_mode）
  {
    test: /deepseek.*(reasoner|r1)/i,
    capability: { thinking: 'effort', vision: 'no', contextWindow: 65_536 },
  },
  { test: /deepseek.*(chat|v3)/i, capability: { thinking: 'none', vision: 'no', contextWindow: 65_536 } },
  { test: /deepseek/i, capability: { thinking: 'effort', vision: 'unknown' } },

  // 通义千问 / 阿里云百炼（help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions）
  { test: /qwen.*(vl|omni)/i, capability: { thinking: 'toggle', vision: 'yes', contextWindow: 131_072 } },
  { test: /qwen/i, capability: { thinking: 'toggle', vision: 'no', contextWindow: 131_072 } },

  // OpenAI（platform.openai.com/docs/guides/reasoning）
  { test: /^o[1-9]/i, capability: { thinking: 'effort', vision: 'yes', contextWindow: 200_000 } },
  { test: /gpt-5/i, capability: { thinking: 'effort', vision: 'yes', contextWindow: 272_000 } },
  {
    test: /gpt-4o|gpt-4\.1|gpt-4-/i,
    capability: { thinking: 'none', vision: 'yes', contextWindow: 128_000 },
  },
  { test: /gpt-/i, capability: { thinking: 'unknown', vision: 'unknown' } },

  // Claude（docs.anthropic.com/en/api/openai-sdk，扩展思考）
  {
    test: /claude-(opus|sonnet|haiku)-[3-9]/i,
    capability: { thinking: 'effort', vision: 'yes', contextWindow: 200_000 },
  },
  { test: /claude/i, capability: { thinking: 'unknown', vision: 'unknown' } },

  // Gemini（ai.google.dev/gemini-api/docs/openai）
  { test: /gemini-(2\.5|3)/i, capability: { thinking: 'effort', vision: 'yes', contextWindow: 1_048_576 } },
  { test: /gemini/i, capability: { thinking: 'unknown', vision: 'unknown' } },
];

/** 内置默认能力；没有一条规则命中就整表未知 */
export function builtinCapabilities(model: string): ModelCapabilities {
  for (const r of RULES) if (r.test.test(model)) return { ...r.capability, quirks: [] };
  return { ...UNKNOWN, quirks: [] };
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
  return {
    thinking,
    vision,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    quirks: learnedQuirks,
  };
}
