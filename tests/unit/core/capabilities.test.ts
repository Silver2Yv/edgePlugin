import { describe, expect, it } from 'vitest';
import { builtinCapabilities, effectiveCapabilities } from '@/core/llm/capabilities';

describe('builtinCapabilities', () => {
  it('DeepSeek：reasoner 系列是 effort，chat/v3 系列是 none', () => {
    expect(builtinCapabilities('deepseek-reasoner').thinking).toBe('effort');
    expect(builtinCapabilities('deepseek-r1').thinking).toBe('effort');
    expect(builtinCapabilities('deepseek-chat').thinking).toBe('none');
    expect(builtinCapabilities('deepseek-v3').thinking).toBe('none');
  });

  it('Qwen：多模态型号 vision 为 yes，纯文本为 no，思考都是 toggle', () => {
    expect(builtinCapabilities('qwen-vl-plus')).toMatchObject({ thinking: 'toggle', vision: 'yes' });
    expect(builtinCapabilities('qwen-plus')).toMatchObject({ thinking: 'toggle', vision: 'no' });
  });

  it('OpenAI：o 系列与 gpt-5 是 effort，gpt-4o 是 none', () => {
    expect(builtinCapabilities('o1-preview').thinking).toBe('effort');
    expect(builtinCapabilities('gpt-5').thinking).toBe('effort');
    expect(builtinCapabilities('gpt-4o').thinking).toBe('none');
  });

  it('Claude：3 代以上是 effort', () => {
    expect(builtinCapabilities('claude-sonnet-4-5').thinking).toBe('effort');
  });

  it('Gemini：2.5/3 系列是 effort', () => {
    expect(builtinCapabilities('gemini-2.5-flash').thinking).toBe('effort');
  });

  it('认不出的模型标识：整表未知，不默认成不支持/已关闭', () => {
    const c = builtinCapabilities('totally-unknown-model-xyz');
    expect(c).toEqual({ thinking: 'unknown', vision: 'unknown', quirks: [] });
  });
});

describe('effectiveCapabilities', () => {
  it('没有覆盖时等于内置默认，quirks 来自传入的学到列表', () => {
    const c = effectiveCapabilities({}, 'deepseek-chat', ['max_tokens']);
    expect(c).toEqual({ thinking: 'none', vision: 'no', contextWindow: 65_536, quirks: ['max_tokens'] });
  });

  it('按模型覆盖只影响写了的字段，没写的字段仍按内置默认', () => {
    const c = effectiveCapabilities(
      { capabilityOverrides: { 'deepseek-chat': { thinking: 'toggle' } } },
      'deepseek-chat',
    );
    expect(c.thinking).toBe('toggle');
    expect(c.vision).toBe('no'); // 没覆盖，仍是内置默认
  });

  it('覆盖不影响其他模型', () => {
    const c = effectiveCapabilities(
      { capabilityOverrides: { 'deepseek-chat': { thinking: 'toggle' } } },
      'deepseek-reasoner',
    );
    expect(c.thinking).toBe('effort');
  });
});
