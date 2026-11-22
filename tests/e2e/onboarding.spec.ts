// 安装与上手端到端（FINAL_PLAN L1–L5、H1、验收第 10、12、15 条）：
// 首次安装自动打开欢迎页；只按向导配一个服务商和 Key 就能在小窗里提问；漏写 /v1 的地址在向导里提示并一键修正；
// 向导可以跳过；欢迎页列出实际生效的快捷键与没绑上的提示；示例文章上划词 → 问 / 解释 → 侧边栏回答。
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserContext, Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import type { Settings } from '../../src/core/domain/settings';
import { EXTENSION_ID, expect, test } from './fixtures';
import {
  ANSWER,
  askInFloat,
  clickToolbarButton,
  MODEL,
  parseBody,
  type Relay,
  readSettings,
  selectAndOpen,
  settingsWith,
  startRelay,
  toolbarButtonCenter,
  writeSettings,
} from './page-helpers';
import { askInPanel, attachPanel, expectPanels, panelText } from './sidepanel-helpers';

declare const chrome: typeof browser;

const SITE = 'https://e2e-onboarding.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>安装与上手端到端测试文章</title></head>
<body><article>
<p>第一段：这是一篇用来做端到端测试的文章，内容无关紧要。</p>
<p id="target">${PARAGRAPH}</p>
</article></body></html>`;
const FAKE_KEY = 'e2e-onboarding-fake-key-do-not-use';
const WELCOME_URL = `chrome-extension://${EXTENSION_ID}/welcome.html`;

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(() => r.reset());

const isWelcome = (p: Page) => p.url() === WELCOME_URL;

/** 首次安装自动打开的那个欢迎页（不是测试自己打开的） */
async function installedWelcome(context: BrowserContext): Promise<Page> {
  await expect
    .poll(() => context.pages().some(isWelcome), { message: '安装后自动打开欢迎页', timeout: 10_000 })
    .toBe(true);
  const page = context.pages().find(isWelcome) as Page;
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('欢迎使用阅读助手');
  return page;
}

/** 整份 outerHTML（文本 + 属性；受控输入框的值只在 DOM 属性里，不进 HTML）里不出现这串 */
async function assertNoKeyLeak(page: Page, key: string): Promise<void> {
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  expect(html).not.toContain(key);
}

test.describe('欢迎页', () => {
  test.use({ keepWelcome: true });

  test('首次安装后自动打开欢迎页并在前台；三步都在一页上，都不是模态', async ({ context, serviceWorker }) => {
    const welcome = await installedWelcome(context);
    // 只打开一个，且是活动标签页
    expect(context.pages().filter(isWelcome)).toHaveLength(1);
    const active = await serviceWorker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ active: true });
      const tabs = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.TAB] });
      return tabs.some((c) => c.documentUrl === url && c.tabId === tab?.id);
    }, WELCOME_URL);
    expect(active).toBe(true);

    await expect(welcome.getByTestId('welcome-step-1').getByTestId('wizard')).toBeVisible();
    await expect(welcome.getByTestId('welcome-step-2').getByTestId('demo-article')).toBeVisible();
    await expect(welcome.getByTestId('welcome-step-3').getByTestId('shortcuts')).toBeVisible();
    expect(await welcome.locator('dialog, [role="dialog"], [aria-modal="true"]').count()).toBe(0);
    // L4：提示把图标固定到工具栏（全新用户目录里没固定）
    await expect(welcome.getByTestId('pin-hint')).toHaveAttribute('data-pinned', 'false');
    await expect(welcome.getByTestId('pin-hint')).toContainText('图钉');
    // L5：安装前已经打开的网页
    await expect(welcome.getByTestId('open-tabs-hint')).toContainText('刷新一次');
  });

  test('快捷键：列出浏览器里实际生效的按键，没绑上的明确提示，并能打开浏览器的快捷键设置页', async ({
    context,
    serviceWorker,
  }) => {
    const welcome = await installedWelcome(context);
    const actual = await serviceWorker.evaluate(async () =>
      (await chrome.commands.getAll()).map((c) => ({ name: c.name, shortcut: c.shortcut ?? '' })),
    );
    console.log('[L4] commands.getAll', JSON.stringify(actual));
    const box = welcome.getByTestId('shortcuts');
    for (const name of ['open-float', 'toggle-sidepanel', 'capture-region', 'summarize-page']) {
      const row = box.locator(`tr[data-command="${name}"]`);
      const shortcut = actual.find((c) => c.name === name)?.shortcut ?? '';
      if (shortcut !== '') {
        await expect(row.locator('kbd')).toHaveText(shortcut);
        await expect(row).not.toHaveAttribute('data-unbound', 'true');
      } else {
        await expect(row).toContainText('未绑定');
        // 第 4 个命令本来就没有预设按键，不算没绑上
        if (name === 'summarize-page') await expect(row).not.toHaveAttribute('data-unbound', 'true');
        else await expect(row).toContainText('没有绑上');
      }
    }
    const anyUnbound = actual.some(
      (c) => c.name !== 'summarize-page' && !c.name?.startsWith('_') && c.shortcut === '',
    );
    await expect(box.getByTestId('shortcut-status')).toHaveText(
      anyUnbound ? /有快捷键没有绑上/ : /预设的快捷键都已生效/,
    );

    // 修改入口：chrome://extensions/shortcuts 用普通链接打不开，用 tabs.create 能打开
    const opened = context.waitForEvent('page');
    await box.getByRole('button', { name: '打开浏览器的快捷键设置' }).click();
    const shortcutsPage = await opened;
    // Edge 上是 edge://（E2E_BROWSER=msedge）
    const scheme = process.env.E2E_BROWSER === 'msedge' ? 'edge' : 'chrome';
    await expect.poll(() => shortcutsPage.url()).toBe(`${scheme}://extensions/shortcuts`);
    await shortcutsPage.close();
  });

  test('向导：漏写 /v1 → 提示并一键修正 → 选默认模型 → 完成；之后只凭这份配置就能在小窗里提问', async ({
    context,
    serviceWorker,
  }) => {
    test.setTimeout(90_000);
    const welcome = await installedWelcome(context);
    const w = welcome.getByTestId('wizard');

    await test.step('选服务商：公司中转站选「自定义 / OpenAI 兼容」', async () => {
      await expect(w).toHaveAttribute('data-step', 'provider');
      await w.getByRole('radio', { name: '自定义 / OpenAI 兼容' }).check();
      await w.getByRole('button', { name: '下一步' }).click();
    });

    await test.step('填地址（故意漏写 /v1）和 Key', async () => {
      await expect(w).toHaveAttribute('data-step', 'connect');
      await w.getByLabel('接口地址').fill(r.relay.url);
      await w.getByLabel('Key', { exact: true }).fill(FAKE_KEY);
      await assertNoKeyLeak(welcome, FAKE_KEY);
      await w.getByRole('button', { name: '保存并测试连接' }).click();
    });

    await test.step('测试连接：说明原因，给出一键修正', async () => {
      const error = w.getByTestId('test-error');
      await expect(error).toBeVisible({ timeout: 15_000 });
      await expect(error).toContainText('返回的是网页');
      await expect(error).toContainText('/v1');
      const fix = w.getByRole('button', { name: /^改成 .*\/v1 并重测$/ });
      await expect(fix).toHaveText(`改成 ${r.relay.url}/v1 并重测`);
      await fix.click();
    });

    await test.step('从模型列表选默认模型，用它发一条最小对话后完成', async () => {
      await expect(w).toHaveAttribute('data-step', 'model', { timeout: 15_000 });
      await expect(w.getByText('已连上，找到 1 个模型。')).toBeVisible();
      await w.getByRole('radio', { name: MODEL }).check();
      await w.getByRole('button', { name: '测试并完成' }).click();
      await expect(w).toHaveAttribute('data-step', 'done', { timeout: 15_000 });
      await expect(w.getByText(`配置完成，默认模型是 ${MODEL}。现在可以在网页上划词提问了。`)).toBeVisible();
      await assertNoKeyLeak(welcome, FAKE_KEY);
    });

    const stored = await readSettings(serviceWorker);
    expect(stored.connections).toHaveLength(1);
    const conn = stored.connections[0];
    expect(conn).toMatchObject({
      preset: 'custom',
      baseUrl: `${r.relay.url}/v1`,
      apiKey: FAKE_KEY,
      stream: true,
      models: [MODEL],
    });
    expect(stored.defaultModel).toEqual({ connectionId: conn?.id, model: MODEL });
    // 其余选项全部是默认值（L2）
    expect(stored.reply).toEqual({ lengthTier: 'brief', language: 'zh', thinking: 'off' });
    expect(stored.sites).toEqual([]);
    // 向导里的最小对话确实发到了修正后的地址
    expect((await r.chatLog()).map((e) => e.model)).toEqual([MODEL]);

    await test.step('只配了这一个默认模型：划词 → 问 → 小窗回答（验收第 12、15 条）', async () => {
      await r.reset();
      const page = await context.newPage();
      await page.route(`${SITE}**`, (route) =>
        route.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
      );
      await page.goto(`${SITE}article`);
      const frame = await selectAndOpen(page, '#target');
      await askInFloat(frame, r, '这段话讲了什么？');
      await expect(frame.getByTestId('answer')).toContainText(ANSWER);
      const body = parseBody(r.bodies[0]);
      expect(body.model).toBe(MODEL);
      expect(JSON.stringify(body.messages)).toContain(PARAGRAPH);
    });
  });

  test('向导可以跳过：不留下连接；之后还能重新开始', async ({ context, serviceWorker }) => {
    const welcome = await installedWelcome(context);
    const w = welcome.getByTestId('wizard');
    await w.getByRole('button', { name: '跳过，以后在设置页配置' }).click();
    await expect(w).toHaveAttribute('data-step', 'skipped');
    await expect(w).toContainText('没有配置模型时，在网页上划词提问会提示你来配置');
    const stored = (await readSettings(serviceWorker)) as Settings | undefined;
    expect(stored?.connections ?? []).toEqual([]);
    await w.getByRole('button', { name: '现在配置' }).click();
    await expect(w).toHaveAttribute('data-step', 'provider');
  });

  test('测试连接失败说明原因；返回上一步改地址不用重填 Key；模型列表拉不到时可以手填模型名继续', async ({
    context,
    serviceWorker,
  }) => {
    test.setTimeout(60_000);
    // 一个不提供模型列表的服务：/v1/models 回 404，对话接口转给模拟中转站
    const noList = createServer((req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          void fetch(`${r.relay.url}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: Buffer.concat(chunks),
          }).then(async (up) => {
            res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'text/plain' });
            res.end(Buffer.from(await up.arrayBuffer()));
          });
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no model list here', type: 'invalid_request_error' } }));
    });
    await new Promise<void>((done) => noList.listen(0, '127.0.0.1', done));
    const noListUrl = `http://127.0.0.1:${(noList.address() as AddressInfo).port}`;

    try {
      const welcome = await installedWelcome(context);
      const w = welcome.getByTestId('wizard');
      await w.getByRole('radio', { name: '自定义 / OpenAI 兼容' }).check();
      await w.getByRole('button', { name: '下一步' }).click();
      // 地址多写了一段：模型列表回 404，说明原因、显示服务器原始报错
      await w.getByLabel('接口地址').fill(`${noListUrl}/wrong/v1`);
      await w.getByLabel('Key', { exact: true }).fill(FAKE_KEY);
      await w.getByRole('button', { name: '保存并测试连接' }).click();
      const error = w.getByTestId('test-error');
      await expect(error).toBeVisible({ timeout: 15_000 });
      await expect(error).toContainText('状态码 404');
      await expect(error).toContainText('路径或接口格式不对');
      await expect(error.getByTestId('server-message')).toContainText('no model list here');
      await expect(w.getByRole('button', { name: /并重测$/ })).toHaveCount(0);

      // 返回上一步把地址改对，Key 不用重填（已保存的不回显）
      await w.getByRole('button', { name: '上一步' }).click();
      await expect(w.getByLabel('Key', { exact: true })).toHaveValue('');
      await expect(w.getByLabel('Key', { exact: true })).toHaveAttribute('placeholder', /已保存/);
      await w.getByLabel('接口地址').fill(`${noListUrl}/v1`);
      await w.getByRole('button', { name: '保存并测试连接' }).click();
      // 这个服务就是没有模型列表：仍然报出来，但允许手填模型名继续
      await expect(error).toBeVisible({ timeout: 15_000 });
      await w.getByRole('button', { name: '手填模型名继续' }).click();
      await expect(w).toHaveAttribute('data-step', 'model');
      await w.getByLabel('模型名').fill('hand-typed-model');
      await w.getByRole('button', { name: '测试并完成' }).click();
      await expect(w).toHaveAttribute('data-step', 'done', { timeout: 15_000 });
      const stored = await readSettings(serviceWorker);
      expect(stored.connections).toHaveLength(1);
      expect(stored.connections[0]).toMatchObject({ apiKey: FAKE_KEY, baseUrl: `${noListUrl}/v1` });
      expect(stored.defaultModel?.model).toBe('hand-typed-model');
      expect((await r.chatLog()).map((e) => e.model)).toEqual(['hand-typed-model']);
    } finally {
      noList.close();
    }
  });

  test('示例文章：选中 → 工具栏 →「问」→ 侧边栏带上引用并回答；「解释」点下即答', async ({
    context,
    serviceWorker,
  }) => {
    test.setTimeout(90_000);
    await writeSettings(serviceWorker, settingsWith(r));
    const welcome = await installedWelcome(context);
    // 欢迎页多半在写入设置之前就加载好了：重新加载一次，按「已经有连接」的样子显示（向导显示已配置，不挡着后面的步骤）
    await welcome.reload();
    await expect(welcome.getByTestId('wizard')).toHaveAttribute('data-step', 'configured');
    const paragraphs = welcome.getByTestId('demo-article').locator('p');
    const second = (await paragraphs.nth(1).textContent()) ?? '';
    const fourth = (await paragraphs.nth(3).textContent()) ?? '';
    expect(second).toContain('瑞利散射');

    await test.step('问：侧边栏打开，引用是选中的那一段', async () => {
      await paragraphs.nth(1).click({ clickCount: 3 });
      await clickToolbarButton(welcome, '问');
      await expect(welcome.getByTestId('demo-status')).toContainText('已在侧边栏打开');
      await expectPanels(serviceWorker, 1);
      const panel = await attachPanel(context);
      await expect.poll(() => panelText(panel, 'quote')).toContain('瑞利散射');
      await askInPanel(panel, '这和日落有什么关系？');
      await expect.poll(() => panelText(panel, 'answer'), { timeout: 15_000 }).toContain(ANSWER);
      await expect.poll(() => panelText(panel, 'job-state')).toBe('completed');
      const body = parseBody(r.bodies[0]);
      const sent = JSON.stringify(body.messages);
      expect(sent).toContain(second);
      expect(sent).toContain('这和日落有什么关系？');
      // 扩展自己的页面不读取正文：别的段落没有发出去
      expect(sent).not.toContain(fourth);
      await panel.detach();
    });

    await test.step('解释：不经输入框直接发送，回答在侧边栏里', async () => {
      await r.reset();
      // 先滚到位再选：滚动会收起工具栏（A5），点击时才滚的话滚动事件可能晚于松开鼠标
      await paragraphs.nth(3).scrollIntoViewIfNeeded();
      await welcome.waitForTimeout(300);
      await paragraphs.nth(3).click({ clickCount: 3 });
      await clickToolbarButton(welcome, '解释');
      await expect(welcome.getByTestId('demo-status')).toContainText('回答正在侧边栏里生成');
      await expect.poll(() => r.bodies.length, { timeout: 15_000 }).toBe(1);
      expect(JSON.stringify(parseBody(r.bodies[0]).messages)).toContain(fourth);
      const panel = await attachPanel(context);
      await expect.poll(() => panelText(panel, 'job-state'), { timeout: 15_000 }).toBe('completed');
      await panel.detach();
    });

    await test.step('文章之外的选区不弹工具栏', async () => {
      await welcome.getByRole('heading', { level: 1 }).click({ clickCount: 3 });
      await welcome.waitForTimeout(500);
      const cdp = await context.newCDPSession(welcome);
      expect(await toolbarButtonCenter(cdp, '问')).toBeUndefined();
      await cdp.detach();
    });
  });

  test('示例文章：还没配置模型时点「解释」提示先配置，不发请求', async ({ context }) => {
    const welcome = await installedWelcome(context);
    await expect(welcome.getByTestId('welcome-step-2')).toContainText('还没有配置模型');
    await welcome.getByTestId('demo-article').locator('p').nth(0).click({ clickCount: 3 });
    await clickToolbarButton(welcome, '解释');
    await expect(welcome.getByTestId('demo-status')).toContainText('还没有配置模型');
    expect(r.bodies).toHaveLength(0);
  });
});

test.describe('更新不打开欢迎页；设置页可以重新打开', () => {
  test('默认夹具关掉了安装时的欢迎页；模拟更新事件不会再打开', async ({ context, serviceWorker }) => {
    expect(context.pages().some(isWelcome)).toBe(false);
    await serviceWorker.evaluate(() =>
      (chrome.runtime.onInstalled as unknown as { dispatch(d: unknown): void }).dispatch({
        reason: 'update',
        previousVersion: '0.0.0',
      }),
    );
    await new Promise((done) => setTimeout(done, 800));
    expect(context.pages().some(isWelcome)).toBe(false);
  });

  test('设置页「欢迎页与快速上手」重新打开欢迎页；已有连接时向导显示已配置', async ({
    page,
    context,
    serviceWorker,
  }) => {
    await writeSettings(serviceWorker, settingsWith(r));
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: '欢迎页与快速上手' }).click();
    const welcome = await opened;
    await expect.poll(() => welcome.url()).toBe(WELCOME_URL);
    const w = welcome.getByTestId('wizard');
    await expect(w).toHaveAttribute('data-step', 'configured');
    await expect(w).toContainText(`已经配置好了，默认模型是 ${MODEL}。`);
  });
});
