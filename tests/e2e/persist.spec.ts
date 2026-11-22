// 对话落库（5.5、5.11）端到端：后台被浏览器回收后，对话与历史从 IndexedDB 重建。
// Playwright 连着时后台不会空闲回收，用 CDP ServiceWorker.stopAllWorkers 模拟（CLAUDE.md「测试踩坑」）。
// 请求体取自模拟中转站（page-helpers 的 startRelay 记下每次 chat 请求的完整正文）。
import type { Page, Worker } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { expect, test } from './fixtures';
import {
  ANSWER,
  askInFloat,
  connection,
  parseBody,
  type Relay,
  selectAndOpen,
  settingsWith,
  startRelay,
  waitSentinelRegistered,
  writeSettings,
} from './page-helpers';

declare const chrome: typeof browser;

const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>落库测试文章</title></head>
<body><article><h1>落库测试文章</h1><p>第一段。</p><p id="target">${PARAGRAPH}</p></article></body></html>`;

let r: Relay;
test.beforeAll(async () => {
  // long 模式按 scale 缩放：0.01 → 约 3.3 秒，每秒一段「第 N 段。」
  r = await startRelay(0.01);
});
test.afterAll(() => r.relay.close());
test.beforeEach(async ({ context, serviceWorker }) => {
  await r.reset();
  await writeSettings(serviceWorker, settingsWith(r));
  await waitSentinelRegistered(serviceWorker);
  await context.route('https://e2e.test/**', (rt) =>
    rt.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
});

async function stopWorkers(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
  await page.waitForTimeout(1_000);
}

interface DbDump {
  conversations: { id: string; turns: number; pageKey?: string }[];
  messages: {
    conversationId: string;
    ordinal: number;
    role: string;
    status: string;
    interruptReason?: string;
  }[];
}

/** 在后台里读对话库（只读，同一版本再开一个连接） */
const dumpDb = (sw: Worker) =>
  sw.evaluate(
    () =>
      new Promise<DbDump>((resolve, reject) => {
        const req = indexedDB.open('reading-assistant');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['conversations', 'messages']);
          const out: DbDump = { conversations: [], messages: [] };
          const c = tx.objectStore('conversations').getAll();
          const m = tx.objectStore('messages').getAll();
          tx.oncomplete = () => {
            out.conversations = c.result;
            out.messages = m.result;
            db.close();
            resolve(out);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );

const currentWorker = async (page: Page): Promise<Worker> => {
  await expect.poll(() => page.context().serviceWorkers().length).toBeGreaterThan(0);
  return page.context().serviceWorkers()[0] as Worker;
};

test('问一次 → 后台被回收 → 同一页再问：请求带上上一轮（问题、选区与回答）；库里同一对话两轮四条消息', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '第一问');
  await stopWorkers(page);

  // 小窗不带对话编号（界面没记），新后台按续接规则（D13）从库里接上该页近期的对话
  await askInFloat(frame, r, '第二问', { fill: true });
  expect(r.bodies).toHaveLength(2);
  const second = parseBody(r.bodies[1]).messages;
  expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(JSON.stringify(second[1])).toContain('第一问');
  expect(JSON.stringify(second[1])).toContain(PARAGRAPH);
  expect(JSON.stringify(second[2])).toContain(ANSWER);
  expect(JSON.stringify(second[3])).toContain('第二问');

  const db = await dumpDb(await currentWorker(page));
  expect(db.conversations).toHaveLength(1);
  expect(db.conversations[0]).toMatchObject({ turns: 2, pageKey: 'https://e2e.test/article' });
  expect(db.messages.map((m) => [m.ordinal, m.role, m.status]).sort()).toEqual([
    [0, 'user', 'completed'],
    [1, 'assistant', 'completed'],
    [2, 'user', 'completed'],
    [3, 'assistant', 'completed'],
  ]);
});

test('生成中后台被回收：唤醒后启动扫描把库里的回答标为中断（结果未知），保留已生成的部分', async ({
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  await writeSettings(serviceWorker, {
    ...settingsWith(r),
    connections: [connection(r, { baseUrl: `${r.relay.url}/m/long/v1` })],
  });
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#target');
  const input = frame.getByLabel('输入问题');
  await expect(input).toBeFocused();
  await page.keyboard.type('这段话讲了什么？');
  await input.press('Enter');
  await expect(frame.getByTestId('answer')).toContainText('第 2 段。', { timeout: 10_000 });
  // 等至少一次检查点写库（1.5 秒）
  await page.waitForTimeout(2_000);
  await stopWorkers(page);
  // 划词唤醒后台：新进程启动时扫描
  await page.locator('#target').click({ clickCount: 3 });
  const sw = await currentWorker(page);
  await expect
    .poll(async () => (await dumpDb(sw)).messages.find((m) => m.role === 'assistant')?.status, {
      timeout: 10_000,
    })
    .toBe('interrupted');
  const asst = (await dumpDb(sw)).messages.find(
    (m) => m.role === 'assistant',
  ) as DbDump['messages'][number] & {
    segments: { text: string }[];
  };
  expect(asst.interruptReason).toBe('workerRestarted');
  expect(asst.segments.map((s) => s.text).join('')).toContain('第 1 段。');
  // 已有的 session 热副本同样标中断（界面据此提示）
  const jobs = await sw.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith('job:'))
      .map(([, v]) => (v as { state: string }).state);
  });
  expect(jobs).toEqual(['interrupted']);
});
