// 模型下拉的纯逻辑（H4、H5、H6、H12）：分组、搜索过滤、换模型候选、思考控件随能力变化。
import { describe, expect, it } from 'vitest';
import type { Connection } from '@/core/llm/adapter';
import {
  capabilitiesFor,
  clampThinking,
  filterGroups,
  MODEL_SWITCH_ERROR_KINDS,
  modelGroups,
  sameModel,
  switchCandidates,
  thinkingControlMode,
  totalModels,
} from '@/ui/model/options';

const CONN = (id: string, name: string, models: readonly string[] = []): Connection => ({
  id,
  name,
  preset: 'custom',
  baseUrl: 'https://relay.test/v1',
  apiKey: '',
  headers: {},
  interfaceType: 'chatCompletions',
  stream: true,
  extraParams: {},
  configVersion: 1,
  models,
});

describe('常用模型分组与搜索（H4、H5）', () => {
  it('只列勾选过常用模型的连接；没勾选过的连接不出现', () => {
    const connections = [CONN('c1', '连接一', ['m1', 'm2']), CONN('c2', '连接二')];
    const groups = modelGroups(connections);
    expect(groups).toEqual([{ connectionId: 'c1', connectionName: '连接一', models: ['m1', 'm2'] }]);
    expect(totalModels(groups)).toBe(2);
  });

  it('搜索按模型标识或连接名过滤；命中连接名时这个连接下的模型全留着', () => {
    const groups = modelGroups([CONN('c1', 'DeepSeek', ['deepseek-chat', 'deepseek-reasoner'])]);
    expect(filterGroups(groups, 'reasoner')[0]?.models).toEqual(['deepseek-reasoner']);
    expect(filterGroups(groups, 'deepseek')[0]?.models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(filterGroups(groups, '没有这个')).toEqual([]);
  });

  it('sameModel 按连接与模型标识比较', () => {
    expect(sameModel({ connectionId: 'c1', model: 'm1' }, { connectionId: 'c1', model: 'm1' })).toBe(true);
    expect(sameModel({ connectionId: 'c1', model: 'm1' }, { connectionId: 'c2', model: 'm1' })).toBe(false);
    expect(sameModel(null, { connectionId: 'c1', model: 'm1' })).toBe(false);
  });
});

describe('换个模型再试的候选（H12）', () => {
  it('排除失败的那一个；别的连接排在前面', () => {
    const connections = [
      CONN('c1', '公司中转站', ['deepseek-chat', 'deepseek-reasoner']),
      CONN('c2', 'DeepSeek 官方', ['deepseek-chat']),
    ];
    const candidates = switchCandidates(connections, { connectionId: 'c1', model: 'deepseek-chat' });
    expect(candidates.map((c) => c.ref)).toEqual([
      { connectionId: 'c2', model: 'deepseek-chat' },
      { connectionId: 'c1', model: 'deepseek-reasoner' },
    ]);
  });

  it('连不上、鉴权失败等才建议换模型；中途断流、参数被拒等不建议', () => {
    expect(MODEL_SWITCH_ERROR_KINDS.has('network')).toBe(true);
    expect(MODEL_SWITCH_ERROR_KINDS.has('auth')).toBe(true);
    expect(MODEL_SWITCH_ERROR_KINDS.has('streamBroken')).toBe(false);
    expect(MODEL_SWITCH_ERROR_KINDS.has('paramRejected')).toBe(false);
    expect(MODEL_SWITCH_ERROR_KINDS.has('aborted')).toBe(false);
  });
});

describe('思考控件随模型能力变化（H6）', () => {
  const connections = [CONN('c1', '连接', ['qwen-plus', 'deepseek-chat', 'gpt-4o', 'unknown-model'])];

  it('开关类（qwen）只显示关/开；各档都按「开」处理', () => {
    const cap = capabilitiesFor(connections, { connectionId: 'c1', model: 'qwen-plus' });
    expect(thinkingControlMode(cap)).toBe('toggle');
    expect(clampThinking('toggle', 'off')).toBe('off');
    expect(clampThinking('toggle', 'low')).toBe('medium');
    expect(clampThinking('toggle', 'high')).toBe('medium');
  });

  it('不支持思考（deepseek-chat）控件禁用，强制为关', () => {
    const cap = capabilitiesFor(connections, { connectionId: 'c1', model: 'deepseek-chat' });
    expect(thinkingControlMode(cap)).toBe('disabled');
    expect(clampThinking('disabled', 'high')).toBe('off');
  });

  it('按强度分档（gpt-4o 未知）或连接没了都照常四档，原样发送', () => {
    expect(
      thinkingControlMode(capabilitiesFor(connections, { connectionId: 'c1', model: 'unknown-model' })),
    ).toBe('full');
    expect(thinkingControlMode(capabilitiesFor(connections, { connectionId: 'gone', model: 'x' }))).toBe(
      'full',
    );
    expect(clampThinking('full', 'high')).toBe('high');
  });
});
