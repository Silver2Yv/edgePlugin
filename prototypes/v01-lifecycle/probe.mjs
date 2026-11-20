// V-01 真实生命周期探针（prototypes/v01-lifecycle）：验证「Playwright 调试协议常驻连着后台时，
// 后台不会被空闲回收」这件事本身（net-probe/RESULT.md 的局限），以及后台在真正无人盯着时，
// 能不能撑过 5 分钟的长任务。
//
// 方法：不用 playwright 的 launch()/launchPersistentContext()（那样会让 Playwright 的调试协议
// 全程连着浏览器）。改成自己用 child_process 起一个分离的（detached + unref）Chrome 子进程，
// 开着 --remote-debugging-port；脚本做完一次操作就直接退出（不调用 browser.close()，也不等待），
// Node 进程彻底退出、调试协议的 WebSocket 自然断开，Chrome 进程本身继续独立运行、不受影响。
// 过一段时间再起一个全新的 Node 进程，用 chromium.connectOverCDP 重新接上同一个端口，检查结果。
//
// 用法：
//   node prototypes/v01-lifecycle/probe.mjs control-launch   （控制实验：起浏览器，记下当前 workerEpoch）
//   node prototypes/v01-lifecycle/probe.mjs control-check     （等了一段时间后重新接上，唤醒后台，看 epoch 是否变了）
//   node prototypes/v01-lifecycle/probe.mjs long-launch        （起浏览器，划词问一个 long 模式的问题，立刻退出）
//   node prototypes/v01-lifecycle/probe.mjs long-check          （重新接上，读热副本里的任务状态）
//   node prototypes/v01-lifecycle/probe.mjs cleanup              （杀掉浏览器进程、删临时目录）
//
// 环境变量 PROBE_CHROME_PATH 可指定 Chrome/Edge 可执行文件路径（默认用任务里给的 CfT 路径）。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const EXTENSION_PATH = resolve(ROOT, '.output', 'chrome-mv3');
const EXTENSION_ID = 'pkahgpgifechjgdpecaebajnocgcnnnd';
const CHROME_PATH = process.env.PROBE_CHROME_PATH ?? 'D:/tmp/cft/chrome.exe';
const STATE_DIR = resolve(tmpdir(), 'v01-lifecycle-probe');
const STATE_FILE = resolve(STATE_DIR, 'state.json');
const PORT = 19741;
const ARTICLE_PORT = 19742;

const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>探针测试文章</title></head>
<body><article>
<h1>探针测试文章</h1>
<p>第一段：这是一篇用来做生命周期探针测试的文章。</p>
<p id="target">${PARAGRAPH}</p>
<p>第三段：选中上面那段文字，点工具栏里的「问」。</p>
</article></body></html>`;

function readState() {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}
function writeState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function waitForCdp(port, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {
      // 还没起来
    }
    if (Date.now() > end) throw new Error('CDP 一直没就绪');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 起一个分离的浏览器子进程：Node 脚本退出后它继续独立运行，不受影响 */
function spawnBrowser(userDataDir) {
  const headless = process.env.PROBE_HEADLESS !== '0';
  const child = spawn(
    CHROME_PATH,
    [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${PORT}`,
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(headless ? ['--headless=new'] : []),
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  return child.pid;
}

// ───────────── 工具栏/小窗操作（搬自 tests/e2e 的同款辅助函数，去掉了 TS 类型标注） ─────────────

function findByLabel(node, label) {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === 'aria-label' && attrs[i + 1] === label) return node;
  }
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const hit = findByLabel(child, label);
    if (hit) return hit;
  }
  return node.contentDocument ? findByLabel(node.contentDocument, label) : undefined;
}

async function clickToolbarButton(cdp, page, label) {
  let center;
  const end = Date.now() + 10_000;
  for (;;) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = findByLabel(root, label);
    if (node) {
      try {
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
        const q = model.content;
        center = { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
        if (model.width > 0 && model.height > 0) break;
      } catch {
        // 还没渲染出来
      }
    }
    if (Date.now() > end) throw new Error(`工具栏按钮「${label}」一直没出现`);
    await new Promise((r) => setTimeout(r, 100));
  }
  await page.mouse.click(center.x, center.y);
}

const isFloat = (f) => {
  try {
    return new URL(f.url()).pathname === '/float.html';
  } catch {
    return false;
  }
};

async function floatFrame(page) {
  const end = Date.now() + 10_000;
  for (;;) {
    const f = page.frames().find(isFloat);
    if (f) return f;
    if (Date.now() > end) throw new Error('小窗 iframe 一直没出现');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function selectAndAsk(page, question) {
  await page.locator('#target').click({ clickCount: 3 });
  const cdp = await page.context().newCDPSession(page);
  await clickToolbarButton(cdp, page, '问');
  await cdp.detach();
  const frame = await floatFrame(page);
  const input = frame.getByLabel('输入问题');
  await input.waitFor();
  await frame.page().keyboard.type(question);
  await frame.page().keyboard.press('Enter');
  return frame;
}

async function setupArticlePage(context, baseUrl) {
  const page = await context.newPage();
  await page.route(`${baseUrl}/**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
  await page.goto(`${baseUrl}/article`);
  return page;
}

async function writeSettings(sw, connBaseUrl) {
  await sw.evaluate(
    ({ baseUrl }) => {
      const conn = {
        id: 'probe-conn-0001',
        name: '探针连接',
        preset: 'custom',
        baseUrl,
        apiKey: 'probe-fake-key',
        headers: {},
        interfaceType: 'chatCompletions',
        stream: true,
        extraParams: {},
        configVersion: 1,
      };
      const defaults = {
        connections: [],
        defaultModel: undefined,
        reply: { lengthTier: 'normal', thinking: 'off', language: 'auto' },
        context: {},
      };
      return chrome.storage.local.set({
        settings: { ...defaults, connections: [conn], defaultModel: { connectionId: conn.id, model: 'mock-flash' } },
      });
    },
    { baseUrl: connBaseUrl },
  );
}

async function main() {
  const phase = process.argv[2];

  if (phase === 'control-launch') {
    mkdirSync(STATE_DIR, { recursive: true });
    const userDataDir = resolve(STATE_DIR, 'profile-control');
    rmSync(userDataDir, { recursive: true, force: true });
    const pid = spawnBrowser(userDataDir);
    await waitForCdp(PORT);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    const epoch = await page.evaluate(() => chrome.storage.session.get('workerEpoch').then((r) => r.workerEpoch));
    writeState({ pid, userDataDir, epoch, startedAt: Date.now() });
    console.log(JSON.stringify({ phase, pid, epochBefore: epoch }));
    process.exit(0);
  }

  if (phase === 'control-check') {
    const state = readState();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    if (page.url().indexOf(EXTENSION_ID) === -1) await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    // 先用一次扩展接口调用唤醒后台（如果它已经被回收的话），再读当前 epoch
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'settings/ensureLocked' }));
    const epochAfter = await page.evaluate(() =>
      chrome.storage.session.get('workerEpoch').then((r) => r.workerEpoch),
    );
    const idleSeconds = Math.round((Date.now() - state.startedAt) / 1000);
    console.log(
      JSON.stringify({ phase, idleSeconds, epochBefore: state.epoch, epochAfter, reclaimed: epochAfter !== state.epoch }),
    );
    process.exit(0);
  }

  if (phase === 'long-launch') {
    mkdirSync(STATE_DIR, { recursive: true });
    const userDataDir = resolve(STATE_DIR, 'profile-long');
    rmSync(userDataDir, { recursive: true, force: true });
    const pid = spawnBrowser(userDataDir);
    await waitForCdp(PORT);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const context = browser.contexts()[0];

    const articleServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ARTICLE);
    });
    await new Promise((r) => articleServer.listen(ARTICLE_PORT, '127.0.0.1', r));

    const sw =
      context.serviceWorkers().find((w) => w.url().includes(EXTENSION_ID)) ??
      (await context.waitForEvent('serviceworker', (w) => w.url().includes(EXTENSION_ID)));
    const connBaseUrl = process.env.PROBE_RELAY_URL ?? 'http://127.0.0.1:8787/m/long/v1';
    await writeSettings(sw, connBaseUrl);

    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${ARTICLE_PORT}/article`);
    const frame = await selectAndAsk(page, '讲一个长一点的回答');
    // 等第一条正文增量出现，确认任务真的已经开始流式输出
    const end = Date.now() + 15_000;
    for (;;) {
      const text = await frame.getByTestId('answer').last().textContent().catch(() => '');
      if (text) break;
      if (Date.now() > end) throw new Error('一直没收到第一条正文增量');
      await new Promise((r) => setTimeout(r, 300));
    }
    writeState({ pid, userDataDir, startedAt: Date.now(), articleUrl: `http://127.0.0.1:${ARTICLE_PORT}/article` });
    console.log(JSON.stringify({ phase, pid, started: true }));
    articleServer.close();
    process.exit(0);
  }

  if (phase === 'long-launch-closed') {
    // 比 long-launch 更严格：确认开始流式输出后立刻关掉源标签页（销毁小窗 iframe 和它的长连接端口），
    // 这之后唯一还能重置后台空闲计时的只剩 run() 里的 checkpoint（每 1.5 秒写一次 storage.session）。
    // 对应矩阵里的「关闭源标签页」「无 UI 订阅」两种触发场景的叠加。
    mkdirSync(STATE_DIR, { recursive: true });
    const userDataDir = resolve(STATE_DIR, 'profile-long-closed');
    rmSync(userDataDir, { recursive: true, force: true });
    const pid = spawnBrowser(userDataDir);
    await waitForCdp(PORT);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const context = browser.contexts()[0];

    const articleServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(ARTICLE);
    });
    await new Promise((r) => articleServer.listen(ARTICLE_PORT, '127.0.0.1', r));

    const sw =
      context.serviceWorkers().find((w) => w.url().includes(EXTENSION_ID)) ??
      (await context.waitForEvent('serviceworker', (w) => w.url().includes(EXTENSION_ID)));
    const connBaseUrl = process.env.PROBE_RELAY_URL ?? 'http://127.0.0.1:8787/m/long/v1';
    await writeSettings(sw, connBaseUrl);

    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${ARTICLE_PORT}/article`);
    const frame = await selectAndAsk(page, '讲一个长一点的回答');
    const end = Date.now() + 15_000;
    let jobId;
    for (;;) {
      const text = await frame.getByTestId('answer').last().textContent().catch(() => '');
      if (text) {
        jobId = await frame.evaluate(async () => {
          const all = await chrome.storage.session.get(null);
          const j = Object.entries(all).find(([k]) => k.startsWith('job:'));
          return j?.[1]?.jobId;
        });
        break;
      }
      if (Date.now() > end) throw new Error('一直没收到第一条正文增量');
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!jobId) throw new Error('取不到 jobId');
    // PROBE_CLOSE_MODE=navigate（默认 close）：真机上发现直接关掉最后一个标签页会让 Edge 整个应用退出
    // （不是扩展后台被回收，是浏览器进程本身没了），那样测的就不是「后台在无 UI 时能否撑完」了。
    // navigate 模式改成把源标签页导航到 about:blank：销毁小窗 iframe 和它的长连接端口（等效于
    // 矩阵里的「无 UI 订阅」），但保留一个窗口让浏览器应用本身不退出，不污染「后台被回收」这个结论
    if (process.env.PROBE_CLOSE_MODE === 'navigate') {
      await page.goto('about:blank');
    } else {
      await context.newPage(); // 关闭源标签页前先留一个空白页，同样是为了不让浏览器应用退出
      await page.close();
    }
    writeState({ pid, userDataDir, startedAt: Date.now(), jobId });
    console.log(JSON.stringify({ phase, pid, started: true, jobId }));
    articleServer.close();
    process.exit(0);
  }

  if (phase === 'long-check-closed') {
    const state = readState();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const context = browser.contexts()[0];
    // 原标签页已经关了：开一个新页面指向设置页，只为了能调用扩展 API 读 storage.session
    const page = await context.newPage();
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    const result = await page.evaluate(async (jobId) => {
      const all = await chrome.storage.session.get(null);
      const rec = all[`job:${jobId}`];
      const epoch = all.workerEpoch;
      return { rec, epoch };
    }, state.jobId);
    const elapsedSeconds = Math.round((Date.now() - state.startedAt) / 1000);
    console.log(JSON.stringify({ phase, elapsedSeconds, jobId: state.jobId, ...result }));
    process.exit(0);
  }

  if (phase === 'long-check') {
    const state = readState();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const context = browser.contexts()[0];
    const page = context.pages().find((p) => p.url().includes('/article'));
    if (!page) throw new Error('找不到原来那个标签页');
    await page.waitForTimeout(1000); // 刚连上时子 frame 列表可能还没同步完
    const frame = page.frames().find(isFloat);
    if (!frame) throw new Error('找不到原来那个小窗 iframe');
    const jobState = await frame.getByTestId('job-state').last().textContent().catch(() => '(读不到)');
    const answerLen = (await frame.getByTestId('answer').last().textContent().catch(() => '')).length;
    const jobs = await frame.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      return Object.entries(all)
        .filter(([k]) => k.startsWith('job:'))
        .map(([, v]) => ({ state: v.state, workerEpoch: v.workerEpoch, interruptReason: v.interruptReason }));
    });
    const elapsedSeconds = Math.round((Date.now() - state.startedAt) / 1000);
    console.log(JSON.stringify({ phase, elapsedSeconds, jobStateInUi: jobState, answerLength: answerLen, jobs }));
    process.exit(0);
  }

  if (phase === 'cleanup') {
    try {
      const state = readState();
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(state.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(state.pid, 'SIGKILL');
    } catch {
      // 没有残留状态也无所谓
    }
    // Edge 的顶层进程有时不是真正监听调试端口那个进程的父进程，taskkill /T 杀不到；
    // 兜底再按端口找一次（仅 Windows），找到就连它的整棵子树一起杀掉
    if (process.platform === 'win32') {
      try {
        const { execSync } = await import('node:child_process');
        const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8' });
        const pids = [...new Set([...out.matchAll(/LISTENING\s+(\d+)/g)].map((m) => m[1]))];
        for (const pid of pids) spawn('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // 端口已经没人监听，不用额外清理
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    rmSync(STATE_DIR, { recursive: true, force: true });
    console.log(JSON.stringify({ phase, cleaned: true }));
    process.exit(0);
  }

  console.error('未知阶段：', phase);
  process.exit(1);
}

await main();
