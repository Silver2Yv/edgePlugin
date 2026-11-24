import { describe, expect, it } from 'vitest';
import { buildThinkingBody, thinkingLevelOf } from '@/core/llm/thinking';

/** 不匹配任何厂商正则的模型名：用于只测「按预设识别」分支，不被模型识别抢先命中 */
const GENERIC_MODEL = 'mock-model';

describe('thinkingLevelOf', () => {
  it('undefined 不发；off 透传；on 按中档；{effort} 透传具体档位', () => {
    expect(thinkingLevelOf(undefined)).toBeUndefined();
    expect(thinkingLevelOf('off')).toBe('off');
    expect(thinkingLevelOf('on')).toBe('medium');
    expect(thinkingLevelOf({ effort: 'high' })).toBe('high');
  });
});

describe('buildThinkingBody：按连接预设识别厂商（预设本身就是该厂商、模型名不认识时）', () => {
  it('level 为 undefined：什么都不发，不管厂商', () => {
    expect(buildThinkingBody('deepseek', GENERIC_MODEL, undefined)).toEqual({});
    expect(buildThinkingBody('openai', GENERIC_MODEL, undefined)).toEqual({});
  });

  it('DeepSeek：显式发送开关与强度；medium 映射到 high（official：minimal/low→low，medium/high→high）', () => {
    expect(buildThinkingBody('deepseek', GENERIC_MODEL, 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(buildThinkingBody('deepseek', GENERIC_MODEL, 'low')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
    expect(buildThinkingBody('deepseek', GENERIC_MODEL, 'medium')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(buildThinkingBody('deepseek', GENERIC_MODEL, 'high')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('Qwen：只有开关，低/中/高都按开', () => {
    expect(buildThinkingBody('qwen', GENERIC_MODEL, 'off')).toEqual({ enable_thinking: false });
    expect(buildThinkingBody('qwen', GENERIC_MODEL, 'low')).toEqual({ enable_thinking: true });
    expect(buildThinkingBody('qwen', GENERIC_MODEL, 'medium')).toEqual({ enable_thinking: true });
    expect(buildThinkingBody('qwen', GENERIC_MODEL, 'high')).toEqual({ enable_thinking: true });
  });

  it('OpenAI：reasoning_effort 透传档位；关闭时不发字段', () => {
    expect(buildThinkingBody('openai', GENERIC_MODEL, 'off')).toEqual({});
    expect(buildThinkingBody('openai', GENERIC_MODEL, 'low')).toEqual({ reasoning_effort: 'low' });
    expect(buildThinkingBody('openai', GENERIC_MODEL, 'high')).toEqual({ reasoning_effort: 'high' });
  });

  it('Claude：固定预算的 thinking.budget_tokens；关闭时不发', () => {
    expect(buildThinkingBody('claude', GENERIC_MODEL, 'off')).toEqual({});
    expect(buildThinkingBody('claude', GENERIC_MODEL, 'low')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 2_000 },
    });
    expect(buildThinkingBody('claude', GENERIC_MODEL, 'high')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 8_192 },
    });
    // reasoning_effort 被兼容层忽略，不应该发它
    expect(buildThinkingBody('claude', GENERIC_MODEL, 'high')).not.toHaveProperty('reasoning_effort');
  });

  it('Gemini：reasoning_effort；关闭时发 none（2.5 系列可用它关闭）', () => {
    expect(buildThinkingBody('gemini', GENERIC_MODEL, 'off')).toEqual({ reasoning_effort: 'none' });
    expect(buildThinkingBody('gemini', GENERIC_MODEL, 'medium')).toEqual({ reasoning_effort: 'medium' });
  });

  it('认不出的预设（自定义等）+ 认不出的模型：默认按关处理，什么都不发', () => {
    expect(buildThinkingBody('custom', GENERIC_MODEL, 'high')).toEqual({});
    expect(buildThinkingBody('my-company-relay', GENERIC_MODEL, 'off')).toEqual({});
  });

  it('预设名大小写不敏感', () => {
    expect(buildThinkingBody('DeepSeek', GENERIC_MODEL, 'off')).toEqual({ thinking: { type: 'disabled' } });
  });
});

describe('buildThinkingBody：最高（max，决策 100）', () => {
  it('DeepSeek：max 发 reasoning_effort=max；low / medium / high 的映射不变；关只发 disabled', () => {
    expect(buildThinkingBody('deepseek', GENERIC_MODEL, 'max')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(buildThinkingBody('custom', 'deepseek-flash', 'max')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(buildThinkingBody('deepseek', GENERIC_MODEL, 'low')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
    expect(buildThinkingBody('deepseek', GENERIC_MODEL, 'high')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(buildThinkingBody('deepseek', GENERIC_MODEL, 'off')).toEqual({ thinking: { type: 'disabled' } });
  });

  it('其他厂商没有官方 max：兜底按 high（Qwen 按开、Claude 用 high 的预算）', () => {
    expect(buildThinkingBody('openai', GENERIC_MODEL, 'max')).toEqual({ reasoning_effort: 'high' });
    expect(buildThinkingBody('gemini', GENERIC_MODEL, 'max')).toEqual({ reasoning_effort: 'high' });
    expect(buildThinkingBody('qwen', GENERIC_MODEL, 'max')).toEqual({ enable_thinking: true });
    expect(buildThinkingBody('claude', GENERIC_MODEL, 'max')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 8_192 },
    });
    expect(buildThinkingBody('custom', GENERIC_MODEL, 'max')).toEqual({});
  });

  it('用户声明了「可调强度」：OpenAI / Gemini 档位原样发；认不出的模型按 reasoning_effort 发，关不发', () => {
    expect(buildThinkingBody('openai', GENERIC_MODEL, 'max', true)).toEqual({ reasoning_effort: 'max' });
    expect(buildThinkingBody('gemini', GENERIC_MODEL, 'max', true)).toEqual({ reasoning_effort: 'max' });
    expect(buildThinkingBody('custom', GENERIC_MODEL, 'low', true)).toEqual({ reasoning_effort: 'low' });
    expect(buildThinkingBody('custom', GENERIC_MODEL, 'max', true)).toEqual({ reasoning_effort: 'max' });
    expect(buildThinkingBody('custom', GENERIC_MODEL, 'off', true)).toEqual({});
    // 声明不改变 DeepSeek 的官方写法
    expect(buildThinkingBody('custom', 'deepseek-flash', 'medium', true)).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('thinkingLevelOf 透传 max', () => {
    expect(thinkingLevelOf({ effort: 'max' })).toBe('max');
  });
});

describe('buildThinkingBody：模型标识优先于连接预设（公司中转站挂着上百个不同厂商的模型）', () => {
  it('custom 预设 + deepseek 模型：按模型识别为 deepseek，思考走开关 + 强度，不是什么都不发', () => {
    expect(buildThinkingBody('custom', 'deepseek-chat', 'off')).toEqual({ thinking: { type: 'disabled' } });
    expect(buildThinkingBody('custom', 'deepseek-reasoner', 'high')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('custom 预设 + qwen 模型：按模型识别为 qwen，只发开关', () => {
    expect(buildThinkingBody('custom', 'qwen-plus', 'off')).toEqual({ enable_thinking: false });
    expect(buildThinkingBody('custom', 'qwen3-max', 'low')).toEqual({ enable_thinking: true });
  });

  it('custom 预设 + 认不出的模型：两边都认不出，什么都不发', () => {
    expect(buildThinkingBody('custom', 'some-totally-unknown-model-xyz', 'high')).toEqual({});
  });

  it('模型认不出时才看预设：custom 预设 + gpt 模型按预设走不到——预设本身也认不出时仍按模型优先判断为 openai', () => {
    // 这里用一个 openai 预设 + deepseek 模型的组合，确认模型识别确实盖过了预设
    expect(buildThinkingBody('openai', 'deepseek-chat', 'off')).toEqual({ thinking: { type: 'disabled' } });
  });
});
