import { describe, expect, it } from 'vitest';
import { buildThinkingBody, thinkingLevelOf } from '@/core/llm/thinking';

describe('thinkingLevelOf', () => {
  it('undefined 不发；off 透传；on 按中档；{effort} 透传具体档位', () => {
    expect(thinkingLevelOf(undefined)).toBeUndefined();
    expect(thinkingLevelOf('off')).toBe('off');
    expect(thinkingLevelOf('on')).toBe('medium');
    expect(thinkingLevelOf({ effort: 'high' })).toBe('high');
  });
});

describe('buildThinkingBody', () => {
  it('level 为 undefined：什么都不发，不管厂商', () => {
    expect(buildThinkingBody('deepseek', undefined)).toEqual({});
    expect(buildThinkingBody('openai', undefined)).toEqual({});
  });

  it('DeepSeek：显式发送开关与强度；medium 映射到 high（official：minimal/low→low，medium/high→high）', () => {
    expect(buildThinkingBody('deepseek', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(buildThinkingBody('deepseek', 'low')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
    expect(buildThinkingBody('deepseek', 'medium')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(buildThinkingBody('deepseek', 'high')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('Qwen：只有开关，低/中/高都按开', () => {
    expect(buildThinkingBody('qwen', 'off')).toEqual({ enable_thinking: false });
    expect(buildThinkingBody('qwen', 'low')).toEqual({ enable_thinking: true });
    expect(buildThinkingBody('qwen', 'medium')).toEqual({ enable_thinking: true });
    expect(buildThinkingBody('qwen', 'high')).toEqual({ enable_thinking: true });
  });

  it('OpenAI：reasoning_effort 透传档位；关闭时不发字段', () => {
    expect(buildThinkingBody('openai', 'off')).toEqual({});
    expect(buildThinkingBody('openai', 'low')).toEqual({ reasoning_effort: 'low' });
    expect(buildThinkingBody('openai', 'high')).toEqual({ reasoning_effort: 'high' });
  });

  it('Claude：固定预算的 thinking.budget_tokens；关闭时不发', () => {
    expect(buildThinkingBody('claude', 'off')).toEqual({});
    expect(buildThinkingBody('claude', 'low')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 2_000 },
    });
    expect(buildThinkingBody('claude', 'high')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 8_192 },
    });
    // reasoning_effort 被兼容层忽略，不应该发它
    expect(buildThinkingBody('claude', 'high')).not.toHaveProperty('reasoning_effort');
  });

  it('Gemini：reasoning_effort；关闭时发 none（2.5 系列可用它关闭）', () => {
    expect(buildThinkingBody('gemini', 'off')).toEqual({ reasoning_effort: 'none' });
    expect(buildThinkingBody('gemini', 'medium')).toEqual({ reasoning_effort: 'medium' });
  });

  it('认不出的预设（自定义等）：默认按关处理，什么都不发', () => {
    expect(buildThinkingBody('custom', 'high')).toEqual({});
    expect(buildThinkingBody('my-company-relay', 'off')).toEqual({});
  });

  it('预设名大小写不敏感', () => {
    expect(buildThinkingBody('DeepSeek', 'off')).toEqual({ thinking: { type: 'disabled' } });
  });
});
