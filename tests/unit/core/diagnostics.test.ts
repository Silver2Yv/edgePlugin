import { describe, expect, it } from 'vitest';
import { buildDiagnosticsText } from '@/core/llm/diagnostics';

const base = {
  connectionName: '我的连接',
  baseUrl: 'https://relay.example.com/v1?key=sk-abc123',
  interfaceType: 'chatCompletions' as const,
  model: 'deepseek-chat',
  headers: { Authorization: 'Bearer sk-should-not-appear', 'X-Trace': 'abc' },
  error: { kind: 'auth' as const, status: 401, serverMessage: 'invalid key' },
  at: 0,
};

describe('buildDiagnosticsText', () => {
  it('地址去掉查询串；敏感请求头隐去值，其他请求头照写', () => {
    const text = buildDiagnosticsText(base);
    expect(text).toContain('https://relay.example.com/v1');
    expect(text).not.toContain('sk-abc123');
    expect(text).not.toContain('sk-should-not-appear');
    expect(text).toContain('Authorization: ***');
    expect(text).toContain('X-Trace: abc');
  });

  it('带上错误类型、状态码、服务端报错；没有的字段（netError、suspectParam）不出现', () => {
    const text = buildDiagnosticsText(base);
    expect(text).toContain('错误类型：auth');
    expect(text).toContain('状态码：401');
    expect(text).toContain('服务端报错：invalid key');
    expect(text).not.toContain('浏览器错误码');
    expect(text).not.toContain('可疑参数');
  });

  it('netError 与 suspectParam 有值时才出现', () => {
    const text = buildDiagnosticsText({
      ...base,
      error: { kind: 'network', netError: 'net::ERR_NAME_NOT_RESOLVED' },
    });
    expect(text).toContain('浏览器错误码：net::ERR_NAME_NOT_RESOLVED');
  });
});
