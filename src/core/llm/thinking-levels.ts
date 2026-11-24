// 思考档位（H6、决策 100）：每个模型支持哪几档、选的档位不在模型里时就近取哪一档。
// 纯逻辑，界面（控件选项）与后台（发送前最终取档，规则 8、J10）共用同一份，显示的与发出去的不会分叉。
import type { ThinkingLevel } from '../context/plan';
import type { ModelCapabilities } from './adapter';

/** 从弱到强；也是设置页勾选档位时的显示顺序 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

const RANK: Readonly<Record<ThinkingLevel, number>> = { off: 0, low: 1, medium: 2, high: 3, max: 4 };

/** 能力表没写档位的「可调强度」模型（含未知模型）：保留原来的四档，不擅自加 max */
export const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

/** 只留合法档位、去重、按强弱排序；一档都没有返回 undefined（调用方按「没写」处理） */
export function normalizeThinkingLevels(v: unknown): ThinkingLevel[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = THINKING_LEVELS.filter((l) => v.includes(l));
  return out.length > 0 ? out : undefined;
}

/**
 * 档位不在列表里时就近取一档：按强弱差最小；差相同取更强的一档（DeepSeek 官方把 medium 当 high）。
 * 想开思考（level 不是 off）时不会落到「关」——只要列表里有任何一档开着的思考；想关而列表里没有「关」，
 * 取最弱的一档。列表为空原样返回
 */
export function nearestThinkingLevel(levels: readonly ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
  if (levels.length === 0 || levels.includes(level)) return level;
  const on = levels.filter((l) => l !== 'off');
  const pool = level !== 'off' && on.length > 0 ? on : levels;
  let best = pool[0] as ThinkingLevel;
  for (const c of pool) {
    const d = Math.abs(RANK[c] - RANK[level]);
    const bd = Math.abs(RANK[best] - RANK[level]);
    if (d < bd || (d === bd && RANK[c] > RANK[best])) best = c;
  }
  return best;
}

/** full：下拉列出 levels；toggle：只显示关/开；disabled：不支持思考，控件禁用 */
export type ThinkingControlMode = 'full' | 'toggle' | 'disabled';

export interface ThinkingControl {
  mode: ThinkingControlMode;
  /** full 模式下下拉里的档位（含是否有「关」）；toggle 为 关/中，disabled 只有关 */
  levels: readonly ThinkingLevel[];
}

/** 思考控件随模型能力变化（H6）：开关只显示关/开；无思考的禁用；其余列出能力表里的档位。没有模型（或连接没了）按未知处理 */
export function thinkingControlOf(capability: ModelCapabilities | null): ThinkingControl {
  if (capability?.thinking === 'toggle') return { mode: 'toggle', levels: ['off', 'medium'] };
  if (capability?.thinking === 'none') return { mode: 'disabled', levels: ['off'] };
  return { mode: 'full', levels: capability?.thinkingLevels ?? DEFAULT_THINKING_LEVELS };
}

/**
 * 按控件换算实际要发送的思考强度：开关类模型只认「关/非关」，各档都按「开」处理（5.8，
 * thinking.ts 的 qwen 分支同一个道理）；不支持思考的模型强制关闭；其余取模型支持的档位里最接近的一档
 */
export function clampThinking(control: ThinkingControl, level: ThinkingLevel): ThinkingLevel {
  if (control.mode === 'disabled') return 'off';
  if (control.mode === 'toggle') return level === 'off' ? 'off' : 'medium';
  return nearestThinkingLevel(control.levels, level);
}
