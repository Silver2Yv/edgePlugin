// 模拟中转站的薄封装：记下每次 chat 请求到达的时间戳与正文字节数（用于算「点击→请求发出」延迟，
// 以及模型调用次数），复用 tests/mock-relay/server.ts。
import { startMockRelay } from '../../../tests/mock-relay/server.ts';

export async function startRelay(opts = {}) {
  const relay = await startMockRelay(opts);
  const requests = [];
  relay.server.on('request', (req) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return;
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => requests.push({ at: Date.now(), bytes: Buffer.concat(parts).length }));
  });
  return {
    relay,
    requests,
    count: () => requests.length,
    reset: async () => {
      await fetch(`${relay.url}/__reset`, { method: 'POST' });
      requests.length = 0;
    },
    close: () => relay.close(),
  };
}
