import { describe, expect, it } from 'vitest';
import { decideParamRetry, withoutParam } from '@/core/llm/param-retry';

describe('decideParamRetry', () => {
  it('paramRejected 且认出参数名、没收到内容、没重试过：给出决定', () => {
    const d = decideParamRetry(
      { kind: 'paramRejected', status: 400, suspectParam: 'thinking' },
      { hasContent: false, alreadyRetried: false },
    );
    expect(d).toEqual({ param: 'thinking', semantic: true });
  });

  it('非语义敏感的参数：semantic 为 false', () => {
    const d = decideParamRetry(
      { kind: 'paramRejected', status: 400, suspectParam: 'top_p' },
      { hasContent: false, alreadyRetried: false },
    );
    expect(d).toEqual({ param: 'top_p', semantic: false });
  });

  it('已经收到正文/思考内容：不重试（流已经开始）', () => {
    expect(
      decideParamRetry(
        { kind: 'paramRejected', status: 400, suspectParam: 'thinking' },
        { hasContent: true, alreadyRetried: false },
      ),
    ).toBeUndefined();
  });

  it('这次尝试已经重试过一次：不再重试', () => {
    expect(
      decideParamRetry(
        { kind: 'paramRejected', status: 400, suspectParam: 'thinking' },
        { hasContent: false, alreadyRetried: true },
      ),
    ).toBeUndefined();
  });

  it('没认出参数名：不重试', () => {
    expect(
      decideParamRetry({ kind: 'paramRejected', status: 400 }, { hasContent: false, alreadyRetried: false }),
    ).toBeUndefined();
  });

  it('不是 paramRejected：不重试', () => {
    expect(
      decideParamRetry({ kind: 'auth', status: 401 }, { hasContent: false, alreadyRetried: false }),
    ).toBeUndefined();
  });
});

describe('withoutParam', () => {
  it('去掉指定的顶层字段', () => {
    expect(withoutParam({ a: 1, b: 2 }, 'a')).toEqual({ b: 2 });
  });

  it('字段本不存在：原样返回', () => {
    const body = { a: 1 };
    expect(withoutParam(body, 'z')).toEqual({ a: 1 });
  });
});
