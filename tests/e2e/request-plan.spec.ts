// V-07：请求装配与预算（VALIDATION_MATRIX）。断言「模拟中转站收到的完整请求」与「发送计划」逐项对得上（规则 8）：
// 发了哪些块、覆盖率、估算的输入量、模型标识、额外参数的优先级、降档移除旧全文、长历史从最早处丢弃。
// 估算口径与装配同一函数（estimateTokens），从请求正文逐条重算，必须与计划完全一致。
import { estimateTokens } from '../../src/core/context/plan';
import { expect, test } from './fixtures';
import {
  askInFloat,
  collectLogs,
  connection,
  convAsk,
  floatFrame,
  MODEL,
  pageBlocksIn,
  parseBody,
  type Relay,
  type SentBody,
  selectAndConvAsk,
  selectAndOpen,
  selectionRevision,
  settingsWith,
  startRelay,
  waitSentinelRegistered,
  writeSettings,
} from './page-helpers';

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(() => r.reset());

const model = { connectionId: 'e2e-conn-0001', model: MODEL };

const ZH =
  '中文段落：光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。它是地球上几乎所有生命的能量来源，也决定了大气中氧气的含量。';
const EN = 'English paragraph: Photosynthesis converts light energy into chemical energy stored in glucose.';
const RICH = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>请求装配样本</title></head>
<body><article>
<h1>请求装配样本</h1>
<p id="zh">${ZH}</p>
<p id="en">${EN}</p>
<pre><code class="language-python">def add(a, b):
    return a + b</code></pre>
<table><tr><th>元素</th><th>符号</th></tr><tr><td>氢</td><td>H</td></tr><tr><td>氧</td><td>O</td></tr></table>
<div class="katex-display"><span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E = mc^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">E=mc2</span></span></div>
<h2>第二节</h2>
<p id="tail">结尾段落：本节总结上面的内容。</p>
</article></body></html>`;

/** 长页面：400 段、每段约 120 字，远超速度软预算；选区在第 200 段 */
const LONG_PARAS = Array.from(
  { length: 400 },
  (_, i) => `第${i + 1}段：${'这是长页面里用来占预算的正文内容，'.repeat(7)}段末编号${i + 1}。`,
);
const LONG = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>长页面</title></head>
<body><article><h1>长页面</h1>${LONG_PARAS.map((p, i) => `<p id="p${i + 1}">${p}</p>`).join('')}</article></body></html>`;

const codePoints = (s: string) => [...s].length;

/** 从请求正文重算估算的输入量：每条消息的文字各算一次再相加（与装配的口径一致） */
const recomputeTokens = (b: SentBody) => b.messages.reduce((n, m) => n + estimateTokens(m.content), 0);

async function open(
  page: import('@playwright/test').Page,
  sw: import('@playwright/test').Worker,
  html: string,
) {
  await waitSentinelRegistered(sw);
  await page
    .context()
    .route('https://e2e.test/v07/**', (rt) =>
      rt.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
    );
  await page.goto('https://e2e.test/v07/page');
}

test('中文、英文、代码、表格、公式：整页读取时请求里的块与计划一致，覆盖率与估算可从请求重算', async ({
  page,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await open(page, serviceWorker, RICH);
  const { res } = await selectAndConvAsk(page, serviceWorker, '#zh', {
    model,
    text: '总结一下',
    contextTier: 'fullPage',
  });
  expect(res.states.at(-1)).toBe('completed');
  const body = parseBody(r.bodies[0]);
  const plan = res.plan as Record<string, unknown> & {
    sentBlockIds: string[];
    coverage: { sentChars: number; extractableChars: number };
  };
  // 全文作为固定首条消息（5.9 顺序：系统 → 页面全文 → 历史 → 本轮）
  expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
  const blocks = pageBlocksIn(body.messages[1]?.content ?? '');
  expect(blocks.map((b) => b.id)).toEqual(plan.sentBlockIds);
  const text = (id: string) => blocks.find((b) => b.id === id)?.text ?? '';
  const all = blocks.map((b) => b.text);
  expect(all).toContain(ZH);
  expect(all).toContain(EN);
  expect(all).toContain('```python\ndef add(a, b):\n    return a + b\n```');
  expect(all).toContain('| 元素 | 符号 |\n| --- | --- |\n| 氢 | H |\n| 氧 | O |');
  expect(all).toContain('$$\nE = mc^2\n$$');
  expect(text(plan.sentBlockIds.at(-1) as string)).toContain('结尾段落');
  // 覆盖率：已发送块的字数之和（从请求重算）= 计划里的 sentChars；全发时等于可提取正文
  const sentChars = blocks.reduce((n, b) => n + codePoints(b.text), 0);
  expect(plan.coverage).toEqual({ sentChars, extractableChars: sentChars });
  expect(plan).toMatchObject({ contextTier: 'fullPage', pageRead: true, removedEarlierPageText: false });
  // 估算输入量：从请求正文逐条重算，与计划完全一致；且不超过 硬上限 − 输出预留
  expect(recomputeTokens(body)).toBe(plan.estimatedInputTokens);
  const budget = plan.budget as { hardLimit: number; outputReserve: number };
  expect(plan.estimatedInputTokens as number).toBeLessThanOrEqual(budget.hardLimit - budget.outputReserve);
  console.log('[V-07] 样本页计划', JSON.stringify({ ...plan, contextSnapshotId: undefined }));
});

test('不同速度软预算：全文放不下时以选区为中心连续截取，输入量受预算约束，能力未知按 32k', async ({
  page,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  const rows: Record<string, unknown>[] = [];
  let first = true;
  for (const ratio of [0.1, 0.5, 1]) {
    await writeSettings(serviceWorker, {
      ...settingsWith(r),
      context: { speedSoftBudgetRatio: ratio, summaryReadRatio: 0.3, defaultTier: 'nearby' },
    });
    if (first) await open(page, serviceWorker, LONG);
    first = false;
    const n = r.bodies.length;
    const { res } = await selectAndConvAsk(page, serviceWorker, '#p200', {
      model,
      text: '这一段说了什么',
      contextTier: 'fullPage',
    });
    expect(res.states.at(-1)).toBe('completed');
    const body = parseBody(r.bodies[n]);
    const plan = res.plan as Record<string, unknown> & {
      sentBlockIds: string[];
      budget: { hardLimit: number; outputReserve: number; speedSoftBudget: number };
      coverage: { sentChars: number; extractableChars: number };
      estimatedInputTokens: number;
      notes: string[];
    };
    const blocks = pageBlocksIn(body.messages[1]?.content ?? '');
    expect(blocks.map((b) => b.id)).toEqual(plan.sentBlockIds);
    // 选区所在段在内，且发出的块连续（中间不缺块）
    expect(blocks.some((b) => b.text.includes('段末编号200。'))).toBe(true);
    const nums = plan.sentBlockIds.map((id) => Number(id.slice(1)));
    expect(nums).toEqual(nums.map((_, i) => (nums[0] as number) + i));
    // 能力未知：硬上限按 32k 保守值；输出预留 min(4096, 20%)；软预算 = 硬上限 × 比例
    expect(plan.budget).toMatchObject({
      hardLimit: 32_000,
      outputReserve: 4096,
      speedSoftBudget: 32_000 * ratio,
    });
    expect(plan.estimatedInputTokens).toBe(recomputeTokens(body));
    expect(plan.estimatedInputTokens).toBeLessThanOrEqual(
      Math.min(plan.budget.speedSoftBudget, plan.budget.hardLimit - plan.budget.outputReserve),
    );
    expect(plan.coverage.sentChars).toBe(blocks.reduce((n, b) => n + codePoints(b.text), 0));
    expect(plan.coverage.sentChars).toBeLessThan(plan.coverage.extractableChars);
    expect(plan.notes.join()).toContain('以选区为中心');
    rows.push({
      ratio,
      blocks: plan.sentBlockIds.length,
      range: `${plan.sentBlockIds[0]}–${plan.sentBlockIds.at(-1)}`,
      estimatedInputTokens: plan.estimatedInputTokens,
      coverage: `${plan.coverage.sentChars}/${plan.coverage.extractableChars}`,
    });
  }
  const counts = rows.map((x) => x.blocks as number);
  expect(counts[0]).toBeLessThan(counts[1] as number);
  expect(counts[1]).toBeLessThan(counts[2] as number);
  console.log('[V-07] 预算对照', JSON.stringify(rows));
});

test('全文 → 选区降档：第二次请求不带旧全文，计划写明；长历史从最早处丢弃，条数与计划一致', async ({
  page,
  serviceWorker,
}) => {
  test.setTimeout(90_000);
  await writeSettings(serviceWorker, settingsWith(r));
  await open(page, serviceWorker, RICH);
  const { frame, res: a } = await selectAndConvAsk(page, serviceWorker, '#zh', {
    model,
    text: '第一问',
    contextTier: 'fullPage',
  });
  const conversationId = a.accepted?.conversationId;
  const sel = await selectionRevision(serviceWorker, page);
  const b = await convAsk(frame, {
    model,
    text: '第二问',
    contextTier: 'selection',
    conversationId,
    selectionRevision: sel,
  });
  const second = parseBody(r.bodies[1]);
  expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(JSON.stringify(second.messages)).not.toContain(EN);
  expect(JSON.stringify(second.messages.slice(1))).not.toContain('<page_content>');
  expect(b.plan).toMatchObject({
    contextTier: 'selection',
    pageRead: false,
    removedEarlierPageText: true,
    historyHasPageText: true,
    droppedHistoryTurns: 0,
  });
  expect(recomputeTokens(second)).toBe(b.plan?.estimatedInputTokens);

  // 长历史：每问带约 8 千字的问题（约 8.8k token），四轮之后放不下，从最早的一轮起丢弃
  const long = (i: number) => `第${i}个长问题：${'历史里很长的提问内容，'.repeat(800)}`;
  let last = b;
  for (let i = 3; i <= 6; i++) {
    last = await convAsk(frame, {
      model,
      text: long(i),
      contextTier: 'selection',
      conversationId,
      selectionRevision: sel,
    });
    expect(last.states.at(-1)).toBe('completed');
  }
  const body = parseBody(r.bodies.at(-1));
  const plan = last.plan as {
    droppedHistoryTurns: number;
    estimatedInputTokens: number;
    budget: { hardLimit: number; outputReserve: number };
  };
  const historyTurns = (body.messages.length - 2) / 2;
  expect(plan.droppedHistoryTurns).toBeGreaterThan(0);
  // 此前共 5 轮：留下的轮数 + 丢弃的轮数 = 5；丢的是最早的，留的是最近的
  expect(historyTurns).toBeGreaterThan(0);
  expect(historyTurns + plan.droppedHistoryTurns).toBe(5);
  expect(body.messages.at(-1)?.content).toContain('第6个长问题');
  expect(body.messages[1]?.content).toContain(`第${7 - 1 - historyTurns}个长问题`);
  expect(JSON.stringify(body.messages)).not.toContain('第一问');
  expect(recomputeTokens(body)).toBe(plan.estimatedInputTokens);
  expect(plan.estimatedInputTokens).toBeLessThanOrEqual(plan.budget.hardLimit - plan.budget.outputReserve);
  console.log(
    '[V-07] 长历史',
    JSON.stringify({ historyTurns, dropped: plan.droppedHistoryTurns, tokens: plan.estimatedInputTokens }),
  );
});

test('连接切换与额外参数：请求发到所选连接、模型标识正确；受保护字段不被覆盖；一个连接的参数不进另一个', async ({
  page,
  serviceWorker,
}) => {
  const other = await startRelay();
  try {
    const a = connection(r, {
      extraParams: {
        model: 'evil-model',
        messages: [{ role: 'user', content: '注入的消息' }],
        stream: false,
        stream_options: { include_usage: false },
        tools: [{ type: 'function', function: { name: 'x' } }],
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 777,
        thinking: { type: 'enabled' },
      },
    });
    const b = connection(other, { id: 'e2e-conn-0002', name: '另一个中转站', extraParams: {} });
    await writeSettings(serviceWorker, {
      ...settingsWith(r),
      connections: [a, b],
      defaultModel: { connectionId: a.id, model: MODEL },
    });
    await open(page, serviceWorker, RICH);
    const { frame, res: ra } = await selectAndConvAsk(page, serviceWorker, '#zh', {
      model: { connectionId: a.id, model: MODEL },
      text: '用连接一',
      contextTier: 'nearby',
    });
    const sel = await selectionRevision(serviceWorker, page);
    const rb = await convAsk(frame, {
      model: { connectionId: b.id, model: 'mock-pro' },
      text: '用连接二',
      contextTier: 'nearby',
      selectionRevision: sel,
    });
    // 请求各自到达所选连接，模型标识与计划一致（界面显示的就是实际发送的，J10）
    expect(r.bodies).toHaveLength(1);
    expect(other.bodies).toHaveLength(1);
    const bodyA = parseBody(r.bodies[0]);
    const bodyB = parseBody(other.bodies[0]);
    expect(bodyA.model).toBe(MODEL);
    expect(ra.plan?.model).toEqual({ connectionId: a.id, model: MODEL });
    expect(bodyB.model).toBe('mock-pro');
    expect(rb.plan?.model).toEqual({ connectionId: b.id, model: 'mock-pro' });
    // 受保护字段（model、messages、stream、stream_options、tools、tool_choice）不被额外参数覆盖
    expect(bodyA.stream).toBe(true);
    expect(bodyA.stream_options).toEqual({ include_usage: true });
    expect(bodyA.tools).toBeUndefined();
    expect(bodyA.tool_choice).toBeUndefined();
    expect(JSON.stringify(bodyA.messages)).not.toContain('注入的消息');
    expect(bodyA.messages.at(-1)?.content).toContain('用连接一');
    // 可覆盖的采样参数照用户填的发
    expect(bodyA.temperature).toBe(0.3);
    expect(bodyA.max_tokens).toBe(777);
    // 一个连接的额外参数不进另一个连接的请求
    expect(bodyB.temperature).toBeUndefined();
    expect(bodyB.max_tokens).toBeUndefined();
    // 实测记录：额外参数里的思考开关与界面的思考设置冲突时，请求里是哪一个（语义敏感字段）
    console.log(
      '[V-07] 思考字段',
      JSON.stringify({
        extraParams: a.extraParams.thinking,
        uiThinking: ra.plan?.thinking,
        sent: bodyA.thinking,
      }),
    );
  } finally {
    await other.relay.close();
  }
});

test('界面设置与请求一致：小窗按设置的长度档、回答语言、思考、默认档位发问', async ({
  page,
  serviceWorker,
}) => {
  const logs = collectLogs(page.context(), serviceWorker);
  await writeSettings(serviceWorker, {
    ...settingsWith(r),
    reply: { lengthTier: 'brief', language: 'en', thinking: 'high' },
    context: { speedSoftBudgetRatio: 0.5, summaryReadRatio: 0.3, defaultTier: 'nearby' },
  });
  await open(page, serviceWorker, RICH);
  const frame = await selectAndOpen(page, '#en');
  await askInFloat(frame, r, '这句话是什么意思？');
  const body = parseBody(r.bodies[0]);
  const system = body.messages[0]?.content ?? '';
  expect(system).toContain('回答尽量简短');
  expect(system).toContain('用 en 回答');
  expect(body.reasoning_effort).toBe('high');
  const plan = logs.plans().at(-1) as Record<string, unknown>;
  expect(plan).toMatchObject({ requestedTier: 'nearby', contextTier: 'nearby', pageRead: true });
  const sent = pageBlocksIn(body.messages.at(-1)?.content ?? '').map((b) => b.id);
  expect(sent).toEqual(plan.sentBlockIds);
  expect(sent.length).toBeGreaterThan(1);
  await expect((await floatFrame(page)).getByTestId('job-state')).toHaveText('completed');
});
