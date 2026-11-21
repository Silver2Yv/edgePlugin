// 直接走对话端口发问（和 tests/e2e/page-helpers.ts 的 convAsk 同一手法，这里独立实现，
// 专门用来测「首个有用回答时间」「跨消息传输字节」：在小窗页面里另开一条 'conv' 端口，
// 记录每条收到的消息的到达时间（浏览器自己的时钟，同一进程内相对时间，比跨进程量 Node 时间更准）
// 与字节数（JSON.stringify 后的长度，近似估计跨进程传输的字节量）。
// 不读取、不返回页面正文或模型回答的实际文字内容，只统计类型、时间戳、长度。

/**
 * @param frame 小窗 iframe 的 Playwright Frame（必须已经握手过，即 float/show 已发生）
 * @param ask 覆盖 conv/ask 的字段（text、contextTier、lengthTier、thinking、selectionRevision 等）
 * @param timeoutMs 整体超时
 */
export function askViaConvPort(frame, ask, timeoutMs = 30_000) {
  return frame.evaluate(
    ({ ask, timeoutMs }) =>
      new Promise((resolve) => {
        const events = [];
        let askSentAtMs;
        let firstTextDeltaAtMs;
        let jobId;
        const port = chrome.runtime.connect({ name: 'conv' });
        const clientRequestId = crypto.randomUUID();
        const finish = (extra) => {
          clearTimeout(timer);
          port.disconnect();
          resolve({ events, askSentAtMs, firstTextDeltaAtMs, ...extra });
        };
        const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
        port.onMessage.addListener((raw) => {
          const now = performance.now();
          events.push({ atMs: now, type: raw.type, bytes: JSON.stringify(raw).length });
          if (raw.type === 'conv/ready') {
            askSentAtMs = now;
            port.postMessage({
              type: 'conv/ask',
              clientRequestId,
              actionId: 'ask',
              text: '请解释',
              contextTier: 'nearby',
              lengthTier: 'normal',
              thinking: 'off',
              ...ask,
            });
          } else if (raw.type === 'conv/rejected') {
            finish({ rejected: raw });
          } else if (raw.type === 'conv/accepted' && raw.clientRequestId === clientRequestId) {
            jobId = raw.jobId;
          } else if (raw.type === 'conv/delta' && raw.jobId === jobId) {
            if (firstTextDeltaAtMs === undefined && typeof raw.text === 'string' && raw.text.length > 0) {
              firstTextDeltaAtMs = now;
            }
          } else if (raw.type === 'conv/jobState' && raw.jobId === jobId) {
            if (['completed', 'stopped', 'interrupted', 'failed'].includes(raw.state)) {
              finish({ finalState: raw.state });
            }
          }
        });
        port.postMessage({ type: 'conv/resumeFloat' });
      }),
    { ask, timeoutMs },
  );
}
