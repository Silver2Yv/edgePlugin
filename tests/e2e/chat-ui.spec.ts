// 小窗与侧边栏的对话界面（B2、B3、B5、B8、C1、C3、D3、D11、I3、J2）：
// 图钉、取消引用、临时切换档位与思考强度、完整对话与「展开讲讲」、发送说明、深色模式可读。
// 截图（亮 / 暗各一组，含带代码与公式的回答）只在设了 UI_SHOTS_DIR 时保存，平时不落盘。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  askInFloat,
  clickAsk,
  collectLogs,
  connection,
  parseBody,
  type Relay,
  selectAndOpen,
  settingsWith,
  startRelay,
  writeSettings,
} from './page-helpers';
import {
  askInPanel,
  attachPanel,
  openPanelByTrustedClick,
  type PanelHandle,
  panelText,
} from './sidepanel-helpers';

const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const FIRST = '第一段：这是一篇用来检查对话界面的文章。';
const FAR = '最后一段：离选中的那一段很远，只有带全文时才会发给模型。';
const filler = Array.from(
  { length: 14 },
  (_, i) => `<p>填充段落 ${i + 1}：植物的叶片、根系与茎各有分工，这里只是为了把文章拉长。</p>`,
).join('\n');
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>对话界面测试文章</title></head>
<body style="max-width: 720px; margin: 24px auto; font: 16px/1.7 system-ui">
<article><h1>对话界面测试文章</h1>
<p id="p1">${FIRST}</p>
<p id="target">${PARAGRAPH}</p>
${filler}
<p id="far">${FAR}</p>
</article></body></html>`;

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(async ({ context, serviceWorker }) => {
  await r.reset();
  await writeSettings(serviceWorker, settingsWith(r));
  await context.route('https://e2e.test/**', (rt) =>
    rt.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
});

const floatOpen = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-ra-float-host]')?.matches(':popover-open') ?? false);

const floatHostRect = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-ra-float-host]') as HTMLElement;
    return { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height };
  });

/** 本轮用户消息（请求里的最后一条） */
const lastUserText = (body: string | undefined) => parseBody(body).messages.at(-1)?.content ?? '';

test('图钉：钉住后点网页不收起，新选中的文字点「问」只换引用、小窗留在原处；取消钉住后点网页照常收起', async ({
  page,
}) => {
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#target');
  await expect(frame.getByTestId('quote')).toContainText(PARAGRAPH);
  const pin = frame.getByRole('button', { name: '钉住小窗' });
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  // 图钉状态经私有端口到阅读器，留一点时间
  await page.waitForTimeout(300);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(400);
  expect(await floatOpen(page)).toBe(true);

  // 钉住时换一段选中再点「问」：引用直接换成新的，小窗不挪位置（B5）
  const before = await floatHostRect(page);
  await page.locator('#p1').click({ clickCount: 3 });
  await clickAsk(page);
  await expect(frame.getByTestId('quote')).toContainText(FIRST);
  expect(await floatOpen(page)).toBe(true);
  expect(await floatHostRect(page)).toEqual(before);

  // 网页里按 Esc 仍然收起（B3），再打开还是钉住的
  await page.locator('h1').click();
  await page.keyboard.press('Escape');
  await expect.poll(() => floatOpen(page)).toBe(false);
  await page.locator('#target').click({ clickCount: 3 });
  await clickAsk(page);
  await expect.poll(() => floatOpen(page)).toBe(true);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(400);
  expect(await floatOpen(page)).toBe(true);

  // 取消钉住：点网页照常收起
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await page.waitForTimeout(300);
  await page.mouse.click(5, 5);
  await expect.poll(() => floatOpen(page)).toBe(false);
});

test('设置里的小窗默认关闭方式为「钉住」：打开就是钉住的，点网页不收起；点 × 收起', async ({
  page,
  serviceWorker,
}) => {
  const s = settingsWith(r);
  await writeSettings(serviceWorker, { ...s, float: { ...s.float, closeMode: 'pinned' } });
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#target');
  await expect(frame.getByRole('button', { name: '钉住小窗' })).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(300);
  await page.mouse.click(5, 5);
  await page.waitForTimeout(400);
  expect(await floatOpen(page)).toBe(true);
  await frame.getByRole('button', { name: '收起小窗' }).click();
  await expect.poll(() => floatOpen(page)).toBe(false);
});

test('取消引用：点 × 后引用条消失，之后的请求不带选中的文字；新选区到达时引用条重新出现', async ({
  page,
  serviceWorker,
}) => {
  // 只看选中：请求里只有选区与问题，取消引用后就只剩问题
  const s = settingsWith(r);
  await writeSettings(serviceWorker, { ...s, context: { ...s.context, defaultTier: 'selection' } });
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#target');
  await expect(frame.getByTestId('quote')).toContainText(PARAGRAPH);
  await frame.getByRole('button', { name: '取消引用' }).click();
  await expect(frame.getByTestId('quote')).toHaveCount(0);
  await frame.getByLabel('输入问题').click();
  await askInFloat(frame, r, '随便聊聊');
  expect(r.bodies[0]).not.toContain(PARAGRAPH);
  expect(lastUserText(r.bodies[0])).not.toContain('<selected_text>');
  // 用户消息里没有引用摘要
  await expect(frame.getByTestId('user-message')).toHaveText('随便聊聊');

  // 重新划词点「问」：引用条换上新的选区，发问带上它
  await page.locator('#p1').click({ clickCount: 3 });
  await clickAsk(page);
  await expect(frame.getByTestId('quote')).toContainText(FIRST);
  await askInFloat(frame, r, '这句呢');
  expect(lastUserText(r.bodies[1])).toContain(FIRST);
});

test('临时切换档位与思考强度：切到「带全文」「思考 高」后请求随之变化，只影响这个对话；新对话回到默认', async ({
  page,
  serviceWorker,
}) => {
  const logs = collectLogs(page.context(), serviceWorker);
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#target');
  const tier = frame.getByLabel('上下文档位');
  const thinking = frame.getByLabel('思考强度');
  // 默认值来自设置：带上下文、思考关
  await expect(tier).toHaveValue('nearby');
  await expect(thinking).toHaveValue('off');
  await expect(tier).toHaveAttribute('title', /带上下文/);
  await askInFloat(frame, r, '第一问');
  expect(logs.plans().at(-1)).toMatchObject({ requestedTier: 'nearby', contextTier: 'nearby' });
  expect(r.bodies[0]).not.toContain(FAR);
  expect(parseBody(r.bodies[0]).reasoning_effort).toBeUndefined();

  await tier.selectOption('fullPage');
  await thinking.selectOption('high');
  await frame.getByLabel('输入问题').click();
  await askInFloat(frame, r, '第二问');
  expect(logs.plans().at(-1)).toMatchObject({ requestedTier: 'fullPage', contextTier: 'fullPage' });
  expect(r.bodies[1]).toContain(FAR);
  expect(parseBody(r.bodies[1]).reasoning_effort).toBe('high');
  // 发送说明（B8）跟着这次的计划
  await expect(frame.getByTestId('send-note').last()).toContainText('带全文');

  // 同一对话里接着问，沿用临时切换的值
  await askInFloat(frame, r, '第三问');
  expect(logs.plans().at(-1)).toMatchObject({ requestedTier: 'fullPage' });

  // 新对话：回到设置里的默认值，历史不再带上
  await frame.getByRole('button', { name: '新对话' }).click();
  await expect(tier).toHaveValue('nearby');
  await expect(thinking).toHaveValue('off');
  await expect(frame.getByTestId('user-message')).toHaveCount(0);
  await frame.getByLabel('输入问题').click();
  await askInFloat(frame, r, '第四问');
  expect(logs.plans().at(-1)).toMatchObject({ requestedTier: 'nearby' });
  expect(r.bodies[3]).not.toContain('第一问');
  expect(parseBody(r.bodies[3]).reasoning_effort).toBeUndefined();
});

test('完整对话与「展开讲讲」：小窗接着同一对话问，之前的问答留在列表里；简短档答完出现按钮，点了用详细档追问', async ({
  page,
  serviceWorker,
}) => {
  const s = settingsWith(r);
  await writeSettings(serviceWorker, { ...s, reply: { ...s.reply, lengthTier: 'brief' } });
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '这段话讲了什么？');
  // 用户消息：问题 + 引用摘要；回答下方有发送说明
  await expect(frame.getByTestId('user-message')).toContainText('这段话讲了什么？');
  await expect(frame.getByTestId('user-message')).toContainText('光合作用');
  const note = frame.getByTestId('send-note');
  // 选中的字数（三击选中整段，末尾可能带换行，比段落本身多一两个字）
  await expect(note).toContainText(/选中 3[5-9] 字/);
  await expect(note).toContainText('带上下文');
  await expect(note).toContainText('全文共');
  expect(parseBody(r.bodies[0]).messages[0]?.content).toContain('回答尽量简短');
  if (SHOTS) {
    // 截图：一轮简短问答，思考过程与发送说明展开，下方有「展开讲讲」
    await frame.locator('details.ra-think > summary').click();
    await note.locator('summary').click();
    await page.waitForTimeout(200);
    saveShot('float-light-4-brief-expand.png', await page.screenshot());
    await note.locator('summary').click();
    await frame.locator('details.ra-think > summary').click();
  }

  // 展开讲讲：同一对话里追问一句，长度档 detailed；上一轮留在列表里
  const expand = frame.getByRole('button', { name: '展开讲讲' });
  await expect(expand).toBeVisible();
  await expand.click();
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(2);
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
  const second = parseBody(r.bodies[1]);
  expect(second.messages[0]?.content).toContain('回答可以详细展开');
  expect(second.messages.at(-1)?.content).toContain('展开讲讲');
  // 带着上一轮的历史（同一对话）
  expect(second.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  expect(JSON.stringify(second.messages)).toContain('这段话讲了什么？');
  await expect(frame.getByTestId('user-message')).toHaveCount(2);
  await expect(frame.getByTestId('history-answer')).toHaveCount(1);
  await expect(frame.getByTestId('answer')).toHaveCount(1);
  // 详细档的回答下面不再有「展开讲讲」
  await expect(expand).toHaveCount(0);
  // 同一段引用连续追问：第二条用户消息不重复显示引用摘要
  await expect(frame.getByTestId('user-message').last()).toHaveText('展开讲讲');
  if (SHOTS) saveShot('float-light-5-two-turns.png', await page.screenshot());
});

// ───────────── 深色模式与截图 ─────────────

/** sRGB 相对亮度（WCAG） */
function luminance(rgb: string): number {
  const [r8 = 0, g8 = 0, b8 = 0] = (rgb.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r8) + 0.7152 * lin(g8) + 0.0722 * lin(b8);
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** 在界面页面里取几处文字的前景色与页面底色 */
const COLORS_JS = `(() => {
  const pick = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).color : null; };
  return {
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    bg: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.body).color,
    answer: pick('[data-testid="answer"]'),
    note: pick('[data-testid="send-note"]'),
    input: pick('textarea'),
    code: pick('pre.ra-code'),
    codeBg: (() => { const el = document.querySelector('pre.ra-code'); return el ? getComputedStyle(el).backgroundColor : null; })(),
  };
})()`;

interface Colors {
  scheme: string;
  bg: string;
  text: string;
  answer: string | null;
  note: string | null;
  input: string | null;
  code: string | null;
  codeBg: string | null;
}

function expectReadable(c: Colors, scheme: 'dark' | 'light') {
  expect(c.scheme).toBe(scheme);
  // 深色：底色暗；浅色：底色亮
  if (scheme === 'dark') expect(luminance(c.bg)).toBeLessThan(0.1);
  else expect(luminance(c.bg)).toBeGreaterThan(0.8);
  // 正文、输入框与底色的对比度达到 WCAG AA（4.5），小字说明至少 3
  expect(contrast(c.text, c.bg)).toBeGreaterThan(4.5);
  if (c.answer) expect(contrast(c.answer, c.bg)).toBeGreaterThan(4.5);
  if (c.input) expect(contrast(c.input, c.bg)).toBeGreaterThan(4.5);
  if (c.note) expect(contrast(c.note, c.bg)).toBeGreaterThan(3);
  if (c.code && c.codeBg) expect(contrast(c.code, c.codeBg)).toBeGreaterThan(4.5);
}

const SHOTS = process.env.UI_SHOTS_DIR;
function saveShot(name: string, png: Buffer) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, name), png);
}

async function markdownSettings(sw: import('@playwright/test').Worker) {
  await writeSettings(sw, {
    ...settingsWith(r),
    connections: [connection(r, { baseUrl: `${r.relay.url}/m/markdown/v1` })],
  });
}

/** 小窗里问一句，等带代码与公式的回答渲染完 */
async function askMarkdownInFloat(page: Page): Promise<Frame> {
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '渲染一下这份文档');
  await expect(frame.locator('[data-testid="answer"] .katex').first()).toBeVisible();
  return frame;
}

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme === 'dark' ? '深色' : '浅色'}模式：小窗跟随系统配色，正文、代码、输入框、小字都读得清`, async ({
    page,
    serviceWorker,
  }) => {
    await markdownSettings(serviceWorker);
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.emulateMedia({ colorScheme: scheme });
    const frame = await askMarkdownInFloat(page);
    expectReadable((await frame.evaluate(COLORS_JS)) as Colors, scheme);
    // 外壳（在网页文档里）跟着换配色：深色下不是白底
    const shellBg = await page.evaluate(
      () => (document.querySelector('[data-ra-float-host]') as HTMLElement).style.background,
    );
    if (scheme === 'dark') expect(luminance(shellBg)).toBeLessThan(0.1);
    else expect(luminance(shellBg)).toBeGreaterThan(0.8);

    if (!SHOTS) return;
    // 截图一：回答开头（标题、列表）；截图二：滚到代码与公式；截图三：空小窗（引用条 + 输入区）
    await page.waitForTimeout(300);
    saveShot(`float-${scheme}-1-answer.png`, await page.screenshot());
    await frame.locator('pre.ra-code').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    saveShot(`float-${scheme}-2-code-math.png`, await page.screenshot());
    await frame.getByRole('button', { name: '新对话' }).click();
    await page.waitForTimeout(200);
    saveShot(`float-${scheme}-3-empty.png`, await page.screenshot());
  });

  test(`${scheme === 'dark' ? '深色' : '浅色'}模式：侧边栏跟随系统配色，显示当前页信息、完整对话与发送说明`, async ({
    context,
    page,
    serviceWorker,
  }) => {
    test.setTimeout(60_000);
    await markdownSettings(serviceWorker);
    await page.goto('https://e2e.test/article');
    expect(await openPanelByTrustedClick(context)).toBe('ok');
    await page.bringToFront();
    const panel: PanelHandle = await attachPanel(context);
    await panel.cdp('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    });
    // 侧边栏开着时点「问」：引用进侧边栏，在侧边栏问
    await page.locator('#target').click({ clickCount: 3 });
    await clickAsk(page);
    await expect.poll(() => panelText(panel, 'quote')).toContain(PARAGRAPH);
    await askInPanel(panel, '渲染一下这份文档');
    await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
    expectReadable(await panel.evaluate<Colors>(COLORS_JS), scheme);
    // 当前页信息（C3）：标题取自标签页，可读取的字数取自最近一次计划
    expect(await panelText(panel, 'page-title')).toBe('对话界面测试文章');
    expect(await panelText(panel, 'page-meta')).toMatch(/可读取 [\d,]+ 字/);
    expect(await panelText(panel, 'user-message')).toContain('渲染一下这份文档');
    expect(await panelText(panel, 'send-note')).toContain('带上下文');

    if (SHOTS) {
      const shot = async (name: string) => {
        const { data } = await panel.cdp<{ data: string }>('Page.captureScreenshot', { format: 'png' });
        saveShot(name, Buffer.from(data, 'base64'));
      };
      await page.waitForTimeout(300);
      await shot(`sidepanel-${scheme}-1-answer.png`);
      await panel.evaluate(`(document.querySelector('pre.ra-code').scrollIntoView({ block: 'start' }), 1)`);
      await page.waitForTimeout(200);
      await shot(`sidepanel-${scheme}-2-code-math.png`);
    }
    await panel.detach();
  });
}
