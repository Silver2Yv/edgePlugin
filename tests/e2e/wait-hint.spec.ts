// 等待时持续给反馈（用户 2026-11-19 Edge 试用反馈）：发问后迟迟没有任何增量时，小窗回答区按已过
// 时间换提示文案（纯函数 waitHintText 的单测已覆盖全部档位，见 tests/unit/ui/float-state.test.ts）。
// 这里只验证真实端到端：wait-hint 元素依序出现前两档文案，答完后随任务终态消失。用 silent65（立即给
// 响应头，65 秒不给正文/思考，见 mock-relay/server.ts 文件头）配合 scale 把 65 秒压缩到约 10 秒真实等待，
// 落在「满 7 秒」与「满 15 秒」两档之间，前后留出余量，避免压线导致的偶发失败。

import { expect, test } from './fixtures';
import {
  clickAsk,
  connection,
  floatFrame,
  type Relay,
  settingsWith,
  startRelay,
  writeSettings,
} from './page-helpers';

const SITE = 'https://e2e-wait-hint.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>等待提示测试文章</title></head>
<body><article>
<p>第一段：这是一篇用来做端到端测试的文章，内容无关紧要。</p>
<p id="target">${PARAGRAPH}</p>
</article></body></html>`;
/** 模拟中转站 silent65 模式静默期结束后正常走完的正文 */
const ANSWER = '这是模拟中转站的回答。它分多段流式返回。';

let relay: Relay;

test.beforeAll(async () => {
  relay = await startRelay(0.15); // 65 秒 × 0.15 ≈ 9.75 秒
});
test.afterAll(() => relay.relay.close());
test.beforeEach(() => relay.reset());

test('等待时持续给反馈：先「正在等待回答」，满 7 秒后换「正在努力思考中」，答完后提示消失', async ({
  page,
  serviceWorker,
}) => {
  test.setTimeout(35_000);
  await writeSettings(
    serviceWorker,
    settingsWith(relay, {
      connections: [connection(relay, { baseUrl: `${relay.relay.url}/m/silent65/v1` })],
    }),
  );
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
  await page.goto(`${SITE}article`);

  await page.locator('#target').click({ clickCount: 3 });
  await clickAsk(page);
  const frame = await floatFrame(page);
  const input = frame.getByLabel('输入问题');
  await expect(input).toBeFocused();
  await frame.page().keyboard.type('这段话讲了什么？');
  await expect(input).toHaveValue('这段话讲了什么？');
  await input.press('Enter');

  const hint = frame.getByTestId('wait-hint');
  await expect(hint).toHaveText('正在等待回答…', { timeout: 5_000 });
  await expect(hint).toHaveText('正在努力思考中…', { timeout: 10_000 });

  await expect(frame.getByTestId('answer').last()).toContainText(ANSWER, { timeout: 15_000 });
  await expect(frame.getByTestId('job-state').last()).toHaveText('completed');
  // 答完（终态）后提示立即消失，不留在回答区
  await expect(hint).toHaveCount(0);
});
