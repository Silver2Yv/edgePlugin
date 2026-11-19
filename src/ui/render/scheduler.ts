/**
 * 流式更新节流（5.10 修订建议 2，见 prototypes/v10-render/RESULT.md 第 7 节第 2 条）：
 * - 同一帧内的多次 update() 请求只合并执行最后一次（requestAnimationFrame）。
 * - 累积文本超过 LONG_TEXT_THRESHOLD 字符后，额外保证与上一次真正执行的间隔
 *   不小于 MIN_INTERVAL_MS，把原本随文本长度二次增长的总重解析成本收敛回线性量级。
 * - finalize（流结束的完整校正）不走这条节流，由调用方直接执行，保证结束时立刻可见。
 */

export const LONG_TEXT_THRESHOLD = 20_000;
export const MIN_INTERVAL_MS = 200;

export interface UpdateScheduler {
  /** 请求执行一次 run；同一帧内多次调用只保留最后一次的 run 与 textLength */
  request(textLength: number, run: () => void): void;
  /** 丢弃尚未执行的请求（重置/销毁时调用） */
  cancel(): void;
}

export function createUpdateScheduler(now: () => number = () => performance.now()): UpdateScheduler {
  let rafId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let pendingRun: (() => void) | null = null;
  let pendingLength = 0;

  function flush(): void {
    rafId = null;
    const run = pendingRun;
    if (!run) return;
    if (pendingLength > LONG_TEXT_THRESHOLD) {
      const elapsed = now() - lastRunAt;
      if (elapsed < MIN_INTERVAL_MS) {
        // 保留最新的 pendingRun，到期后再跑；期间新的 request() 会原地覆盖它
        timeoutId = setTimeout(() => {
          timeoutId = null;
          flush();
        }, MIN_INTERVAL_MS - elapsed);
        return;
      }
    }
    pendingRun = null;
    lastRunAt = now();
    run();
  }

  return {
    request(textLength, run) {
      pendingRun = run;
      pendingLength = textLength;
      if (rafId === null && timeoutId === null) rafId = requestAnimationFrame(flush);
    },
    cancel() {
      pendingRun = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    },
  };
}
