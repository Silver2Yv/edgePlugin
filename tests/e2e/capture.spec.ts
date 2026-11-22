// 框选截图提问（E1–E4、5.13、V-15）：快捷键 → 遮罩里拖出矩形 → 小窗输入区出现缩略图 → 发问，
// 模拟中转站收到的最后一条用户消息里有 image_url（data URL）；Esc 取消不留东西；
// 拖动中滚动页面就丢弃这张、提示重新框选；视觉能力为「不支持」的模型提示换模型且不发出。
// 快捷键经 dispatchCommand 在后台直接触发（没有用户手势，sidePanel.open 会被拒，这里也不需要）。
// 截图只在设了 UI_SHOTS_DIR 时保存，平时不落盘。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { expect, test } from './fixtures';
import {
  collectLogs,
  connection,
  floatFrame,
  type Relay,
  settingsWith,
  startRelay,
  writeSettings,
} from './page-helpers';
import { dispatchCommand, tabOf } from './sidepanel-helpers';

declare const chrome: typeof browser;

const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>截图测试页</title></head>
<body style="margin: 0; font: 16px/1.7 system-ui">
<div id="chart" style="margin: 40px; width: 320px; height: 200px; background: linear-gradient(90deg, #c33 50%, #36c 50%)"></div>
${Array.from({ length: 30 }, (_, i) => `<p style="margin: 24px 40px">第 ${i + 1} 段：拉长页面，好让滚动有地方去。</p>`).join('\n')}
</body></html>`;

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

const overlayOpen = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-ra-capture-overlay]') !== null);

const floatOpen = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-ra-float-host]')?.matches(':popover-open') ?? false);

const pageNotice = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-ra-page-notice]');
    return el?.matches(':popover-open') ? 'open' : 'closed';
  });

function shot(page: Page, name: string) {
  const dir = process.env.UI_SHOTS_DIR;
  if (!dir) return Promise.resolve();
  mkdirSync(dir, { recursive: true });
  return page.screenshot({ path: join(dir, name) }).then(() => undefined);
}

/** 按下快捷键（后台直接触发），等遮罩出现 */
async function startCapture(page: Page, sw: Parameters<typeof tabOf>[0]) {
  await dispatchCommand(sw, 'capture-region', await tabOf(sw, page));
  await expect.poll(() => overlayOpen(page), { message: '遮罩出现', timeout: 10_000 }).toBe(true);
}

/** 在遮罩上从 (x1,y1) 拖到 (x2,y2) */
async function drag(page: Page, x1: number, y1: number, x2: number, y2: number, mid?: () => Promise<void>) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
  if (mid) await mid();
  await page.mouse.move(x2, y2, { steps: 4 });
  await page.mouse.up();
}

interface ImagePart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

const lastUserContent = (body: string | undefined): unknown =>
  (JSON.parse(body ?? '{}') as { messages: { content: unknown }[] }).messages.at(-1)?.content;

test('快捷键框选 → 小窗里出现缩略图 → 发问：请求里带 image_url，发送说明写「附图 1 张」，回答下有核对提示', async ({
  page,
  serviceWorker,
}) => {
  await page.goto('https://e2e.test/article');
  await startCapture(page, serviceWorker);
  await shot(page, 'capture-overlay.png');
  await drag(page, 40, 40, 360, 240);
  await expect.poll(() => overlayOpen(page), { message: '遮罩撤掉' }).toBe(false);
  await expect.poll(() => floatOpen(page), { timeout: 10_000 }).toBe(true);
  const frame = await floatFrame(page);
  const preview = frame.getByTestId('capture-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('本次附图');
  await expect(frame.getByTestId('capture-thumb')).toHaveAttribute('data-ready', 'true');
  await shot(page, 'capture-preview-float.png');

  // 不打字直接发：用截图的默认问题
  await frame.getByLabel('输入问题').press('Enter');
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(1);
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
  const content = lastUserContent(r.bodies[0]) as ImagePart[];
  expect(Array.isArray(content)).toBe(true);
  const img = content.find((p) => p.type === 'image_url');
  expect(img?.image_url?.url).toMatch(/^data:image\/(png|jpeg);base64,/);
  // 裁剪按真实截图尺寸换算：框了 320×200 的 CSS 区域，PNG 头里的宽高应与之按设备像素比成比例
  const url = img?.image_url?.url ?? '';
  if (url.startsWith('data:image/png')) {
    const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    expect(png.readUInt32BE(16)).toBe(Math.round(320 * dpr));
    expect(png.readUInt32BE(20)).toBe(Math.round(200 * dpr));
  }
  const text = content.find((p) => p.type === 'text')?.text ?? '';
  expect(text).toContain('请看这张截图');
  // 预览随发送消失，用户消息里留着缩略图
  await expect(preview).toHaveCount(0);
  await expect(frame.getByTestId('message-image')).toHaveCount(1);
  await expect(frame.getByText('附图 1 张').first()).toBeVisible();
  await expect(frame.getByTestId('image-note')).toContainText('图表解析可能不完全准确');
  await shot(page, 'capture-answer-float.png');

  // 追问不再带图：只有那一轮带过
  await frame.getByLabel('输入问题').fill('左边是什么颜色？');
  await frame.getByLabel('输入问题').press('Enter');
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(2);
  expect(typeof lastUserContent(r.bodies[1])).toBe('string');
});

test('小窗里点「截图」框选：缩略图回到同一个小窗，× 去掉后发问不带图', async ({ page, serviceWorker }) => {
  await page.goto('https://e2e.test/article');
  await dispatchCommand(serviceWorker, 'open-float', await tabOf(serviceWorker, page));
  await expect.poll(() => floatOpen(page), { timeout: 10_000 }).toBe(true);
  const frame = await floatFrame(page);
  await frame.getByTestId('capture-button').click();
  await expect.poll(() => overlayOpen(page), { timeout: 10_000 }).toBe(true);
  await drag(page, 40, 40, 200, 160);
  await expect(frame.getByTestId('capture-preview')).toBeVisible({ timeout: 10_000 });
  await frame.getByRole('button', { name: '去掉截图' }).click();
  await expect(frame.getByTestId('capture-preview')).toHaveCount(0);
  await frame.getByLabel('输入问题').fill('这页讲什么？');
  await frame.getByLabel('输入问题').press('Enter');
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(1);
  expect(JSON.stringify(lastUserContent(r.bodies[0]))).not.toContain('image_url');
});

test('Esc 取消框选：遮罩撤掉，不出预览、不发请求', async ({ page, serviceWorker }) => {
  await page.goto('https://e2e.test/article');
  await startCapture(page, serviceWorker);
  await page.mouse.move(60, 60);
  await page.keyboard.press('Escape');
  await expect.poll(() => overlayOpen(page)).toBe(false);
  await page.waitForTimeout(800);
  expect(await floatOpen(page)).toBe(false);
  expect(r.bodies.length).toBe(0);
  const pending = await serviceWorker.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.keys(all).filter((k) => k.startsWith('capture:'));
  });
  expect(pending).toEqual([]);
});

test('拖动中页面滚动：这张丢弃，网页上提示重新框选，不出预览', async ({ page, serviceWorker }) => {
  await page.goto('https://e2e.test/article');
  await startCapture(page, serviceWorker);
  await drag(page, 40, 40, 300, 220, async () => {
    await page.evaluate(() => window.scrollBy(0, 120));
    await page.waitForTimeout(100);
  });
  await expect.poll(() => overlayOpen(page)).toBe(false);
  await expect.poll(() => pageNotice(page), { timeout: 10_000 }).toBe('open');
  await shot(page, 'capture-changed-notice.png');
  expect(await floatOpen(page)).toBe(false);
});

test('视觉能力为「不支持」的模型：预览里提示换模型，发问被拒、不发出请求', async ({
  page,
  serviceWorker,
}) => {
  const conn = connection(r, { capabilityOverrides: { 'mock-flash': { vision: 'no' } } });
  await writeSettings(serviceWorker, { ...settingsWith(r), connections: [conn] });
  await page.goto('https://e2e.test/article');
  await startCapture(page, serviceWorker);
  await drag(page, 40, 40, 360, 240);
  await expect.poll(() => floatOpen(page), { timeout: 10_000 }).toBe(true);
  const frame = await floatFrame(page);
  await expect(frame.getByTestId('capture-no-vision')).toBeVisible({ timeout: 10_000 });
  await shot(page, 'capture-no-vision.png');
  await frame.getByLabel('输入问题').fill('图里是什么？');
  await frame.getByLabel('输入问题').press('Enter');
  await expect(frame.getByTestId('action-error')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(r.bodies.length).toBe(0);
});

test('页面缩放 125%：裁剪按截图实际尺寸换算，图片宽高等于框选的 CSS 尺寸 × 设备像素比（已含缩放）', async ({
  page,
  serviceWorker,
}) => {
  await page.goto('https://e2e.test/article');
  const tab = await tabOf(serviceWorker, page);
  const before = await page.evaluate(() => window.innerWidth);
  await serviceWorker.evaluate((id) => chrome.tabs.setZoom(id, 1.25), tab.id);
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(before);
  // 记下页面实际收到的指针坐标（CSS 像素），用来算期望尺寸
  await page.evaluate(() => {
    const w = window as unknown as { __pts: number[][] };
    w.__pts = [];
    for (const t of ['pointerdown', 'pointerup'])
      window.addEventListener(
        t,
        (e) => w.__pts.push([(e as PointerEvent).clientX, (e as PointerEvent).clientY]),
        true,
      );
  });
  await startCapture(page, serviceWorker);
  await drag(page, 60, 60, 300, 220);
  await expect.poll(() => floatOpen(page), { timeout: 10_000 }).toBe(true);
  const frame = await floatFrame(page);
  await expect(frame.getByTestId('capture-preview')).toBeVisible();
  const { pts, dpr } = await page.evaluate(() => ({
    pts: (window as unknown as { __pts: number[][] }).__pts,
    dpr: window.devicePixelRatio,
  }));
  const down = pts[0] ?? [0, 0];
  const up = pts.at(-1) ?? [0, 0];
  await frame.getByLabel('输入问题').fill('图里是什么？');
  await frame.getByLabel('输入问题').press('Enter');
  await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(1);
  const content = lastUserContent(r.bodies[0]) as ImagePart[];
  const url = content.find((p) => p.type === 'image_url')?.image_url?.url ?? '';
  expect(url.startsWith('data:image/png')).toBe(true);
  const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  // 页面缩放下 devicePixelRatio 已含缩放（125% × 系统比例）：CSS 尺寸 × 它就是截图里的像素
  const expectW = Math.abs((up[0] ?? 0) - (down[0] ?? 0)) * dpr;
  const expectH = Math.abs((up[1] ?? 0) - (down[1] ?? 0)) * dpr;
  expect(Math.abs(png.readUInt32BE(16) - expectW)).toBeLessThanOrEqual(2);
  expect(Math.abs(png.readUInt32BE(20) - expectH)).toBeLessThanOrEqual(2);
  await shot(page, 'capture-zoom125.png');
  await serviceWorker.evaluate((id) => chrome.tabs.setZoom(id, 1), tab.id);
});

test('拖动中改了页面缩放：这张丢弃，网页上提示重新框选', async ({ page, serviceWorker }) => {
  await page.goto('https://e2e.test/article');
  const tab = await tabOf(serviceWorker, page);
  await startCapture(page, serviceWorker);
  await drag(page, 40, 40, 300, 220, async () => {
    await serviceWorker.evaluate((id) => chrome.tabs.setZoom(id, 1.5), tab.id);
    await page.waitForTimeout(200);
  });
  await expect.poll(() => pageNotice(page), { timeout: 10_000 }).toBe('open');
  expect(await floatOpen(page)).toBe(false);
  await serviceWorker.evaluate((id) => chrome.tabs.setZoom(id, 1), tab.id);
});

test('拖动中切到别的标签页：这张丢弃，不截别的页面', async ({ context, page, serviceWorker }) => {
  const logs = collectLogs(context, serviceWorker);
  await page.goto('https://e2e.test/article');
  const other = await context.newPage();
  await other.goto('https://e2e.test/other');
  await page.bringToFront();
  await startCapture(page, serviceWorker);
  await page.mouse.move(40, 40);
  await page.mouse.down();
  await page.mouse.move(200, 160, { steps: 4 });
  await other.bringToFront();
  await page.waitForTimeout(200);
  await page.mouse.move(300, 220, { steps: 2 });
  await page.mouse.up();
  await expect
    .poll(() => logs.events('capture/failed').map((e) => e.reason), { timeout: 10_000 })
    .toContain('changed');
  expect(logs.events('capture/ready')).toHaveLength(0);
  await other.close();
});
