// 通用轮询：不依赖 Playwright test 的 expect.poll（这里是纯 Node 脚本，不在 test runner 里跑）。
export async function pollUntil(fn, { timeoutMs = 5000, intervalMs = 20, message = '轮询条件' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`超时：${message}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
