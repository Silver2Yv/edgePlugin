import { describe, expect, it } from 'vitest';
import type { ThinkingLevel } from '@/core/context/plan';
import {
  clampThinking,
  DEFAULT_THINKING_LEVELS,
  nearestThinkingLevel,
  normalizeThinkingLevels,
  THINKING_LEVELS,
  thinkingControlOf,
} from '@/core/llm/thinking-levels';

describe('normalizeThinkingLevels', () => {
  it('去重、按强弱排序、丢掉非法值；没有有效档位返回 undefined', () => {
    expect(normalizeThinkingLevels(['max', 'off', 'low', 'low'])).toEqual(['off', 'low', 'max']);
    expect(normalizeThinkingLevels(['bogus', 'high'])).toEqual(['high']);
    expect(normalizeThinkingLevels([])).toBeUndefined();
    expect(normalizeThinkingLevels(['bogus'])).toBeUndefined();
    expect(normalizeThinkingLevels('high')).toBeUndefined();
    expect(normalizeThinkingLevels(undefined)).toBeUndefined();
  });
});

describe('nearestThinkingLevel', () => {
  const DEEPSEEK: ThinkingLevel[] = ['off', 'low', 'high', 'max'];

  it('档位在列表里原样保留', () => {
    for (const l of DEEPSEEK) expect(nearestThinkingLevel(DEEPSEEK, l)).toBe(l);
  });

  it('差相同取更强的一档：DeepSeek 的「中」取「高」', () => {
    expect(nearestThinkingLevel(DEEPSEEK, 'medium')).toBe('high');
  });

  it('列表里最强的比所选的弱：取最强；最高 → 高', () => {
    expect(nearestThinkingLevel(DEFAULT_THINKING_LEVELS, 'max')).toBe('high');
    expect(nearestThinkingLevel(['off', 'low'], 'high')).toBe('low');
  });

  it('想开思考时不落到「关」：低 → 列表只有 关/高 时取高', () => {
    expect(nearestThinkingLevel(['off', 'high'], 'low')).toBe('high');
    expect(nearestThinkingLevel(['off', 'max'], 'medium')).toBe('max');
  });

  it('想关而列表没有「关」：取最弱的一档', () => {
    expect(nearestThinkingLevel(['low', 'high'], 'off')).toBe('low');
    expect(nearestThinkingLevel(['medium', 'max'], 'off')).toBe('medium');
  });

  it('列表为空原样返回', () => {
    expect(nearestThinkingLevel([], 'high')).toBe('high');
  });

  it('任意档位 × 任意非空列表：结果一定在列表里', () => {
    const lists: ThinkingLevel[][] = [
      ['off'],
      ['low'],
      ['off', 'max'],
      ['low', 'high'],
      [...THINKING_LEVELS],
    ];
    for (const list of lists)
      for (const l of THINKING_LEVELS) expect(list).toContain(nearestThinkingLevel(list, l));
  });
});

describe('thinkingControlOf / clampThinking', () => {
  const cap = (thinking: 'none' | 'toggle' | 'effort' | 'unknown', levels?: ThinkingLevel[]) => ({
    thinking,
    ...(levels ? { thinkingLevels: levels } : {}),
    vision: 'unknown' as const,
    quirks: [],
  });

  it('没有能力信息（连接没了）按未知处理：关/低/中/高', () => {
    expect(thinkingControlOf(null)).toEqual({ mode: 'full', levels: ['off', 'low', 'medium', 'high'] });
  });

  it('可调强度没写档位用默认四档；写了用写的', () => {
    expect(thinkingControlOf(cap('effort')).levels).toEqual(['off', 'low', 'medium', 'high']);
    expect(thinkingControlOf(cap('effort', ['off', 'low', 'high', 'max'])).levels).toEqual([
      'off',
      'low',
      'high',
      'max',
    ]);
  });

  it('开关与不支持：档位与取档规则不变', () => {
    expect(thinkingControlOf(cap('toggle'))).toEqual({ mode: 'toggle', levels: ['off', 'medium'] });
    expect(thinkingControlOf(cap('none'))).toEqual({ mode: 'disabled', levels: ['off'] });
    expect(clampThinking(thinkingControlOf(cap('toggle')), 'max')).toBe('medium');
    expect(clampThinking(thinkingControlOf(cap('none')), 'max')).toBe('off');
  });

  it('按强度的模型：旧设置里存的「中」用在 DeepSeek 上取「高」', () => {
    expect(clampThinking(thinkingControlOf(cap('effort', ['off', 'low', 'high', 'max'])), 'medium')).toBe(
      'high',
    );
  });
});
