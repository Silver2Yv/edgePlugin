// 页面图片（E2、5.14「页面图片（可选）」、V-15 页面图片部分）：设置里的开关「把上下文中的图片一起发给模型」。
// 开着：选中段落里已加载的图片由后台去图片所在的主机取，进模型请求的图片部分，发送计划记下地址（发送说明展开后列出）；
// 关着（默认）：请求里没有图片，也不会去取；跨主机重定向的图不进请求，计划说明里写原因；图片取不到不影响提问；
// 选区之外的图不会被取。取图的请求不带 Cookie / 凭据、不带模型 Key。
import { deflateSync } from 'node:zlib';
import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  connection,
  floatFrame,
  parseBody,
  type Relay,
  selectAndConvAsk,
  settingsWith,
  startRelay,
  waitSentinelRegistered,
  writeSettings,
} from './page-helpers';

const MODEL = { connectionId: 'e2e-conn-0001', model: 'mock-flash' };

// ───────────── 一个最小的 PNG 编码器（纯色） ─────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const IMG_IN = 'https://img.e2e.test/in-paragraph.png';
const IMG_OUT = 'https://img.e2e.test/elsewhere.png';
const IMG_REDIRECT = 'https://img.e2e.test/redirect.png';
const IMG_TARGET = 'https://cdn.other.test/final.png';

const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>页面图片测试页</title></head>
<body style="max-width: 720px; margin: 24px auto; font: 16px/1.7 system-ui">
<article><h1>页面图片测试页</h1>
<p id="intro">这是开头的一段，没有图片，用来把选区所在段落与其他段落隔开。这是开头的一段，没有图片。</p>
<p id="with-img">图 1 展示了光合作用的过程：光能被叶绿体吸收并转成化学能。<img src="${IMG_IN}" width="120" height="80" alt="示意图"></p>
<p id="spacer1">中间的占位段落一，把选区所在的段落与别的带图段落隔开。中间的占位段落一，把选区所在的段落与别的带图段落隔开。</p>
<p id="spacer2">中间的占位段落二，把选区所在的段落与别的带图段落隔开。中间的占位段落二，把选区所在的段落与别的带图段落隔开。</p>
<p id="with-redirect">图 2 的地址会被重定向到另一个主机，所以这张图不应该被发给模型；这段文字写得比较长，好让点击落在文字上而不是图片上。<img src="${IMG_REDIRECT}" width="120" height="80" alt="重定向图"></p>
<p id="spacer3">中间的占位段落三，把选区所在的段落与别的带图段落隔开。中间的占位段落三，把选区所在的段落与别的带图段落隔开。</p>
<p id="far">远处的一段，里面有图 3，在前后段落的文字范围内，但不在选区所在的块里。<img src="${IMG_OUT}" width="120" height="80" alt="远处的图"></p>
</article></body></html>`;

let r: Relay;
/** 图片请求记录：地址与是否带了 Cookie / Authorization */
let imageHits: { url: string; fromBackground: boolean; headers: Record<string, string> }[] = [];

test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());

test.beforeEach(async ({ context, serviceWorker }) => {
  await r.reset();
  imageHits = [];
  await waitSentinelRegistered(serviceWorker);
  await context.route('https://e2e.test/**', (rt) =>
    rt.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
  const img = (rt: Route) => {
    const url = rt.request().url();
    imageHits.push({
      url,
      fromBackground: rt.request().serviceWorker() !== null,
      headers: rt.request().headers(),
    });
    // 网页自己加载这张图是成功的（页面里看得到）；扩展后台去取时才被重定向到另一个主机
    if (url === IMG_REDIRECT && rt.request().serviceWorker() !== null)
      return rt.fulfill({ status: 302, headers: { location: IMG_TARGET }, body: '' });
    return rt.fulfill({ contentType: 'image/png', body: png(64, 48, [200, 40, 40]) });
  };
  await context.route('https://img.e2e.test/**', img);
  await context.route('https://cdn.other.test/**', img);
});

const withToggle = (on: boolean, conn = connection(r)) =>
  settingsWith(r, {
    connections: [conn],
    context: {
      speedSoftBudgetRatio: 0.5,
      summaryReadRatio: 0.3,
      defaultTier: 'nearby',
      includePageImages: on,
    },
  });

/** 等页面里的图都加载完（后台只取「页面已经加载出来」的图） */
const imagesLoaded = async (page: Page) => {
  try {
    await page.waitForFunction(
      () => [...document.images].every((i) => i.complete && i.naturalWidth > 0),
      null,
      {
        timeout: 8000,
      },
    );
  } catch {
    const state = await page.evaluate(() =>
      [...document.images].map((i) => `${i.src} complete=${i.complete} w=${i.naturalWidth}`),
    );
    throw new Error(
      `图没有加载出来：${state.join(' | ')}；请求 ${JSON.stringify(imageHits.map((h) => h.url))}`,
    );
  }
};

interface ImagePart {
  type: string;
  text?: string;
  image_url?: { url: string };
}
const lastContent = (body: string | undefined) =>
  (parseBody(body).messages.at(-1)?.content ?? []) as unknown as ImagePart[] | string;

async function askAbout(page: Page, sw: Parameters<typeof selectAndConvAsk>[1], selector: string) {
  await page.goto('https://e2e.test/article');
  await imagesLoaded(page);
  return selectAndConvAsk(page, sw, selector, { model: MODEL, text: '图里是什么', contextTier: 'nearby' });
}

test('开关打开：选中段落里的图进请求，计划记下地址；取图不带凭据；选区之外的图不取', async ({
  page,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, withToggle(true));
  const { res } = await askAbout(page, serviceWorker, '#with-img');
  expect(res.states.at(-1)).toBe('completed');
  const content = lastContent(r.bodies[0]);
  expect(Array.isArray(content)).toBe(true);
  const images = (content as ImagePart[]).filter((p) => p.type === 'image_url');
  expect(images).toHaveLength(1);
  expect(images[0]?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  const plan = res.plan as { imageCount: number; pageImageUrls?: string[] };
  expect(plan.imageCount).toBe(1);
  expect(plan.pageImageUrls).toEqual([IMG_IN]);
  // 图的地址只在计划里，不在发给模型的正文里
  expect(JSON.stringify(parseBody(r.bodies[0]))).not.toContain('img.e2e.test');
  // 取图请求：不带 Cookie / Authorization / 模型 Key
  const fromBg = imageHits.filter((h) => h.fromBackground);
  expect(fromBg.map((h) => h.url)).toEqual([IMG_IN]);
  for (const h of fromBg) {
    expect(h.headers.authorization).toBeUndefined();
    expect(h.headers.cookie).toBeUndefined();
    expect(JSON.stringify(h.headers)).not.toContain('e2e-fake-key');
  }
  // 选区之外的图不会被取：远处那张页面自己加载过（不算），扩展没有再去取，计划里也没有
  expect(JSON.stringify(plan)).not.toContain(IMG_OUT);
  // 发送说明：附图 1 张，展开后列出地址
  const frame = await floatFrame(page);
  await expect(frame.getByText('附图 1 张').first()).toBeVisible();
  await expect(frame.getByTestId('image-note')).toContainText('图表解析可能不完全准确');
});

test('开关关着（默认）：请求里没有图片、计划没有地址', async ({ page, serviceWorker }) => {
  await writeSettings(serviceWorker, withToggle(false));
  const { res } = await askAbout(page, serviceWorker, '#with-img');
  expect(res.states.at(-1)).toBe('completed');
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).not.toContain('image_url');
  const plan = res.plan as { imageCount: number; pageImageUrls?: string[] };
  expect(plan.imageCount).toBe(0);
  expect(plan.pageImageUrls).toBeUndefined();
});

test('图片被重定向到别的主机：不进请求，计划说明里写原因，提问照常完成', async ({ page, serviceWorker }) => {
  await writeSettings(serviceWorker, withToggle(true));
  const { res } = await askAbout(page, serviceWorker, '#with-redirect');
  expect(res.states.at(-1)).toBe('completed');
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).not.toContain('image_url');
  const plan = res.plan as { imageCount: number; notes: string[] };
  expect(plan.imageCount).toBe(0);
  expect(plan.notes.join()).toContain('重定向');
  // 扩展只请求了重定向前的地址（得到 302 即停），没有跟去目标主机
  const fromBg = imageHits.filter((h) => h.fromBackground).map((h) => h.url);
  expect(fromBg).toEqual([IMG_REDIRECT]);
});

test('视觉能力为「不支持」：开关开着也不取图，计划说明写原因', async ({ page, serviceWorker }) => {
  const conn = connection(r, { capabilityOverrides: { 'mock-flash': { vision: 'no' } } });
  await writeSettings(serviceWorker, withToggle(true, conn));
  const { res } = await askAbout(page, serviceWorker, '#with-img');
  expect(res.states.at(-1)).toBe('completed');
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).not.toContain('image_url');
  expect((res.plan as { notes: string[] }).notes.join()).toContain('不支持看图');
});
