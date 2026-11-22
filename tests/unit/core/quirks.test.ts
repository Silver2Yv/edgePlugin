import { describe, expect, it } from 'vitest';
import { EMPTY_QUIRKS, quirksFor, withQuirk } from '@/core/llm/quirks';

const connA = { id: 'c1', interfaceType: 'chatCompletions' as const, configVersion: 1 };
const connB = { id: 'c2', interfaceType: 'chatCompletions' as const, configVersion: 1 };

describe('quirks', () => {
  it('空表：什么都查不到', () => {
    expect(quirksFor(EMPTY_QUIRKS, connA, 'model-x')).toEqual([]);
  });

  it('记一条后能查到；重复记不重复', () => {
    let table = withQuirk(EMPTY_QUIRKS, connA, 'model-x', 'thinking');
    table = withQuirk(table, connA, 'model-x', 'thinking');
    expect(quirksFor(table, connA, 'model-x')).toEqual(['thinking']);
  });

  it('一个连接学到的不影响另一连接（V-07 未执行项）', () => {
    const table = withQuirk(EMPTY_QUIRKS, connA, 'model-x', 'thinking');
    expect(quirksFor(table, connB, 'model-x')).toEqual([]);
  });

  it('同一连接不同模型互不影响', () => {
    const table = withQuirk(EMPTY_QUIRKS, connA, 'model-x', 'thinking');
    expect(quirksFor(table, connA, 'model-y')).toEqual([]);
  });

  it('配置版本变了：旧记录查不到（键里带着版本号）', () => {
    const table = withQuirk(EMPTY_QUIRKS, connA, 'model-x', 'thinking');
    const bumped = { ...connA, configVersion: connA.configVersion + 1 };
    expect(quirksFor(table, bumped, 'model-x')).toEqual([]);
  });

  it('withQuirk 已存在时返回同一个引用（调用方可按引用判断是否需要持久化）', () => {
    const table = withQuirk(EMPTY_QUIRKS, connA, 'model-x', 'thinking');
    expect(withQuirk(table, connA, 'model-x', 'thinking')).toBe(table);
  });
});
