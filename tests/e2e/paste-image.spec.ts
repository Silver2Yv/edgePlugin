// 输入框粘贴图片（决策 099）：小窗里粘贴一张图 → 预览缩略图与「外部截图」提示 → 发问，模拟中转站收到的用户消息里有 image_url，
// 说明文字写明是外部图片；「关闭」只关这一张的提示，「不再提醒」记住之后不再显示；文字粘贴照旧；超限给明确提示；
// 侧边栏同样能粘贴；超过 2048 的大图由后台缩小。
// 小窗里走真实剪贴板（navigator.clipboard.write 写入 PNG，再按 Ctrl+V）；侧边栏不是 Playwright 页面、拿不到真实按键与剪贴板焦点，
// 用调试协议在页面里派发带 DataTransfer 的 paste 事件（接收端同一个 onPaste 处理函数）。
import type { BrowserContext, Frame, Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { expect, test } from './fixtures';
import { floatFrame, type Relay, settingsWith, startRelay, writeSettings } from './page-helpers';
import { attachPanel, dispatchCommand, openPanelByTrustedClick, tabOf } from './sidepanel-helpers';

declare const chrome: typeof browser;

const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>粘贴图片测试页</title></head>
<body style="margin: 0; font: 16px/1.7 system-ui"><p style="margin: 24px 40px">一段用来打开小窗的正文。</p></body></html>`;

const HINT = '当前外部截图无法定位原文位置及上下文，建议使用插件截图按钮或快捷键';

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(async ({ context, serviceWorker }) => {
  await r.reset();
  await writeSettings(serviceWorker, settingsWith(r));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.route('https://e2e.test/**', (rt) =>
    rt.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
});

const floatOpen = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-ra-float-host]')?.matches(':popover-open') ?? false);

async function openFloat(page: Page, sw: Parameters<typeof tabOf>[0]): Promise<Frame> {
  await page.goto('https://e2e.test/article');
  await dispatchCommand(sw, 'open-float', await tabOf(sw, page));
  await expect.poll(() => floatOpen(page), { timeout: 10_000 }).toBe(true);
  return floatFrame(page);
}

/** 页面里画一张 PNG（左红右蓝），返回写进剪贴板的函数体用的脚本 */
const DRAW = `async (size) => {
  const c = document.createElement('canvas');
  c.width = size.w; c.height = size.h;
  const g = c.getContext('2d');
  g.fillStyle = '#c33'; g.fillRect(0, 0, size.w / 2, size.h);
  g.fillStyle = '#36c'; g.fillRect(size.w / 2, 0, size.w / 2, size.h);
  return await new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
}`;

/**
 * 把内容写进系统剪贴板。小窗是网页里的 iframe，没有 clipboard 的 permissions policy，不能在里面调 navigator.clipboard；
 * 所以在另一个标签页里写（系统剪贴板是共用的），写完回到原标签页。这只是测试的准备动作，粘贴本身是真实的 Ctrl+V
 */
async function writeClipboard(
  context: BrowserContext,
  page: Page,
  what: { text: string } | { w: number; h: number },
) {
  const aux = await context.newPage();
  await aux.goto('https://e2e.test/clip');
  await aux.bringToFront();
  await aux.evaluate(async (w) => {
    if ('text' in w) return navigator.clipboard.writeText(w.text);
    const c = document.createElement('canvas');
    c.width = w.w;
    c.height = w.h;
    const g = c.getContext('2d');
    if (!g) throw new Error('没有画布');
    g.fillStyle = '#c33';
    g.fillRect(0, 0, w.w / 2, w.h);
    g.fillStyle = '#36c';
    g.fillRect(w.w / 2, 0, w.w / 2, w.h);
    const blob = await new Promise<Blob>((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error('编码失败'))), 'image/png'),
    );
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, what);
  await aux.close();
  await page.bringToFront();
}

/** 剪贴板里放一张 PNG，在小窗输入框里按 Ctrl+V */
async function pasteImageInFloat(
  context: BrowserContext,
  page: Page,
  frame: Frame,
  size = { w: 120, h: 80 },
) {
  await writeClipboard(context, page, size);
  await frame.getByLabel('输入问题').focus();
  await page.keyboard.press('ControlOrMeta+V');
}

const lastUserContent = (body: string | undefined): unknown =>
  (JSON.parse(body ?? '{}') as { messages: { content: unknown }[] }).messages.at(-1)?.content;

interface Part {
  type: string;
  text?: string;
  image_url?: { url: string };
}

test('小窗粘贴一张图：出现预览与提示 → 发问，请求里有 image_url 且说明是外部图片；追问不重发', async ({
  context,
  page,
  serviceWorker,
}) => {
  const frame = await openFloat(page, serviceWorker);
  await pasteImageInFloat(context, page, frame);
  const preview = frame.getByTestId('capture-preview');
  await expect(preview).toBeVisible({ timeout: 10_000 });
  await expect(frame.getByTestId('capture-thumb')).toHaveAttribute('data-ready', 'true');
  await expect(preview).toContainText('外部图片 120×80');
  await expect(frame.getByTestId('paste-hint')).toContainText(HINT);
  // 原图只在后台的 storage.session（标了外部图片），界面没有
  const pending = await serviceWorker.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('capture:'))
      .map(([, v]) => ({
        external: (v as { external?: boolean }).external,
        mime: (v as { mime: string }).mime,
      }));
  });
  expect(pending).toEqual([{ external: true, mime: 'image/png' }]);

  await frame.getByLabel('输入问题').fill('这张图画了什么？');
  await frame.getByLabel('输入问题').press('Enter');
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(1);
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
  const content = lastUserContent(r.bodies[0]) as Part[];
  expect(Array.isArray(content)).toBe(true);
  expect(content.find((p) => p.type === 'image_url')?.image_url?.url).toMatch(
    /^data:image\/(png|jpeg);base64,/,
  );
  const text = content.find((p) => p.type === 'text')?.text ?? '';
  expect(text).toContain('外部图片');
  expect(text).toContain('这张图画了什么？');
  await expect(preview).toHaveCount(0);
  await expect(frame.getByTestId('message-image')).toHaveCount(1);
  await expect(frame.getByText('附图 1 张').first()).toBeVisible();

  await frame.getByLabel('输入问题').fill('左边是什么颜色？');
  await frame.getByLabel('输入问题').press('Enter');
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(2);
  expect(typeof lastUserContent(r.bodies[1])).toBe('string');
});

test('文字粘贴照旧：进输入框，不出预览', async ({ context, page, serviceWorker }) => {
  const frame = await openFloat(page, serviceWorker);
  const input = frame.getByLabel('输入问题');
  await input.focus();
  await writeClipboard(context, page, { text: '一段粘贴的文字' });
  await input.focus();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(input).toHaveValue('一段粘贴的文字');
  await page.waitForTimeout(300);
  await expect(frame.getByTestId('capture-preview')).toHaveCount(0);
});

test('「关闭」只关这一次；「不再提醒」记住，之后粘贴不再显示提示（预览照常）', async ({
  context,
  page,
  serviceWorker,
}) => {
  const frame = await openFloat(page, serviceWorker);
  await pasteImageInFloat(context, page, frame);
  await expect(frame.getByTestId('paste-hint')).toBeVisible({ timeout: 10_000 });
  await frame.getByTestId('paste-hint-close').click();
  await expect(frame.getByTestId('paste-hint')).toHaveCount(0);
  await expect(frame.getByTestId('capture-preview')).toBeVisible();

  // 再粘贴一张（替换旧图）：提示又出现
  await pasteImageInFloat(context, page, frame, { w: 90, h: 60 });
  await expect(frame.getByTestId('capture-preview')).toContainText('外部图片 90×60');
  await expect(frame.getByTestId('paste-hint')).toBeVisible();

  await frame.getByTestId('paste-hint-off').click();
  await expect(frame.getByTestId('paste-hint')).toHaveCount(0);
  const saved = await serviceWorker.evaluate(
    async () => (await chrome.storage.local.get('pasteHintOff')).pasteHintOff,
  );
  expect(saved).toBe(true);

  // 去掉这张、再粘贴：有预览、没有提示
  await frame.getByRole('button', { name: '去掉截图' }).click();
  await expect(frame.getByTestId('capture-preview')).toHaveCount(0);
  await pasteImageInFloat(context, page, frame, { w: 100, h: 50 });
  await expect(frame.getByTestId('capture-preview')).toContainText('外部图片 100×50');
  await page.waitForTimeout(300);
  await expect(frame.getByTestId('paste-hint')).toHaveCount(0);
});

test('大图（超过 2048）由后台缩小；超过 16 MB 的当场提示、不发出', async ({
  context,
  page,
  serviceWorker,
}) => {
  const frame = await openFloat(page, serviceWorker);
  await pasteImageInFloat(context, page, frame, { w: 3000, h: 1500 });
  await expect(frame.getByTestId('capture-preview')).toContainText('外部图片 2048×1024', {
    timeout: 15_000,
  });
  await frame.getByLabel('输入问题').fill('多大？');
  await frame.getByLabel('输入问题').press('Enter');
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(1);
  const url =
    (lastUserContent(r.bodies[0]) as Part[]).find((p) => p.type === 'image_url')?.image_url?.url ?? '';
  const mime = /^data:(image\/\w+);/.exec(url)?.[1];
  expect(mime).toMatch(/^image\/(png|jpeg)$/);
  if (mime === 'image/png') {
    const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    expect(png.readUInt32BE(16)).toBe(2048);
    expect(png.readUInt32BE(20)).toBe(1024);
  }
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });

  // 17 MB 的「图片」：界面当场拦下并明确说明，不向后台发任何东西
  await frame.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(17 * 1024 * 1024)], 'big.png', { type: 'image/png' }));
    document
      .querySelector('textarea')
      ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(frame.getByTestId('action-error')).toContainText('超过 16 MB');
  await expect(frame.getByTestId('capture-preview')).toHaveCount(0);
});

test('侧边栏同样能粘贴：预览、提示、发问带图', async ({ context, page }) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/article');
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel = await attachPanel(context);
  // 在侧边栏页面里画一张 PNG，经带 DataTransfer 的 paste 事件交给输入框
  await expect
    .poll(() => panel.evaluate<boolean>('document.querySelector("textarea") !== null'), { timeout: 10_000 })
    .toBe(true);
  await panel.evaluate(`(async () => {
    const blob = await (${DRAW})({ w: 160, h: 100 });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    document.querySelector('textarea').dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await expect
    .poll(() => panel.text('[data-testid="capture-preview"]'), { timeout: 15_000 })
    .toContain('外部图片 160×100');
  expect(await panel.text('[data-testid="paste-hint"]')).toContain(HINT);

  // 发问：输入框里打字、回车
  await panel.click('textarea[aria-label="输入问题"]');
  await panel.type('侧边栏里的图');
  await panel.press('Enter');
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(1);
  const content = lastUserContent(r.bodies[0]) as Part[];
  expect(content.some((p) => p.type === 'image_url')).toBe(true);
  expect(content.find((p) => p.type === 'text')?.text).toContain('外部图片');
  await panel.detach();
});
