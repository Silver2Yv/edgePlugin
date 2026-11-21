// V-13 性能与资源：一条命令跑完的测量脚本（见 README.md）。
// 产出：prototypes/v13-perf/results/v13-<时间戳>.json（原始样本 + 汇总）与同名 .md（表格）。
//
// 用法：
//   node prototypes/v13-perf/run.mjs            完整跑一遍（repeat 次数见下面 REPEATS）
//   node prototypes/v13-perf/run.mjs --quick     冒烟测试：每项只跑 1–2 次，验证脚本本身没坏
//   E2E_BROWSER=msedge node prototypes/v13-perf/run.mjs   换成本机真实 Edge（有界面）
//   E2E_CHROMIUM_PATH=/d/tmp/cft/chrome.exe node prototypes/v13-perf/run.mjs  指定 Chromium 可执行文件
//
// 前置：先在仓库根目录 pnpm install、pnpm build（产物要在 .output/chrome-mv3/，和 e2e 用的是同一份）。
//
// 已知局限（如实写在结果里，不假装测到）：
//   - Playwright/CDP 全程连着浏览器时，扩展后台不会被 30 秒空闲回收（V-01 的结论）；本脚本全程
//     用 CDP 驱动，所以「后台唤醒次数」在这条测量路径下天然测不出来，见下方 sentinel/background 小节。
//   - 预热小窗「标签页隐藏 10 分钟销毁」这条，读过 src/page/float-host.ts 源码确认没有实现，
//     本次不实现、只如实记录。
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { askFlowOnce, hideFloat } from './lib/ask-flow.mjs';
import { askViaConvPort } from './lib/conv.mjs';
import { frameToolbarOpen, waitFloatFrame, waitFloatInputVisible, waitToolbar } from './lib/dom.mjs';
import { launchWithExtension, launchWithoutExtension, MODEL_REF, settingsFor, writeSettings } from './lib/env.mjs';
import {
  enablePerf,
  gzipSizeOf,
  installLongTaskObserver,
  jsHeapUsed,
  readLongTasks,
  traceSentinelLoad,
  watchReaderInjection,
} from './lib/metrics.mjs';
import { articlePage, framePage, largePage, multiFramePage } from './lib/pages.mjs';
import { pollUntil } from './lib/poll.mjs';
import { startRelay } from './lib/relay.mjs';
import { fmt, fmtKb, fmtMb, summarize } from './lib/stats.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, 'results');
const QUICK = process.argv.includes('--quick');

const REPEATS = QUICK
  ? { baseline: 2, selectNoAsk: 2, askCold: 2, askWarm: 3, largePage: 2, multiFrame: 2, scroll: 2, longAnswer: 1 }
  : { baseline: 10, selectNoAsk: 12, askCold: 10, askWarm: 15, largePage: 8, multiFrame: 8, scroll: 6, longAnswer: 5 };
const TAB_COUNT = QUICK ? 5 : 30;

const SITE = 'https://v13.test';
const log = (...a) => console.log(`[v13-perf]`, ...a);

function setupRoutes(context) {
  const hosts = ['v13-frame-a.test', 'v13-frame-b.test'];
  // 只拦截本脚本自己用到的几个合成域名，不用全局通配符——避免连带拦截模拟中转站（127.0.0.1）
  // 或后台 Service Worker 发出的其它请求（context.route 对扩展后台的 fetch 也生效）
  return Promise.all([
    context.route('https://v13.test/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/article') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: articlePage() });
      if (url.pathname === '/large') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: largePage(2000) });
      if (url.pathname === '/multiframe')
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: multiFramePage(4, hosts) });
      if (url.pathname.startsWith('/frame-same-'))
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: framePage('同源子框架') });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: articlePage() });
    }),
    ...hosts.map((host) =>
      context.route(`https://${host}/**`, (route) =>
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: framePage(`跨源子框架（${host}）`) }),
      ),
    ),
  ]);
}

async function sampleHeap(context, pageOrFrame) {
  try {
    const cdp = await context.newCDPSession(pageOrFrame);
    await enablePerf(cdp);
    const v = await jsHeapUsed(cdp);
    await cdp.detach().catch(() => undefined);
    return v;
  } catch {
    return undefined;
  }
}

// ───────────────────────── 场景 A：基线对照（禁用 / 启用），空闲页不抽取 ─────────────────────────
async function scenarioBaseline(enabledCtx, disabledCtx) {
  const out = { enabled: { heap: [], longtaskCount: [], longtaskTotalMs: [], readerInjected: [] }, disabled: { heap: [], longtaskCount: [], longtaskTotalMs: [] } };
  for (let i = 0; i < REPEATS.baseline; i++) {
    const page = await enabledCtx.newPage();
    const cdp = await enabledCtx.newCDPSession(page);
    const watcher = await watchReaderInjection(cdp);
    await enablePerf(cdp);
    await page.goto(`${SITE}/article`, { waitUntil: 'load' });
    await page.evaluate(() => { window.__v13LongTasks = []; });
    await page.waitForTimeout(2000);
    out.enabled.heap.push(await jsHeapUsed(cdp).catch(() => undefined));
    const lt = await readLongTasks(page);
    out.enabled.longtaskCount.push(lt.tasks.length);
    out.enabled.longtaskTotalMs.push(lt.tasks.reduce((a, b) => a + b.dur, 0));
    out.enabled.readerInjected.push(watcher.injected());
    await cdp.detach().catch(() => undefined);
    await page.close();
  }
  for (let i = 0; i < REPEATS.baseline; i++) {
    const page = await disabledCtx.newPage();
    await page.goto(`${SITE}/article`, { waitUntil: 'load' });
    await page.evaluate(() => { window.__v13LongTasks = []; });
    await page.waitForTimeout(2000);
    out.disabled.heap.push(await sampleHeap(disabledCtx, page));
    const lt = await readLongTasks(page);
    out.disabled.longtaskCount.push(lt.tasks.length);
    out.disabled.longtaskTotalMs.push(lt.tasks.reduce((a, b) => a + b.dur, 0));
    await page.close();
  }
  return out;
}

// ───────────────────────── 场景 B：划词未点击——不调用模型（mouseup→工具栏延迟顺带测） ─────────────────────────
async function scenarioSelectNoAsk(ctx, relay) {
  const toolbarMs = [];
  const readerInjected = [];
  let requestsBefore;
  for (let i = 0; i < REPEATS.selectNoAsk; i++) {
    const page = await ctx.newPage();
    await page.goto(`${SITE}/article`, { waitUntil: 'load' });
    const cdp = await ctx.newCDPSession(page);
    const watcher = await watchReaderInjection(cdp);
    requestsBefore = relay.requests.length;
    const t0 = Date.now();
    await page.locator('#target').click({ clickCount: 3 });
    const { ms } = await waitToolbar(cdp, 5000, t0);
    toolbarMs.push(ms);
    await page.waitForTimeout(1500); // 给预热、可能的空闲抽取留够时间
    readerInjected.push(watcher.injected());
    await cdp.detach().catch(() => undefined);
    await page.close();
  }
  return { toolbarMs, readerInjected, modelCallsDuringScenario: relay.requests.length - (requestsBefore ?? 0) };
}

// ───────────────────────── 场景 C/D/E：冷/暖启动小窗、大页面、多框架 ─────────────────────────
async function scenarioAskFlow(ctx, relay, { url = `${SITE}/article`, label }) {
  const cold = [];
  const warm = [];

  for (let i = 0; i < REPEATS.askCold; i++) {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const cdp = await ctx.newCDPSession(page);
    const r = await askFlowOnce(page, cdp, relay);
    cold.push({ toolbarMs: r.toolbarMs, floatFrameMs: r.floatFrameMs, inputVisibleMs: r.inputVisibleMs, requestSentMs: r.requestSentMs, firstContentMs: r.firstContentMs, totalMs: r.totalMs, finalState: r.finalState });
    await cdp.detach().catch(() => undefined);
    await page.close();
  }

  // 暖态：同一页面上反复 收起→重选→问
  {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });
    const cdp = await ctx.newCDPSession(page);
    // 先跑一次把小窗预热/握手跑热，再开始计数（这一次不计入 warm 样本）
    await askFlowOnce(page, cdp, relay);
    for (let i = 0; i < REPEATS.askWarm; i++) {
      await hideFloat(page);
      await page.waitForTimeout(150);
      const r = await askFlowOnce(page, cdp, relay, { question: `V-13 暖态第 ${i} 次` });
      warm.push({ toolbarMs: r.toolbarMs, floatFrameMs: r.floatFrameMs, inputVisibleMs: r.inputVisibleMs, requestSentMs: r.requestSentMs, firstContentMs: r.firstContentMs, totalMs: r.totalMs, finalState: r.finalState });
    }
    await cdp.detach().catch(() => undefined);
    await page.close();
  }

  log(`ask-flow[${label}] 冷态 ${cold.length} 次、暖态 ${warm.length} 次完成`);
  return { cold, warm };
}

// ───────────────────────── 场景 F：多框架——子框架里独立选中也能弹工具栏 ─────────────────────────
async function scenarioMultiFrameSubToolbar(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${SITE}/multiframe`, { waitUntil: 'load' });
  const inner = page.frames().find((f) => f.url().includes('frame-same-0'));
  let opened = false;
  if (inner) {
    await page.frameLocator('iframe').nth(0).locator('#inner').click({ clickCount: 3 });
    await page.waitForTimeout(500);
    opened = await frameToolbarOpen(inner).catch(() => false);
  }
  await page.close();
  return { subFrameToolbarOpened: opened };
}

// ───────────────────────── 场景 G：连续滚动——longtask 对照 ─────────────────────────
async function scenarioScroll(ctx, url, label) {
  const samples = [];
  for (let i = 0; i < REPEATS.scroll; i++) {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__v13LongTasks = []; });
    const start = Date.now();
    for (let s = 0; s < 20; s++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(80);
    }
    const scrollMs = Date.now() - start;
    const lt = await readLongTasks(page);
    samples.push({ scrollMs, longtaskCount: lt.tasks.length, longtaskTotalMs: lt.tasks.reduce((a, b) => a + b.dur, 0) });
    await page.close();
  }
  log(`scroll[${label}] ${samples.length} 次完成`);
  return samples;
}

// ───────────────────────── 场景 H：长回答——首个有用回答时间、跨消息字节、内存峰值与回落 ─────────────────────────
async function scenarioLongAnswer(ctx, serviceWorker) {
  const relayLong = await startRelay({ scale: 0.03 }); // 330s * 0.03 ≈ 10s，可控时长
  await writeSettings(serviceWorker, settingsFor(relayLong.relay.url, 'long'));
  const samples = [];
  for (let i = 0; i < REPEATS.longAnswer; i++) {
    const page = await ctx.newPage();
    await page.goto(`${SITE}/article`, { waitUntil: 'load' });
    const cdp = await ctx.newCDPSession(page);
    await page.locator('#target').click({ clickCount: 3 });
    const { center } = await waitToolbar(cdp, 5000);
    await page.mouse.click(center.x, center.y);
    const frameInfo = await waitFloatFrame(page, 8000);
    const frame = frameInfo.frame;
    await waitFloatInputVisible(frame, 8000);

    const heapBefore = await sampleHeap(ctx, page);
    const resultPromise = askViaConvPort(frame, { model: MODEL_REF }, 30_000);
    // 流式进行中采两次心跳
    await page.waitForTimeout(2000);
    const heapMid1 = await sampleHeap(ctx, page);
    await page.waitForTimeout(3000);
    const heapMid2 = await sampleHeap(ctx, page);
    const result = await resultPromise;
    const heapAfter = await sampleHeap(ctx, page);
    await page.waitForTimeout(2000);
    const heapRecovered = await sampleHeap(ctx, page);

    const totalBytes = result.events.reduce((a, e) => a + e.bytes, 0);
    const firstContentMs =
      result.firstTextDeltaAtMs !== undefined && result.askSentAtMs !== undefined
        ? result.firstTextDeltaAtMs - result.askSentAtMs
        : undefined;
    samples.push({
      firstContentMs,
      finalState: result.finalState,
      messageCount: result.events.length,
      totalBytes,
      heapBefore,
      heapMid1,
      heapMid2,
      heapAfter,
      heapRecovered,
    });
    await cdp.detach().catch(() => undefined);
    await page.close();
  }
  await relayLong.close();
  log(`long-answer ${samples.length} 次完成`);
  return samples;
}

// ───────────────────────── 场景 I：30 个标签页分别使用后隐藏 ─────────────────────────
async function scenarioThirtyTabs(ctx, relay, serviceWorker) {
  const epochBefore = await serviceWorker
    .evaluate(() => chrome.storage.session.get('workerEpoch').then((r) => r.workerEpoch))
    .catch(() => undefined);
  const pages = [];
  for (let i = 0; i < TAB_COUNT; i++) {
    const page = await ctx.newPage();
    await page.bringToFront();
    await page.goto(`${SITE}/article`, { waitUntil: 'load' });
    const cdp = await ctx.newCDPSession(page);
    const r = await askFlowOnce(page, cdp, relay, { question: `V-13 第 ${i} 个标签页` });
    await cdp.detach().catch(() => undefined);
    const floatFrameCount = page.frames().filter((f) => {
      try {
        return new URL(f.url()).pathname === '/float.html';
      } catch {
        return false;
      }
    }).length;
    pages.push({ page, totalMs: r.totalMs, floatFrameCount });
  }
  // 全部留在后台（已经不是 active 标签页），采一次总内存
  let totalHeap = 0;
  let measured = 0;
  for (const { page } of pages) {
    const h = await sampleHeap(ctx, page);
    if (typeof h === 'number') {
      totalHeap += h;
      measured++;
    }
  }
  const epochAfter = await serviceWorker
    .evaluate(() => chrome.storage.session.get('workerEpoch').then((r) => r.workerEpoch))
    .catch(() => undefined);
  for (const { page } of pages) await page.close();
  return {
    tabCount: TAB_COUNT,
    perTabFloatFrameCount: pages.map((p) => p.floatFrameCount),
    maxFloatFrameCountPerTab: Math.max(...pages.map((p) => p.floatFrameCount)),
    totalHeapBytes: totalHeap,
    heapMeasuredTabs: measured,
    workerEpochBefore: epochBefore,
    workerEpochAfter: epochAfter,
    workerEpochChanged: epochBefore !== epochAfter,
  };
}

function envInfo(browserVersionEnabled, browserVersionDisabled) {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: resolve(__dirname, '..', '..') }).toString().trim();
  } catch {
    /* ignore */
  }
  return {
    at: new Date().toISOString(),
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: `${cpus()[0]?.model ?? 'unknown'} x${cpus().length}`,
    totalMemGB: (totalmem() / 1024 / 1024 / 1024).toFixed(1),
    browser: process.env.E2E_BROWSER === 'msedge' ? 'Microsoft Edge（真实窗口）' : 'Chrome for Testing（headless）',
    browserVersionEnabled,
    browserVersionDisabled,
    chromiumPathOverride: process.env.E2E_CHROMIUM_PATH || undefined,
    commit,
    quick: QUICK,
    note: '本机同时有另外两个代理在跑 e2e，存在并发负载；以下数字标「并发负载下的试跑」，不是独占机器的洁净基线。',
  };
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  log('启动模拟中转站（主，ok 模式）……');
  const relay = await startRelay();

  log('启动带扩展的持久化上下文……');
  const { context: enabledCtx, serviceWorker, browserVersion: bvEnabled } = await launchWithExtension();
  await installLongTaskObserver(enabledCtx);
  await setupRoutes(enabledCtx);
  await writeSettings(serviceWorker, settingsFor(relay.relay.url, 'ok'));

  log('启动不带扩展的对照上下文……');
  const { context: disabledCtx, browserVersion: bvDisabled } = await launchWithoutExtension();
  await installLongTaskObserver(disabledCtx);
  await setupRoutes(disabledCtx);

  const results = { env: envInfo(bvEnabled, bvDisabled), repeats: REPEATS, tabCount: TAB_COUNT, scenarios: {} };

  // 包体积（不需要浏览器）
  results.scenarios.bundleSize = {
    sentinelGzipBytes: gzipSizeOf('content-scripts/sentinel.js'),
    readerGzipBytes: gzipSizeOf('content-scripts/reader.js'),
    floatGzipBytes: gzipSizeOf('chunks/float-DkWBX9AK.js'),
    backgroundGzipBytes: gzipSizeOf('background.js'),
  };

  log('场景：哨兵加载期主线程耗时（CDP Tracing）……');
  {
    const page = await enabledCtx.newPage();
    const r = await traceSentinelLoad(enabledCtx, page, `${SITE}/article`);
    results.scenarios.sentinelLoad = r;
    await page.close();
  }

  log('场景：基线对照（禁用/启用） + 空闲页不抽取……');
  results.scenarios.baseline = await scenarioBaseline(enabledCtx, disabledCtx);

  log('场景：划词未点击，不调用模型……');
  results.scenarios.selectNoAsk = await scenarioSelectNoAsk(enabledCtx, relay);

  log('场景：冷/暖启动小窗（普通文章）……');
  results.scenarios.askFlowArticle = await scenarioAskFlow(enabledCtx, relay, { url: `${SITE}/article`, label: '普通文章' });

  log('场景：大页面……');
  results.scenarios.askFlowLargePage = await scenarioAskFlow(enabledCtx, relay, { url: `${SITE}/large`, label: '大页面' });

  log('场景：多框架……');
  results.scenarios.askFlowMultiFrame = await scenarioAskFlow(enabledCtx, relay, { url: `${SITE}/multiframe`, label: '多框架' });
  results.scenarios.multiFrameSubToolbar = await scenarioMultiFrameSubToolbar(enabledCtx);

  log('场景：连续滚动（大页面，启用/禁用对照）……');
  results.scenarios.scrollEnabled = await scenarioScroll(enabledCtx, `${SITE}/large`, '启用');
  results.scenarios.scrollDisabled = await scenarioScroll(disabledCtx, `${SITE}/large`, '禁用');

  log('场景：长回答……');
  results.scenarios.longAnswer = await scenarioLongAnswer(enabledCtx, serviceWorker);

  // 跑完长回答后把设置切回主 relay（ok 模式），再做 30 标签页场景
  await writeSettings(serviceWorker, settingsFor(relay.relay.url, 'ok'));

  log(`场景：${TAB_COUNT} 个标签页分别使用后隐藏……`);
  results.scenarios.thirtyTabs = await scenarioThirtyTabs(enabledCtx, relay, serviceWorker);

  results.scenarios.backgroundWake = {
    measurable: false,
    reason:
      'Playwright/CDP 全程连着浏览器时后台不会被 30 秒空闲回收（V-01 已证实）；本脚本全程用 CDP 驱动各场景，workerEpoch 预期全程不变，见 thirtyTabs.workerEpochChanged（应为 false，不代表后台没被唤醒过，而是这条测量路径下测不出来）。要测真实唤醒次数需要 V-01 的「分离子进程」方法，但那样就不能用同一个 Playwright 连接驱动 30 个标签页的交互，本次未做，留给专门的后台生命周期验证（V-01）。',
  };

  await enabledCtx.close();
  await disabledCtx.close();
  await relay.close();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(resolve(RESULTS_DIR, `v13-${stamp}.json`), JSON.stringify(results, null, 2));
  writeFileSync(resolve(RESULTS_DIR, 'latest.json'), JSON.stringify(results, null, 2));
  const md = renderMarkdown(results);
  writeFileSync(resolve(RESULTS_DIR, `v13-${stamp}.md`), md);
  writeFileSync(resolve(RESULTS_DIR, 'latest.md'), md);
  log(`完成。结果：prototypes/v13-perf/results/v13-${stamp}.{json,md}（以及 latest.*）`);
}

function row(label, s, unit = 'ms') {
  if (!s || s.n === 0) return `| ${label} | - | - | - | - | 0 |`;
  return `| ${label} | ${fmt(s.p50)} ${unit} | ${fmt(s.p95)} ${unit} | ${fmt(s.mean)} ${unit} | ${fmt(s.min)}–${fmt(s.max)} ${unit} | ${s.n} |`;
}

function renderMarkdown(r) {
  const b = r.scenarios.baseline;
  const sel = r.scenarios.selectNoAsk;
  const art = r.scenarios.askFlowArticle;
  const large = r.scenarios.askFlowLargePage;
  const multi = r.scenarios.askFlowMultiFrame;
  const scrollE = r.scenarios.scrollEnabled;
  const scrollD = r.scenarios.scrollDisabled;
  const long = r.scenarios.longAnswer;
  const tabs = r.scenarios.thirtyTabs;
  const bundle = r.scenarios.bundleSize;

  const pick = (arr, key) => arr.map((x) => x[key]);
  const lines = [];
  lines.push(`# V-13 性能基线（原始数据，${r.env.quick ? '冒烟测试' : '正式试跑'}）`);
  lines.push('');
  lines.push(`生成时间：${r.env.at}　commit：${r.env.commit}`);
  lines.push('');
  lines.push(`> ${r.env.note}`);
  lines.push('');
  lines.push('## 环境');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 操作系统 | ${r.env.os} |`);
  lines.push(`| CPU | ${r.env.cpu} |`);
  lines.push(`| 内存 | ${r.env.totalMemGB} GB |`);
  lines.push(`| 浏览器 | ${r.env.browser}，enabled=${r.env.browserVersionEnabled}，disabled=${r.env.browserVersionDisabled} |`);
  lines.push(`| Node | ${r.env.node} |`);
  lines.push(`| Chromium 可执行文件覆盖 | ${r.env.chromiumPathOverride ?? '（默认 Playwright 渠道）'} |`);
  lines.push('');

  lines.push('## 包体积（5.15）');
  lines.push('');
  lines.push('| 文件 | gzip | 初值 | 结论 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(`| 哨兵 sentinel.js | ${fmtKb(bundle.sentinelGzipBytes)} | ≤ 10 KB | ${bundle.sentinelGzipBytes / 1024 <= 10 ? '通过' : '未达标'} |`);
  lines.push(`| 阅读器 reader.js | ${fmtKb(bundle.readerGzipBytes)} | ≤ 50 KB | ${bundle.readerGzipBytes / 1024 <= 50 ? '通过' : '未达标'} |`);
  lines.push(`| 小窗首屏 float 包 | ${fmtKb(bundle.floatGzipBytes)} | ≤ 100 KB | ${bundle.floatGzipBytes / 1024 <= 100 ? '通过' : '未达标'} |`);
  lines.push(`| 后台 background.js | ${fmtKb(bundle.backgroundGzipBytes)} | （无初值） | - |`);
  lines.push('');

  lines.push('## 哨兵加载期主线程耗时（5.15 初值 < 5 ms）');
  lines.push('');
  lines.push(`CDP Tracing 抓到与 sentinel.js 相关的脚本执行事件共 ${r.scenarios.sentinelLoad.matchedEvents} 条（trace 总事件 ${r.scenarios.sentinelLoad.totalEvents} 条），耗时合计 ${fmt(r.scenarios.sentinelLoad.ms, 2)} ms。`);
  lines.push('');

  lines.push('## 基线对照：扩展禁用 / 启用（空闲页，2 秒窗口）');
  lines.push('');
  lines.push('| | JS 堆（启用） | JS 堆（禁用） | longtask 数（启用） | longtask 数（禁用） |');
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push(`| p50/p95 | ${fmtMb(summarize(b.enabled.heap).p50)} / ${fmtMb(summarize(b.enabled.heap).p95)} | ${fmtMb(summarize(b.disabled.heap).p50)} / ${fmtMb(summarize(b.disabled.heap).p95)} | ${fmt(summarize(b.enabled.longtaskCount).mean, 2)} | ${fmt(summarize(b.disabled.longtaskCount).mean, 2)} |`);
  lines.push('');
  lines.push(`空闲页「阅读器被注入」检查：${b.enabled.readerInjected.every((x) => x === false) ? `通过——${b.enabled.readerInjected.length} 次全部未注入` : `未达标——${b.enabled.readerInjected.filter(Boolean).length}/${b.enabled.readerInjected.length} 次被注入`}`);
  lines.push('');

  lines.push('## 划词未点击：mouseup→工具栏 延迟 + 不调用模型');
  lines.push('');
  lines.push('| 指标 | p50 | p95 | mean | min–max | n |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  lines.push(row('mouseup→工具栏（5.15 初值 ≤ 100ms）', summarize(sel.toolbarMs)));
  lines.push('');
  lines.push(`期间模型调用次数：${sel.modelCallsDuringScenario}（期望 0）`);
  lines.push('');

  for (const [name, data] of [
    ['普通文章', art],
    ['大页面', large],
    ['多框架', multi],
  ]) {
    lines.push(`## 冷/暖启动小窗：${name}`);
    lines.push('');
    lines.push('| 指标（冷态） | p50 | p95 | mean | min–max | n |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    lines.push(row('点「问」→小窗可见（冷态）', summarize(pick(data.cold, 'inputVisibleMs'))));
    lines.push(row('点击→请求发出', summarize(pick(data.cold, 'requestSentMs'))));
    lines.push(row('点击→首个有用回答', summarize(pick(data.cold, 'firstContentMs'))));
    lines.push('');
    lines.push('| 指标（暖态，5.15 初值 ≤ 200ms） | p50 | p95 | mean | min–max | n |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    lines.push(row('点「问」→小窗可见（暖态）', summarize(pick(data.warm, 'inputVisibleMs'))));
    lines.push(row('点击→请求发出（5.15 初值 ≤ 300ms）', summarize(pick(data.warm, 'requestSentMs'))));
    lines.push(row('点击→首个有用回答', summarize(pick(data.warm, 'firstContentMs'))));
    lines.push('');
  }

  lines.push('## 多框架：子框架内独立选中');
  lines.push('');
  lines.push(`子框架（同源）里三击选中后，工具栏在该子框架内出现：${r.scenarios.multiFrameSubToolbar.subFrameToolbarOpened ? '是' : '否'}`);
  lines.push('');

  lines.push('## 连续滚动：longtask 对照（启用 / 禁用）');
  lines.push('');
  lines.push('| | longtask 数 mean | longtask 总时长 mean (ms) |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 启用 | ${fmt(summarize(pick(scrollE, 'longtaskCount')).mean, 2)} | ${fmt(summarize(pick(scrollE, 'longtaskTotalMs')).mean, 1)} |`);
  lines.push(`| 禁用 | ${fmt(summarize(pick(scrollD, 'longtaskCount')).mean, 2)} | ${fmt(summarize(pick(scrollD, 'longtaskTotalMs')).mean, 1)} |`);
  lines.push('');

  lines.push('## 长回答：首个有用回答时间、跨消息字节、内存峰值与回落');
  lines.push('');
  lines.push(row('首个有用回答（conv/delta 首个含 text）', summarize(pick(long, 'firstContentMs'))));
  lines.push('');
  lines.push(`单次任务消息数 mean：${fmt(summarize(pick(long, 'messageCount')).mean, 1)}　单次任务字节数（background→float，conv 端口）mean：${fmtKb(summarize(pick(long, 'totalBytes')).mean)}`);
  lines.push('');
  lines.push('| | before | mid1(+2s) | mid2(+5s) | after | +2s 回落 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  lines.push(`| JS 堆 mean | ${fmtMb(summarize(pick(long, 'heapBefore')).mean)} | ${fmtMb(summarize(pick(long, 'heapMid1')).mean)} | ${fmtMb(summarize(pick(long, 'heapMid2')).mean)} | ${fmtMb(summarize(pick(long, 'heapAfter')).mean)} | ${fmtMb(summarize(pick(long, 'heapRecovered')).mean)} |`);
  lines.push('');

  lines.push(`## ${r.tabCount} 个标签页分别使用后隐藏`);
  lines.push('');
  lines.push(`每标签页隐藏小窗 iframe 数上限：${tabs.maxFloatFrameCountPerTab}（预算 ≤ 1／标签页，见 5.15）`);
  lines.push('');
  lines.push(`隐藏期间总 JS 堆（${tabs.heapMeasuredTabs}/${tabs.tabCount} 个标签页可测）：${fmtMb(tabs.totalHeapBytes)}`);
  lines.push('');
  lines.push(`workerEpoch：使用前 ${tabs.workerEpochBefore}，使用完 ${tabs.workerEpochAfter}（变化：${tabs.workerEpochChanged ? '是' : '否——CDP 常驻导致后台未被回收，见下）'}`);
  lines.push('');

  lines.push('## 后台唤醒次数');
  lines.push('');
  lines.push(`无法测量——${r.scenarios.backgroundWake.reason}`);
  lines.push('');

  return lines.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
