// V-04 / V-06 / V-07 端到端共用的小工具：模拟中转站（记下每次请求的完整正文）、设置写入、划词点「问」、
// 小窗里提问、收集后台诊断日志里的发送计划。工具栏在封闭 shadow root 里，定位器进不去，
// 用调试协议穿透取节点与盒模型，再用真实鼠标点击（同 ask-flow.spec.ts）。
import type { IncomingMessage } from 'node:http';
import type { BrowserContext, CDPSession, ConsoleMessage, Frame, Page, Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, type Settings } from '../../src/core/domain/settings';
import type { Connection } from '../../src/core/llm/adapter';
import { type LogEntry, type MockRelay, startMockRelay } from '../mock-relay/server';
import { expect } from './fixtures';

declare const chrome: typeof browser;

export const MODEL = 'mock-flash';
export const ANSWER = '这是模拟中转站的回答。它分多段流式返回。';

export interface Relay {
  relay: MockRelay;
  /** 每次 chat 请求的完整正文（JSON 文本），按到达顺序 */
  bodies: string[];
  chatLog(): Promise<LogEntry[]>;
  reset(): Promise<void>;
}

export async function startRelay(scale?: number): Promise<Relay> {
  const relay = await startMockRelay(scale === undefined ? {} : { scale });
  const bodies: string[] = [];
  // 模拟中转站的 /__log 只记模型名，这里再挂一个监听记下完整正文（V-04/V-07 的证据要看完整请求）
  relay.server.on('request', (req: IncomingMessage) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => bodies.push(Buffer.concat(parts).toString('utf8')));
  });
  return {
    relay,
    bodies,
    chatLog: async () =>
      ((await (await fetch(`${relay.url}/__log`)).json()) as LogEntry[]).filter((e) =>
        e.path.endsWith('/chat/completions'),
      ),
    reset: async () => {
      await fetch(`${relay.url}/__reset`, { method: 'POST' });
      bodies.length = 0;
    },
  };
}

export function connection(r: Relay, overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'e2e-conn-0001',
    name: '模拟中转站',
    preset: 'custom',
    baseUrl: `${r.relay.url}/v1`,
    apiKey: 'e2e-fake-key',
    headers: {},
    interfaceType: 'chatCompletions',
    stream: true,
    extraParams: {},
    configVersion: 1,
    ...overrides,
  };
}

export function settingsWith(r: Relay, patch: Partial<Settings> = {}): Settings {
  const conn = connection(r);
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    connections: [conn],
    defaultModel: { connectionId: conn.id, model: MODEL },
    ...patch,
  };
}

export const writeSettings = (sw: Worker, s: Settings) =>
  sw.evaluate((v) => chrome.storage.local.set({ settings: v }), s);

export const readSettings = (sw: Worker) =>
  sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings as Settings);

/** 改一部分设置（基于当前存储里的那份） */
export async function patchSettings(sw: Worker, patch: (s: Settings) => Settings): Promise<void> {
  await writeSettings(sw, patch(await readSettings(sw)));
}

/** 哨兵是安装后异步注册的；注册完成前打开的网页没有哨兵，先等注册完再开页 */
export async function waitSentinelRegistered(sw: Worker): Promise<void> {
  await expect
    .poll(() => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length))
    .toBe(1);
}

export const registeredExcludes = (sw: Worker) =>
  sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts())[0]?.excludeMatches ?? []);

// ───────────── 后台诊断日志：发送计划等（只有结构，没有页面文字） ─────────────

export interface Logs {
  lines: string[];
  plans(): Record<string, unknown>[];
  events(name: string): Record<string, unknown>[];
}

export function collectLogs(context: BrowserContext, sw: Worker): Logs {
  const lines: string[] = [];
  const hook = (w: Worker) => w.on('console', (m: ConsoleMessage) => lines.push(m.text()));
  hook(sw);
  context.on('serviceworker', hook);
  const events = (name: string) =>
    lines.flatMap((l) => {
      const i = l.indexOf(`] ${name} `);
      if (i < 0) return [];
      try {
        return [JSON.parse(l.slice(i + name.length + 3)) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  return { lines, plans: () => events('ask/plan'), events };
}

// ───────────── 工具栏与小窗 ─────────────

interface DomNode {
  backendNodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

function findByLabel(node: DomNode, label: string): DomNode | undefined {
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

/** 顶层框架里可见的「问」按钮中心；没有或不可见返回 undefined */
export async function askButtonCenter(cdp: CDPSession): Promise<{ x: number; y: number } | undefined> {
  return toolbarButtonCenter(cdp, '问');
}

/** 顶层框架里可见的、指定 aria-label 的工具栏按钮中心（A6：代码选区第一个按钮是「解释代码」） */
export async function toolbarButtonCenter(
  cdp: CDPSession,
  label: string,
): Promise<{ x: number; y: number } | undefined> {
  const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
  const node = findByLabel(root, label);
  if (!node) return undefined;
  try {
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    if (model.width === 0 || model.height === 0) return undefined;
    const q = model.content;
    return { x: ((q[0] ?? 0) + (q[4] ?? 0)) / 2, y: ((q[1] ?? 0) + (q[5] ?? 0)) / 2 };
  } catch {
    return undefined;
  }
}

/**
 * 子框架（含跨源）里有没有打开的工具栏：工具栏宿主是挂在 documentElement 下的 popover。
 * 只用于子框架——小窗宿主也是 popover，但只建在顶层框架
 */
export const frameToolbarOpen = (frame: Frame) =>
  frame.evaluate(() => [...document.documentElement.children].some((el) => el.matches(':popover-open')));

/** 等工具栏出现并点指定 aria-label 的按钮（A6 代码选区场景可以传「解释代码」） */
export async function clickToolbarButton(page: Page, label: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  let center: { x: number; y: number } | undefined;
  await expect
    .poll(
      async () => {
        center = await toolbarButtonCenter(cdp, label);
        return center !== undefined;
      },
      { message: `工具栏出现「${label}」`, timeout: 5_000 },
    )
    .toBe(true);
  await cdp.detach();
  if (!center) throw new Error('取不到按钮位置');
  await page.mouse.click(center.x, center.y);
}

/**
 * 三击选中一段：先滚到位、等两帧再点。locator.click 自带的滚动产生的 scroll 事件若晚于 mouseup 才派发，
 * 哨兵会把刚弹出的工具栏当作「滚动后消失」收起（A5），用例就等不到工具栏
 */
export async function tripleClick(page: Page, selector: string): Promise<void> {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.locator(selector).click({ clickCount: 3 });
}

/** 等工具栏出现并点「问」 */
export async function clickAsk(page: Page): Promise<void> {
  return clickToolbarButton(page, '问');
}

/** 一段时间内工具栏都没出现 */
export async function expectNoToolbar(page: Page, ms = 800): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    expect(await askButtonCenter(cdp)).toBeUndefined();
    await page.waitForTimeout(100);
  }
  await cdp.detach();
}

const isFloat = (f: Frame) => {
  try {
    return new URL(f.url()).pathname === '/float.html';
  } catch {
    return false;
  }
};

export async function floatFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some(isFloat), { message: '小窗 iframe 出现' }).toBe(true);
  return page.frames().find(isFloat) as Frame;
}

/**
 * 在小窗里提问，等请求到达模拟中转站、小窗显示答完。fill 用于超长问题（逐字输入太慢）。
 * 小窗里带 job-state 标记的只有正在显示的那个任务（之前的回答留在对话列表里，不带这个标记）：
 * 请求到达时接单早已推给小窗，此后看到的 completed 一定是这次的
 */
export async function askInFloat(frame: Frame, r: Relay, question: string, opts: { fill?: boolean } = {}) {
  const n = r.bodies.length + 1;
  const input = frame.getByLabel('输入问题');
  if (opts.fill) await input.fill(question);
  else {
    await expect(input).toBeFocused();
    await frame.page().keyboard.type(question);
  }
  await expect(input).toHaveValue(question);
  await input.press('Enter');
  await expect.poll(() => r.bodies.length, { message: `第 ${n} 次请求到达`, timeout: 15_000 }).toBe(n);
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
}

/** 三击选中整段 → 点「问」→ 返回小窗 */
export async function selectAndOpen(page: Page, selector: string): Promise<Frame> {
  await page.locator(selector).click({ clickCount: 3 });
  await clickAsk(page);
  return floatFrame(page);
}

// ───────────── 请求正文 ─────────────

export interface SentBody {
  model: string;
  stream: boolean;
  messages: { role: string; content: string }[];
  [k: string]: unknown;
}

export const parseBody = (s: string | undefined) => JSON.parse(s ?? '{}') as SentBody;

/** 页面正文片段里的块：[N] 起头（N 为纯数字引用编号，换算回 bN），到下一个块或 </page_content> 为止 */
export function pageBlocksIn(text: string): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const sections = text.match(/<page_content>[\s\S]*?<\/page_content>/g) ?? [];
  for (const sec of sections) {
    const re = /^\[(\d+)\]\n([\s\S]*?)(?=\n\n\[\d+\]\n|\n<\/page_content>)/gm;
    for (const m of sec.matchAll(re)) out.push({ id: `b${m[1]}`, text: m[2] as string });
  }
  return out;
}

export const sessionJobs = (sw: Worker) =>
  sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('job:'))
      .map(([, v]) => v as { jobId: string; state: string; stopReason?: string });
  });

// ───────────── 直接走对话端口（多轮对话、看发送计划） ─────────────

export interface ConvResult {
  accepted?: { conversationId: string; jobId: string };
  plan?: Record<string, unknown>;
  states: string[];
  rejected?: Record<string, unknown>;
}

/**
 * 在小窗页面里另开一条对话端口（conv/resumeFloat 按 sender 恢复握手），发一次 conv/ask 并等到终态。
 * 多轮历史、降档、历史去正文这些装配行为从协议层验证；返回这次任务的发送计划（conv/plan）。
 * 不带 conversationId 时默认带 fresh（明确新建对话）：续接规则（D13）下同一页 30 分钟内的发问会接上近期的对话，
 * 这里的用例按「每次一个新对话」写的；要验证续接就显式传 fresh: false 或 conversationId
 */
export function convAsk(
  frame: Frame,
  ask: Record<string, unknown>,
  opts: { timeoutMs?: number; untilPlan?: boolean } = {},
): Promise<ConvResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const untilPlan = opts.untilPlan ?? false;
  return frame.evaluate(
    ({ ask, timeoutMs, untilPlan }) =>
      new Promise<ConvResult>((resolve) => {
        const out: ConvResult = { states: [] };
        const port = chrome.runtime.connect({ name: 'conv' });
        const clientRequestId = crypto.randomUUID();
        const finish = () => {
          clearTimeout(timer);
          port.disconnect();
          resolve(out);
        };
        const timer = setTimeout(finish, timeoutMs);
        port.onMessage.addListener((raw: unknown) => {
          const m = raw as Record<string, unknown>;
          if (m.type === 'conv/ready') {
            port.postMessage({
              type: 'conv/ask',
              clientRequestId,
              actionId: 'ask',
              text: '请解释',
              contextTier: 'nearby',
              lengthTier: 'normal',
              thinking: 'off',
              ...(ask.conversationId === undefined && ask.fresh === undefined ? { fresh: true } : {}),
              ...ask,
            });
          } else if (m.type === 'conv/rejected') {
            out.rejected = m;
            finish();
          } else if (m.type === 'conv/accepted' && m.clientRequestId === clientRequestId) {
            out.accepted = { conversationId: m.conversationId as string, jobId: m.jobId as string };
          } else if (m.type === 'conv/plan' && m.jobId === out.accepted?.jobId) {
            out.plan = m.plan as Record<string, unknown>;
            // 只要计划：不等回答（之后可以导航走，任务照常跑完，规则 2）
            if (untilPlan) finish();
          } else if (m.type === 'conv/jobState' && m.jobId === out.accepted?.jobId) {
            out.states.push(m.state as string);
            if (['completed', 'stopped', 'interrupted', 'failed'].includes(m.state as string)) finish();
          }
        });
        port.postMessage({ type: 'conv/resumeFloat' });
      }),
    { ask, timeoutMs, untilPlan },
  );
}

/** 这个网页所在标签页的编号：按标题找（同地址的两个标签页靠标题区分） */
export async function tabIdOf(sw: Worker, page: Page): Promise<number> {
  const title = await page.title();
  const id = await sw.evaluate(
    async (t) => (await chrome.tabs.query({})).find((x) => x.title === t)?.id,
    title,
  );
  if (id === undefined) throw new Error(`找不到标题为「${title}」的标签页`);
  return id;
}

/** 某标签页 action/click 存下的选区（修订号与存下的时间）与小窗绑定是否已建立 */
const selectionInfo = (sw: Worker, tabId: number) =>
  sw.evaluate(async (tab) => {
    const all = await chrome.storage.session.get([`selection:${tab}`, `floatBinding:${tab}`]);
    const sel = all[`selection:${tab}`] as { selectionRevision: number; at: number } | undefined;
    return { rev: sel?.selectionRevision, at: sel?.at, bound: all[`floatBinding:${tab}`] !== undefined };
  }, tabId);

/**
 * 最近一次选区的修订号；先等小窗握手完成（有绑定才能 resumeFloat）。
 * after：上一次选区存下的时间，等到存下了新的一份再返回（换页后哨兵的修订号会从头数，不能拿修订号比较）
 */
export async function selectionRevision(
  sw: Worker,
  page?: Page,
  after?: number,
): Promise<number | undefined> {
  const tabId = page
    ? await tabIdOf(sw, page)
    : await sw.evaluate(async () => (await chrome.tabs.query({ active: true }))[0]?.id ?? -1);
  await expect
    .poll(async () => (await selectionInfo(sw, tabId)).bound, { message: '小窗握手完成' })
    .toBe(true);
  if (after !== undefined)
    await expect
      .poll(async () => (await selectionInfo(sw, tabId)).at, { message: '新的选区已存下' })
      .not.toBe(after);
  return (await selectionInfo(sw, tabId)).rev;
}

/**
 * 选中一段 → 点「问」（存下这次选区、打开小窗）→ 通过对话端口发问。返回小窗与这次任务的结果。
 * 每次都等新的选区存下再发，免得用上一次的修订号
 */
export async function selectAndConvAsk(
  page: Page,
  sw: Worker,
  selector: string,
  ask: Record<string, unknown>,
  opts: { untilPlan?: boolean } = {},
): Promise<{ frame: Frame; res: ConvResult }> {
  const tabId = await tabIdOf(sw, page);
  const before = (await selectionInfo(sw, tabId)).at ?? -1;
  await tripleClick(page, selector);
  await clickAsk(page);
  const frame = await floatFrame(page);
  const rev = await selectionRevision(sw, page, before);
  const res = await convAsk(frame, { ...ask, selectionRevision: rev }, opts);
  return { frame, res };
}
