// V-04：权限、黑名单与敏感输入（VALIDATION_MATRIX）。证据是模拟中转站收到的完整请求正文、哨兵注册表、
// 后台诊断日志（只有结构）——不是界面上的「已关闭」。
// 1. 输入样本：密码框、普通输入框、textarea、contenteditable 选中不弹工具栏；只读代码 textarea 是唯一例外；
//    整页读取（fullPage）的请求里不出现任何输入值，只读代码例外不扩散。
// 2. 设置页把站点改成「不读取」：立即拦截新的发送（不再带正文、历史里的旧正文去掉、缓存清掉），哨兵注册表排除该站。
// 3. 页面与子框架不同策略：框架来源在黑名单 → 框架里没有哨兵；顶层在黑名单 → 子框架里的哨兵问过级别后不弹。
// 4. D-01：改策略时已接单、尚未发出的请求取消；已发出的继续到终态。
import type { Page } from '@playwright/test';
import { EXTENSION_ID, expect, test } from './fixtures';
import {
  askInFloat,
  clickAsk,
  collectLogs,
  convAsk,
  expectNoToolbar,
  floatFrame,
  frameToolbarOpen,
  MODEL,
  parseBody,
  patchSettings,
  type Relay,
  registeredExcludes,
  selectAndOpen,
  selectionRevision,
  sessionJobs,
  settingsWith,
  startRelay,
  waitSentinelRegistered,
  writeSettings,
} from './page-helpers';

const SECRETS = {
  pwd: 'PWD-合成秘密-0001',
  txt: 'INPUT-合成秘密-0002',
  ta: 'TEXTAREA-合成秘密-0003',
  ce: 'EDITABLE-合成秘密-0004',
};
const RO_CODE = "function readonlyCode() { return 'RO-CODE-0005'; }";
const PARA = '正文第一段：光合作用是绿色植物利用光能，把二氧化碳和水合成有机物的过程。';
const OTHER = '正文第二段：叶绿体是进行光合作用的场所。';

const INPUTS_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>V-04 输入样本</title></head>
<body><article>
<h1>V-04 输入样本</h1>
<p id="para">${PARA}</p>
<p>${OTHER}</p>
<form><label>密码 <input id="pwd" type="password"></label></form>
<div><input id="txt" type="text"></div>
<div><textarea id="ta"></textarea></div>
<div id="ce" contenteditable="true"></div>
<div><textarea id="ro" readonly rows="3" cols="60">${RO_CODE}</textarea></div>
<p>正文第三段：结尾。</p>
</article></body></html>`;

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(() => r.reset());

const serve = (page: Page, html: string, url = 'https://e2e.test/**') =>
  page
    .context()
    .route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));

test('输入样本：只有只读代码 textarea 例外；整页读取的请求里没有任何输入值', async ({
  context,
  page,
  serviceWorker,
}) => {
  const logs = collectLogs(context, serviceWorker);
  await writeSettings(serviceWorker, {
    ...settingsWith(r),
    context: { speedSoftBudgetRatio: 0.5, summaryReadRatio: 0.3, defaultTier: 'fullPage' },
  });
  await serve(page, INPUTS_PAGE);
  await waitSentinelRegistered(serviceWorker);
  await page.goto('https://e2e.test/inputs');
  // 用户在各输入框里输入合成秘密
  await page.fill('#pwd', SECRETS.pwd);
  await page.fill('#txt', SECRETS.txt);
  await page.fill('#ta', SECRETS.ta);
  await page.click('#ce');
  await page.keyboard.type(SECRETS.ce);

  for (const id of ['#pwd', '#txt', '#ta', '#ce', '#ro']) {
    await test.step(`${id} 里全选：不弹工具栏（只读代码除外）`, async () => {
      await page.click(id);
      await page.keyboard.press('Control+A');
      // 实测记录：浏览器的 Selection 在输入框里怎么表现（只记形状与长度，不记输入值）
      const probe = await page.evaluate(() => {
        const s = window.getSelection();
        return {
          active: document.activeElement?.id,
          isCollapsed: s?.isCollapsed,
          anchor: s?.anchorNode?.nodeName,
          toStringLength: s?.toString().length,
          type: s?.type,
        };
      });
      console.log('[V-04] 选区实测', id, JSON.stringify(probe));
      if (id !== '#ro') await expectNoToolbar(page);
    });
  }

  await test.step('只读代码 textarea 全选：弹出，问的是框里的代码', async () => {
    await clickAsk(page);
    const frame = await floatFrame(page);
    await askInFloat(frame, r, '这段代码做什么？');
  });

  const body = r.bodies[0] ?? '';
  const sent = parseBody(body);
  const userSide = sent.messages
    .filter((m) => m.role !== 'system')
    .map((m) => m.content)
    .join('\n');
  // 只读代码：选区例外 + 抽取例外都在；普通正文按整页读取进了请求
  expect(userSide).toContain('RO-CODE-0005');
  expect(userSide).toContain(PARA);
  expect(userSide).toContain(OTHER);
  // 例外不扩散：任何输入值都不在完整请求正文里，也不在后台日志里
  for (const v of Object.values(SECRETS)) {
    expect(body).not.toContain(v);
    expect(logs.lines.join('\n')).not.toContain(v);
  }
  const plan = logs.plans().at(-1);
  expect(plan).toMatchObject({ contextTier: 'fullPage', pageRead: true, siteLevel: 'normal' });
  console.log('[V-04] 输入样本请求的计划', JSON.stringify(plan));
});

test('设置页改成「不读取」：新的发送立即只带选区，旧缓存与历史旧正文不作旁路，哨兵注册表排除该站', async ({
  context,
  page,
  serviceWorker,
}) => {
  const logs = collectLogs(context, serviceWorker);
  await writeSettings(serviceWorker, settingsWith(r));
  await serve(page, INPUTS_PAGE);
  await waitSentinelRegistered(serviceWorker);
  await page.goto('https://e2e.test/article');

  // 选中、点「问」打开小窗（存下选区）。两轮问答走同一对话：小窗界面目前每问一次是新对话，
  // 多轮装配从协议层验证（page-helpers 的 convAsk）
  const frame = await selectAndOpen(page, '#para');
  const model = { connectionId: 'e2e-conn-0001', model: MODEL };
  const rev = await selectionRevision(serviceWorker, page);
  const first = await convAsk(frame, { model, selectionRevision: rev, text: '这段话讲了什么？' });
  expect(first.states.at(-1)).toBe('completed');
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).toContain(OTHER);
  expect(first.plan).toMatchObject({ contextTier: 'nearby', pageRead: true });

  await test.step('设置页添加站点规则（normalizeSiteRule 归一）', async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await options.getByLabel('站点', { exact: true }).fill('https://E2E.test/some/page');
    await options.getByLabel('站点级别').selectOption('noRead');
    await options.getByRole('button', { name: '添加站点' }).click();
    await expect(options.getByText('e2e.test', { exact: true })).toBeVisible();
    await options.close();
  });
  await expect.poll(() => registeredExcludes(serviceWorker)).toContain('*://*.e2e.test/*');
  await expect.poll(() => logs.events('page/cachePurged').length).toBeGreaterThan(0);

  await test.step('同一对话接着问：只带选区，历史里的旧正文去掉', async () => {
    const readsBefore = logs.events('page/read').length;
    const second = await convAsk(frame, {
      model,
      selectionRevision: rev,
      conversationId: first.accepted?.conversationId,
      text: '再说一遍',
    });
    expect(second.states.at(-1)).toBe('completed');
    const body = parseBody(r.bodies[1]);
    const userSide = body.messages.filter((m) => m.role !== 'system').map((m) => m.content);
    // 历史一轮 + 本轮，都不再有页面正文；选区照带
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    const all = userSide.join(' ');
    expect(all).not.toContain('<page_content>');
    expect(all).not.toContain(OTHER);
    expect(userSide.at(-1)).toContain(PARA);
    expect(second.plan).toMatchObject({ pageRead: false, removedEarlierPageText: true, sentBlockIds: [] });
    expect(logs.plans().at(-1)).toMatchObject({ siteLevel: 'noRead' });
    // 抽取层：没有再发 page/read；日志层：后台日志里没有任何页面正文
    expect(logs.events('page/read')).toHaveLength(readsBefore);
    const logged = logs.lines.join(' ');
    expect(logged).not.toContain(OTHER);
    expect(logged).not.toContain(PARA);
    console.log('[V-04] 改成不读取后的计划', JSON.stringify(second.plan));
  });

  await test.step('新打开的同站页面：没有哨兵，不弹工具栏', async () => {
    const fresh = await context.newPage();
    await fresh.goto('https://e2e.test/fresh');
    await fresh.locator('#para').click({ clickCount: 3 });
    await expectNoToolbar(fresh);
    await fresh.close();
  });
});

const framePage = (src: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>带子框架的页面</title></head>
<body><p id="top">顶层正文：这一段在顶层框架里，用来选中。</p>
<iframe src="${src}" width="600" height="200"></iframe></body></html>`;
const INNER = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>
<body><p id="inner">子框架正文：这一段在子框架里，用来选中。</p></body></html>`;

test('页面与子框架不同策略：框架来源在黑名单不常驻；顶层在黑名单时子框架取更严不弹', async ({
  context,
  page,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, {
    ...settingsWith(r),
    sites: [
      { host: 'frame.test', level: 'noRead' },
      { host: 'blocked.test', level: 'noToolbar' },
    ],
  });
  await expect
    .poll(() => registeredExcludes(serviceWorker))
    .toEqual(['*://*.blocked.test/*', '*://*.frame.test/*']);
  const route = (host: string, html: string) =>
    context.route(`https://${host}/**`, (rt) =>
      rt.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
    );
  await route('frame.test', INNER);
  await route('other.test', INNER);
  await route('blocked.test', framePage('https://other.test/inner'));
  await context.route('https://e2e.test/normal', (rt) =>
    rt.fulfill({ contentType: 'text/html; charset=utf-8', body: framePage('https://other.test/inner') }),
  );
  await context.route('https://e2e.test/with-blocked-frame', (rt) =>
    rt.fulfill({ contentType: 'text/html; charset=utf-8', body: framePage('https://frame.test/inner') }),
  );

  const inner = (p: Page) => p.frames().find((f) => f.url().endsWith('/inner'));
  const selectInner = async (p: Page) => {
    await p.frameLocator('iframe').locator('#inner').click({ clickCount: 3 });
  };

  await test.step('对照：顶层与框架都正常 → 子框架里弹工具栏', async () => {
    await page.goto('https://e2e.test/normal');
    await selectInner(page);
    await expect.poll(async () => frameToolbarOpen(inner(page) ?? page.mainFrame())).toBe(true);
  });

  await test.step('顶层正常、框架来源「不读取」 → 框架里不常驻哨兵，不弹', async () => {
    await page.goto('https://e2e.test/with-blocked-frame');
    await selectInner(page);
    await page.waitForTimeout(800);
    expect(await frameToolbarOpen(inner(page) ?? page.mainFrame())).toBe(false);
    // 顶层照常
    await page.locator('#top').click({ clickCount: 3 });
    await clickAsk(page);
  });

  await test.step('顶层「不弹工具栏」、框架来源正常 → 框架取更严，不弹；顶层也不弹', async () => {
    await page.goto('https://blocked.test/top');
    await selectInner(page);
    await page.waitForTimeout(800);
    expect(await frameToolbarOpen(inner(page) ?? page.mainFrame())).toBe(false);
    await page.locator('#top').click({ clickCount: 3 });
    await expectNoToolbar(page);
  });
});

test('D-01：改策略时已接单未发出的取消（不发请求），已发出的继续到终态', async ({
  context,
  page,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  // 已发出的那一步要「请求在途」一段时间：head35 模式按 0.1 缩放，3.5 秒后才回响应头
  const slow = await startRelay(0.1);
  try {
    const logs = collectLogs(context, serviceWorker);
    await writeSettings(serviceWorker, settingsWith(r));
    await serve(page, INPUTS_PAGE);
    await waitSentinelRegistered(serviceWorker);
    await page.goto('https://e2e.test/d01');
    const frame = await selectAndOpen(page, '#para');
    const rev = await selectionRevision(serviceWorker, page);
    const model = { connectionId: 'e2e-conn-0001', model: MODEL };

    await test.step('未发出：读取还没回来时改成「不读取」→ 任务取消，模拟中转站收不到请求', async () => {
      // 网页脚本占住主线程 3 秒：阅读器与网页同一线程，读取只能等着（小窗在扩展进程里，不受影响）
      await page.evaluate(() =>
        setTimeout(() => {
          const t = Date.now();
          while (Date.now() - t < 3000);
        }, 50),
      );
      await page.waitForTimeout(150);
      const pending = convAsk(frame, { model, selectionRevision: rev, text: '这段话讲了什么？' });
      await expect
        .poll(async () => (await sessionJobs(serviceWorker)).map((j) => j.state))
        .toEqual(['accepted']);
      await patchSettings(serviceWorker, (s) => ({ ...s, sites: [{ host: 'e2e.test', level: 'noRead' }] }));
      const res = await pending;
      expect(res.states.at(-1)).toBe('stopped');
      await page.waitForTimeout(3500); // 等主线程放开、读取结果回到后台
      expect(r.bodies).toHaveLength(0);
      expect(await sessionJobs(serviceWorker)).toEqual([
        expect.objectContaining({ state: 'stopped', stopReason: 'policyChanged' }),
      ]);
      expect(logs.events('settings/sitesChanged').at(-1)).toMatchObject({ cancelledJobs: 1 });
    });

    await test.step('已发出：请求在途时改成「不读取」→ 继续到完成，不中途掐断', async () => {
      await patchSettings(serviceWorker, (s) => ({
        ...s,
        sites: [],
        connections: s.connections.map((c) => ({ ...c, baseUrl: `${slow.relay.url}/m/head35/v1` })),
      }));
      const pending = convAsk(frame, { model, selectionRevision: rev, text: '这段话讲了什么？' });
      await expect.poll(() => slow.bodies.length, { message: '请求到达慢速中转站' }).toBe(1);
      await patchSettings(serviceWorker, (s) => ({ ...s, sites: [{ host: 'e2e.test', level: 'noRead' }] }));
      const res = await pending;
      expect(res.states).toEqual(['streaming', 'completed']);
      expect(logs.events('settings/sitesChanged').at(-1)).toMatchObject({ cancelledJobs: 0 });
      // 已发出的那份请求按发出时的策略带了正文；之后的新发问才按新策略
      expect(slow.bodies[0]).toContain(OTHER);
    });
  } finally {
    await slow.relay.close();
  }
});
