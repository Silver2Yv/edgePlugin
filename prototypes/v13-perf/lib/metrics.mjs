// CDP / Performance 测量小工具：JS 堆大小、longtask 收集（PerformanceObserver，注入进页面，
// 不改产品代码，和 e2e 测试里用 CDP 读 DOM 是同一类做法）、阅读器是否被注入过（用 CDP Debugger
// 域看有没有解析过 reader.js，不读取任何对话内容）、产物 gzip 体积、哨兵加载期主线程耗时（CDP Tracing）。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { EXTENSION_PATH } from './env.mjs';

/** 当前 JS 堆已用字节数（Performance.getMetrics，需要先 Performance.enable） */
export async function jsHeapUsed(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'JSHeapUsedSize')?.value;
}

export async function enablePerf(cdp) {
  await cdp.send('Performance.enable');
}

/**
 * 在页面里挂一个 PerformanceObserver('longtask')，通过 addInitScript 注入（每个新文档加载前执行，
 * 在扩展的内容脚本之外，不读写扩展相关 DOM，只用标准 Web API）。调用方负责在合适时机读取
 * window.__v13LongTasks 并清空。
 */
export async function installLongTaskObserver(contextOrPage) {
  await contextOrPage.addInitScript(() => {
    const w = window;
    w.__v13LongTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__v13LongTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      w.__v13LongTasksUnsupported = true;
    }
  });
}

export const readLongTasks = (page) =>
  page.evaluate(() => ({
    tasks: window.__v13LongTasks ?? [],
    unsupported: window.__v13LongTasksUnsupported === true,
  }));

/**
 * 阅读器是否被注入过。
 *
 * 踩过的坑：最初想法是读阅读器用 Symbol.for('readingAssistant.readerInjected') 在 globalThis 上
 * 留的幂等标记（src/page/reader.ts），指望 page.evaluate 能读到。实测发现读到的永远是 false，
 * 查证后发现这个想法有误：内容脚本跑在扩展专属的「隔离世界」，与 page.evaluate 所在的主世界是
 * 两个不同的 globalThis 对象实例（哪怕 Symbol.for 的注册表按进程共享，`g[INJECTED] = true`
 * 这句写的是隔离世界自己那个 globalThis 的属性，主世界读不到）——这不是产品代码的问题，是本脚本
 * 最初的检测手法本身选错了，必须老实改掉，不能将错就错凑数字。
 *
 * 改用 CDP Debugger 域：扩展内容脚本（哨兵、阅读器）被注入执行时，渲染进程照样会产生
 * Debugger.scriptParsed 事件，url 就是对应的 chrome-extension://<id>/content-scripts/reader.js，
 * 这是跨世界都能看到的、渲染进程级别的真实信号，不依赖 JS 全局对象是否共享。
 *
 * 用法：在 goto 之前（或者至少在「阅读器可能被注入」的动作之前）调用 watchReaderInjection(cdp)
 * 并保持同一个 cdp 会话存活到观察窗口结束，再调用返回对象的 injected()。
 */
export async function watchReaderInjection(cdp) {
  const urls = new Set();
  cdp.on('Debugger.scriptParsed', (e) => {
    if (e.url) urls.add(e.url);
  });
  await cdp.send('Debugger.enable');
  return {
    injected: () => [...urls].some((u) => u.includes('content-scripts/reader.js')),
    urls: () => [...urls],
  };
}

/** 产物 gzip 体积（字节） */
export function gzipSizeOf(relFile) {
  const p = join(EXTENSION_PATH, relFile);
  if (!existsSync(p)) return undefined;
  return gzipSync(readFileSync(p), { level: 9 }).length;
}

/**
 * 某个扩展页面首屏要加载的脚本合计 gzip 体积：入口脚本 + 所有 modulepreload 的 chunk（各自 gzip 后相加）。
 * 从产物的 html 里读，不写死带构建哈希的文件名；共享 chunk（小窗与侧边栏共用的渲染代码）也算在内
 */
export function pageScriptsGzip(htmlFile) {
  const html = readFileSync(join(EXTENSION_PATH, htmlFile), 'utf8');
  const files = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="\/([^"]+\.js)"/g)].map((m) => m[1]);
  return { files, bytes: files.reduce((n, f) => n + (gzipSizeOf(f) ?? 0), 0) };
}

/**
 * 哨兵加载期主线程耗时：用 CDP Tracing 抓一次页面导航前后的 trace，把名字/参数里提到
 * sentinel.js 的完整事件（ph: 'X'，有 dur）耗时加总。只在这一条专门的测量里用，
 * 其余场景不开 Tracing（有性能与体积开销）。
 */
export async function traceSentinelLoad(context, page, url) {
  const client = await context.newCDPSession(page);
  const events = [];
  client.on('Tracing.dataCollected', (e) => events.push(...(e.value ?? [])));
  await client.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline',
    transferMode: 'ReportEvents',
  });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(300); // 等哨兵的 document_idle 注入与初次执行落在 trace 里
  const done = new Promise((r) => client.once('Tracing.tracingComplete', r));
  await client.send('Tracing.end');
  await done;
  await client.detach().catch(() => undefined);
  let totalUs = 0;
  let matched = 0;
  for (const e of events) {
    const hay = JSON.stringify(e);
    if (!hay.includes('sentinel.js')) continue;
    if (e.ph === 'X' && typeof e.dur === 'number') {
      totalUs += e.dur;
      matched++;
    }
  }
  return { ms: totalUs / 1000, matchedEvents: matched, totalEvents: events.length };
}
