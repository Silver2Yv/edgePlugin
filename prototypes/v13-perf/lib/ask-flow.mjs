// 一次完整划词 → 工具栏 →「问」→ 小窗可见 → 真实输入框提问 → 答完 的流程，量齐 V-13 要的几个延迟点。
import { askButtonCenter, waitFloatFrame, waitFloatInputVisible, waitToolbar } from './dom.mjs';
import { pollUntil } from './poll.mjs';

/**
 * @param page Playwright Page（已 goto 到目标合成页）
 * @param cdp 这个 page 的 CDPSession（调用方创建，可跨多次 askFlowOnce 复用）
 * @param relay lib/relay.mjs 的 startRelay() 返回值
 * @param opts.selector 要三击选中的元素，默认 #target
 * @param opts.question 实际输入的问题文字
 */
export async function askFlowOnce(page, cdp, relay, opts = {}) {
  const selector = opts.selector ?? '#target';
  const question = opts.question ?? 'V-13 性能基线测试问题';

  const t0 = Date.now();
  await page.locator(selector).click({ clickCount: 3 });
  const { ms: toolbarMs, center } = await waitToolbar(cdp, 8000, t0);

  const tClick = Date.now();
  await page.mouse.click(center.x, center.y);
  const { ms: floatFrameMs, frame } = await waitFloatFrame(page, 8000, tClick);
  const inputVisibleMs = await waitFloatInputVisible(frame, 8000, tClick);

  const input = frame.getByLabel('输入问题');
  const reqIndexBefore = relay.requests.length;
  await input.fill(question);
  await input.press('Enter');

  await pollUntil(() => relay.requests.length > reqIndexBefore, {
    timeoutMs: 15_000,
    message: '请求到达模拟中转站',
  });
  const requestSentMs = relay.requests[reqIndexBefore].at - tClick;

  const answer = frame.getByTestId('answer');
  let firstContentMs;
  try {
    await pollUntil(
      async () => {
        const len = (await answer.innerText().catch(() => '')).trim().length;
        if (len > 0 && firstContentMs === undefined) firstContentMs = Date.now() - tClick;
        return len > 0;
      },
      { timeoutMs: 15_000, message: '小窗出现正文内容' },
    );
  } catch {
    // 有的模式（如本次没配的错误模式）可能从不产生正文，交给调用方按 job-state 判断
  }

  const jobState = frame.getByTestId('job-state');
  await pollUntil(
    async () => ['completed', 'stopped', 'interrupted', 'failed'].includes(await jobState.innerText()),
    { timeoutMs: 20_000, message: '任务到达终态' },
  );
  const totalMs = Date.now() - tClick;
  const finalState = await jobState.innerText();

  return { toolbarMs, floatFrameMs, inputVisibleMs, requestSentMs, firstContentMs, totalMs, finalState, frame };
}

/** 点网页左上角空白处，收起小窗（隐藏不销毁），为下一次「暖态」提问做准备 */
export const hideFloat = (page) => page.mouse.click(2, 2);

export { askButtonCenter };
