import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockRelay, startMockRelay } from '../mock-relay/server';

let relay: MockRelay;
beforeAll(async () => {
  relay = await startMockRelay({ scale: 0.001 });
});
afterAll(() => relay.close());

const ask = (mode: string, stream = true) =>
  fetch(`${relay.url}/m/${mode}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify({ model: 'mock-flash', stream, messages: [{ role: 'user', content: 'hi' }] }),
  });

describe('模拟中转站', () => {
  it('ok：思考先于正文，[DONE] 结束，记录不含 Key', async () => {
    const text = await (await ask('ok')).text();
    expect(text.indexOf('reasoning_content')).toBeLessThan(text.indexOf('"content"'));
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(relay.log.at(-1)).toMatchObject({ mode: 'ok', hasAuth: true, stream: true });
    expect(JSON.stringify(relay.log)).not.toContain('Bearer');
  });

  it('漏写 /v1 与 html200 返回 200 加网页', async () => {
    const r1 = await fetch(`${relay.url}/chat/completions`, { method: 'POST', body: '{}' });
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toContain('text/html');
    expect((await ask('html200')).headers.get('content-type')).toContain('text/html');
  });

  it('错误码与类型', async () => {
    const r = await ask('401');
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: { type: 'new_api_error' } });
    expect((await ask('param400')).status).toBe(400);
  });

  it('split 把事件切进多个网络块，拼起来与 ok 相同', async () => {
    const r = await ask('split');
    const reader = r.body?.getReader();
    let chunks = 0;
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = (await reader?.read()) ?? { done: true, value: undefined };
      if (done) break;
      chunks++;
      parts.push(value);
    }
    expect(chunks).toBeGreaterThan(10);
    expect(Buffer.concat(parts).toString('utf8')).toContain('模拟中转站');
  });

  it('streamError 在流中给出 error；disconnect 中途断开', async () => {
    expect(await (await ask('streamError')).text()).toContain('"error"');
    await expect((await ask('disconnect')).text()).rejects.toThrow();
  });

  it('failOnce：第一次像 disconnect 一样断开，第二次起正常走完（V-03 测重试）', async () => {
    await fetch(`${relay.url}/__reset`, { method: 'POST' });
    await expect((await ask('failOnce')).text()).rejects.toThrow();
    const text = await (await ask('failOnce')).text();
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(text).toContain('模拟中转站');
  });

  it('crlf 与 heartbeat', async () => {
    expect(await (await ask('crlf')).text()).toContain('\r\n\r\n');
    expect(await (await ask('heartbeat')).text()).toContain(': ping');
  });

  it('markdown：分段流式输出含标题/列表/代码/表格/公式/链接/原始 HTML 的完整正文', async () => {
    const text = await (await ask('markdown')).text();
    const contents = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
    const full = contents.join('');
    expect(full).toContain('# 流式渲染测试文档');
    expect(full).toContain('```ts');
    expect(full).toContain('| 姓名 | 分数 |');
    expect(full).toContain('$E = mc^2$');
    expect(full).toContain('[点我](javascript:alert(1))');
    expect(full).toContain('![示例图片](https://example.com/pic.png)');
    expect(full).toContain('<script>window.__pwned = 1;</script>');
    // 分段数大致为 20 段（按字符近似等分，允许因多字节字符切分产生的浮动）
    expect(contents.length).toBeGreaterThanOrEqual(18);
    expect(contents.length).toBeLessThanOrEqual(21);
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('slowJson 与非流式返回整段 JSON', async () => {
    const r = await ask('slowJson');
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toMatchObject({ object: 'chat.completion' });
    expect(await (await ask('ok', false)).json()).toMatchObject({ object: 'chat.completion' });
  });
});
