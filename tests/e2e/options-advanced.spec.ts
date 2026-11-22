// 设置页分层与高级选项端到端（FINAL_PLAN K1–K5、H2、H5、H7、H9、H11、I1、A3、A4、L4；5.14 权限说明）：
// 常用项露在外面、其余收进默认折叠的「高级选项」；连接的请求头 / 额外参数 / 逐字输出确实进了请求；
// 测试失败说清原因并能复制诊断（不含 Key）；勾选常用模型、手动改能力；提示词改了请求随之变化；
// 自定义动作出现在工具栏并直接发送；工具栏排序与停用；快捷键与权限说明。
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { PROMPT_REGISTRY } from '../../src/core/prompt/ask';
import { EXTENSION_ID, expect, test } from './fixtures';
import {
  ANSWER,
  askInFloat,
  clickToolbarButton,
  connection,
  floatFrame,
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

declare const chrome: typeof browser;

const SITE = 'https://e2e-options-advanced.test/';
const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';
const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>设置页高级选项端到端测试文章</title></head>
<body><article>
<p>第一段：这是一篇用来做端到端测试的文章，内容无关紧要。</p>
<p id="target">${PARAGRAPH}</p>
</article></body></html>`;
const OPTIONS_URL = `chrome-extension://${EXTENSION_ID}/options.html`;

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(() => r.reset());

async function openOptions(page: Page): Promise<void> {
  await page.goto(OPTIONS_URL);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('设置');
}

/** 展开「高级选项」里的一个小节，返回小节 */
async function openFold(page: Page, id: string) {
  const advanced = page.getByTestId('advanced');
  if (!(await advanced.evaluate((el) => (el as HTMLDetailsElement).open)))
    await advanced.locator('summary').first().click();
  const fold = page.getByTestId(id);
  if (!(await fold.evaluate((el) => (el as HTMLDetailsElement).open)))
    await fold.locator('summary').first().click();
  return fold;
}

async function openArticle(page: Page): Promise<void> {
  await page.route(`${SITE}**`, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
  await page.goto(`${SITE}article`);
}

/**
 * 选中目标段落，直到工具栏上出现指定按钮。哨兵第一次弹工具栏用的是出厂列表，页面侧配置随后才到、
 * 下一次选中生效（sentinel.ts）：所以先选一次别处，再选目标，重复到按钮出现
 */
async function selectUntilToolbarHas(page: Page, label: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await expect(async () => {
    await page.locator('p').first().click({ clickCount: 3 });
    await page.locator('#target').click({ clickCount: 3 });
    expect(await toolbarButtonCenter(cdp, label)).toBeDefined();
  }).toPass({ timeout: 10_000 });
  await cdp.detach();
}

const systemPrompt = (body: string | undefined) =>
  parseBody(body)
    .messages.filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

test('分层：常用项露在外面并带说明，高级选项默认折叠；没有连接时顶部是向导，可以跳过', async ({
  page,
  serviceWorker,
}) => {
  await openOptions(page);
  // 没有连接：向导在最上面，可以跳过（L2）
  const wizard = page.getByTestId('wizard');
  await expect(wizard).toBeVisible();
  await wizard.getByRole('button', { name: '跳过，以后在设置页配置' }).click();
  await expect(wizard).toHaveCount(0);

  // K1：常用项
  const common = page.getByTestId('common');
  await expect(common.getByLabel('默认模型')).toBeDisabled();
  await expect(common).toContainText('还没有可选的模型');
  await expect(common.getByLabel('默认档位')).toHaveValue('nearby');
  await expect(common.getByLabel('默认回答长度')).toHaveValue('brief');
  await expect(common.getByLabel('默认思考强度')).toHaveValue('off');
  await expect(common.getByLabel('站点', { exact: true })).toBeVisible();
  // K3、K5：说明直接写在选项旁边
  await expect(common).toContainText('开启后更适合复杂问题，但等待更久、费用更高');
  await expect(common).toContainText('「不读取页面内容」会让快捷键也无法把该页内容发给模型');

  // K2：高级选项默认折叠，旁边一句话；折叠着的内容不在页面里
  const advanced = page.getByTestId('advanced');
  await expect(advanced).toHaveJSProperty('open', false);
  await expect(advanced.locator('summary').first()).toContainText('这里有更多自定义选项');
  await expect(page.getByRole('button', { name: '添加连接' })).toHaveCount(0);
  await advanced.locator('summary').first().click();
  for (const id of [
    'fold-connections',
    'fold-prompts',
    'fold-actions',
    'fold-reply',
    'fold-float',
    'fold-shortcuts',
    'fold-permissions',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId(id)).toHaveJSProperty('open', false);
  }

  // 常用项改了立即保存，说明跟着当前值变
  await common.getByLabel('默认回答长度').selectOption('detailed');
  await expect(common).toContainText('更完整，但等待更久、费用更高');
  await common.getByLabel('默认档位').selectOption('fullPage');
  await common.getByLabel('默认思考强度').selectOption('medium');
  await expect
    .poll(async () => {
      const s = await readSettings(serviceWorker);
      return [s?.reply.lengthTier, s?.context.defaultTier, s?.reply.thinking];
    })
    .toEqual(['detailed', 'fullPage', 'medium']);

  // 高级里的几个选项：回答语言、长文门槛、总结读取比例、小窗关闭方式与位置
  const reply = await openFold(page, 'fold-reply');
  await reply.getByLabel('回答语言').selectOption('auto');
  await reply.getByLabel('长文门槛（占模型上下文的比例）').fill('80');
  await reply.getByLabel('总结读取比例（20%–40%）').fill('40');
  await expect(reply).toContainText('读得越多越完整，但首字更慢');
  const float = await openFold(page, 'fold-float');
  await float.getByLabel('小窗默认关闭方式').selectOption('pinned');
  await float.getByLabel('小窗位置').selectOption('remembered');
  await expect(float).toContainText('「钉住」方便对照原文，但会一直占着屏幕一角');
  await expect
    .poll(async () => {
      const s = await readSettings(serviceWorker);
      return {
        language: s.reply.language,
        soft: s.context.speedSoftBudgetRatio,
        summary: s.context.summaryReadRatio,
        closeMode: s.float.closeMode,
        placement: s.float.placement,
      };
    })
    .toEqual({ language: 'auto', soft: 0.8, summary: 0.4, closeMode: 'pinned', placement: 'remembered' });
});

test('连接：自定义请求头、额外请求参数、关闭逐字输出都进了请求；受保护字段提示会被忽略；不重填 Key 也不丢', async ({
  page,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, settingsWith(r));
  const headers: IncomingHttpHeaders[] = [];
  const onRequest = (req: { url?: string; headers: IncomingHttpHeaders }) => {
    if (req.url?.endsWith('/chat/completions')) headers.push(req.headers);
  };
  r.relay.server.on('request', onRequest);
  try {
    await openOptions(page);
    const fold = await openFold(page, 'fold-connections');
    await fold.getByTestId('connection-item').getByRole('button', { name: '编辑' }).click();
    const editor = page.getByTestId('connection-editor');
    // 已存的 Key 不回显
    await expect(editor.getByLabel('Key', { exact: true })).toHaveValue('');
    await expect(editor.getByLabel('Key', { exact: true })).toHaveAttribute('placeholder', /已保存/);

    await editor.getByRole('button', { name: '添加请求头' }).click();
    await editor.getByLabel('请求头 1 的名字').fill('X-Team');
    await editor.getByLabel('请求头 1 的值').fill('reading');
    await editor.getByLabel('额外请求参数（JSON）').fill('{"temperature": 0.3, "model": "hacked"}');
    await expect(editor.getByTestId('extra-ignored')).toHaveText('这些字段由扩展决定，填了也会被忽略：model');
    await editor.getByLabel('逐字输出').uncheck();
    await expect(editor).toContainText('只在中转站拦截逐字输出时才需要关闭');
    await editor.getByLabel('测试用模型').fill(MODEL);
    await editor.getByRole('button', { name: '测试连接' }).click();
    await expect(editor.getByText(/连接正常/)).toBeVisible({ timeout: 15_000 });

    const stored = (await readSettings(serviceWorker)).connections[0];
    expect(stored).toMatchObject({
      apiKey: 'e2e-fake-key',
      headers: { 'X-Team': 'reading' },
      stream: false,
      extraParams: { temperature: 0.3, model: 'hacked' },
      // 请求相关的字段变了，配置版本加一
      configVersion: 2,
    });
    const body = parseBody(r.bodies[0]);
    expect(body).toMatchObject({ model: MODEL, temperature: 0.3, stream: false });
    expect(headers[0]?.['x-team']).toBe('reading');
    expect(headers[0]?.authorization).toBe('Bearer e2e-fake-key');

    // JSON 写错不保存，直接指出
    await editor.getByLabel('额外请求参数（JSON）').fill('{"temperature": ');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(editor).toContainText('不是合法的 JSON');
    expect((await readSettings(serviceWorker)).connections[0]?.extraParams).toEqual({
      temperature: 0.3,
      model: 'hacked',
    });
  } finally {
    r.relay.server.off('request', onRequest);
  }
});

test('测试连接失败：说清原因、显示服务器原始报错；一键复制的诊断信息里没有 Key 和敏感请求头', async ({
  page,
  serviceWorker,
}) => {
  const SECRET_KEY = 'e2e-secret-key-must-not-leak';
  const SECRET_HEADER = 'e2e-secret-header-must-not-leak';
  const conn = connection(r, {
    baseUrl: `${r.relay.url}/m/401/v1`,
    apiKey: SECRET_KEY,
    headers: { 'X-Api-Key': SECRET_HEADER, 'X-Team': 'reading' },
  });
  await writeSettings(serviceWorker, { ...settingsWith(r), connections: [conn] });
  await openOptions(page);
  const fold = await openFold(page, 'fold-connections');
  await fold.getByTestId('connection-item').getByRole('button', { name: '编辑' }).click();
  const editor = page.getByTestId('connection-editor');
  await editor.getByLabel('测试用模型').fill(MODEL);
  await editor.getByRole('button', { name: '测试连接' }).click();

  const error = editor.getByTestId('test-error');
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(error).toContainText('Key 无效或被拒绝');
  await expect(error).toContainText('状态码 401');
  await expect(error).toContainText('Key 不对或已失效');
  await expect(error.getByTestId('server-message')).toContainText('无效的令牌');

  // 剪贴板在无界面浏览器里读不回来，换成记下写入的内容
  await page.evaluate(() => {
    const g = window as unknown as { __copied?: string };
    navigator.clipboard.writeText = async (text: string) => {
      g.__copied = text;
    };
  });
  await error.getByRole('button', { name: '复制诊断信息' }).click();
  await expect(error).toContainText('已复制（Key 已隐去）');
  const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '');
  expect(copied).toContain(`连接：${conn.name}`);
  expect(copied).toContain(`地址：${r.relay.url}/m/401/v1`);
  expect(copied).toContain(`模型：${MODEL}`);
  expect(copied).toContain('错误类型：auth');
  expect(copied).toContain('状态码：401');
  expect(copied).toContain('无效的令牌');
  expect(copied).toContain('X-Api-Key: ***');
  expect(copied).toContain('X-Team: reading');
  expect(copied).not.toContain(SECRET_KEY);
  expect(copied).not.toContain(SECRET_HEADER);
  // 页面上也不出现
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  expect(html).not.toContain(SECRET_KEY);
  expect(html).not.toContain(SECRET_HEADER);
});

test('常用模型：拉取上百个模型 → 搜索 → 勾选；能力判断未知显示「未知」并可手动改；默认模型下拉只列勾选的', async ({
  page,
  serviceWorker,
}) => {
  // 公司中转站有 126 个模型（H5）：起一个只回模型列表的服务
  const ids = [
    ...Array.from({ length: 124 }, (_, i) => `relay-model-${String(i + 1).padStart(3, '0')}`),
    'deepseek-reasoner',
    'qwen-vl-max',
  ];
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const conn = connection(r, { baseUrl: base, name: '大中转站' });
    await writeSettings(serviceWorker, {
      ...settingsWith(r),
      connections: [conn],
      defaultModel: { connectionId: conn.id, model: MODEL },
    });
    await openOptions(page);
    const fold = await openFold(page, 'fold-connections');
    await fold.getByTestId('connection-item').getByRole('button', { name: '编辑' }).click();
    const editor = page.getByTestId('connection-editor');
    await editor.getByRole('button', { name: '拉取模型列表' }).click();
    await expect(editor.getByText('拉到 126 个模型')).toBeVisible({ timeout: 15_000 });

    const models = editor.getByTestId('common-models');
    await expect(models).toContainText('显示 126 / 126 个');
    await expect(models).toContainText('已选 0 / 50');
    await models.getByLabel('搜索模型').fill('deep rea');
    await expect(models).toContainText('显示 1 / 126 个');
    await models.getByLabel('常用：deepseek-reasoner').check();
    await models.getByLabel('搜索模型').fill('007');
    await models.getByLabel('常用：relay-model-007').check();
    await models.getByLabel('搜索模型').fill('没有这个模型');
    await expect(models).toContainText('没有匹配的模型');
    await expect(models).toContainText('已选 2 / 50');

    // 能力表：认得出的按内置判断，认不出的是「未知」（不默认成不支持），可以手动改（H11）
    const table = models.getByTestId('capability-table');
    const known = table.locator('[data-model="deepseek-reasoner"]');
    await expect(known.getByLabel('deepseek-reasoner 的思考能力')).toContainText('按内置判断（可调强度）');
    await expect(known.getByLabel('deepseek-reasoner 的看图能力')).toContainText('按内置判断（不支持）');
    const unknown = table.locator('[data-model="relay-model-007"]');
    await expect(unknown.getByLabel('relay-model-007 的思考能力')).toContainText('按内置判断（未知）');
    await expect(unknown.getByLabel('relay-model-007 的看图能力')).toContainText('按内置判断（未知）');
    await expect(unknown.getByLabel('relay-model-007 的上下文大小')).toHaveAttribute('placeholder', '未知');
    await unknown.getByLabel('relay-model-007 的思考能力').selectOption('toggle');
    await unknown.getByLabel('relay-model-007 的看图能力').selectOption('yes');
    await unknown.getByLabel('relay-model-007 的上下文大小').fill('64000');
    await unknown.getByLabel('relay-model-007 的上下文大小').blur();
    await expect(unknown).toContainText('已手动修改');
    await unknown.getByRole('button', { name: '设为默认' }).click();
    await expect(unknown).toContainText('默认模型');

    await expect
      .poll(async () => {
        const s = await readSettings(serviceWorker);
        const c = s.connections[0];
        return {
          models: c?.models,
          overrides: c?.capabilityOverrides,
          def: s.defaultModel?.model,
          key: c?.apiKey,
        };
      })
      .toEqual({
        models: ['deepseek-reasoner', 'relay-model-007'],
        overrides: { 'relay-model-007': { thinking: 'toggle', vision: 'yes', contextWindow: 64_000 } },
        def: 'relay-model-007',
        key: 'e2e-fake-key',
      });

    // 常用区的默认模型下拉：只有勾选的两个
    const select = page.getByTestId('common').getByLabel('默认模型');
    await expect(select.locator('option')).toHaveText([
      '大中转站 · deepseek-reasoner',
      '大中转站 · relay-model-007',
    ]);
    await select.selectOption({ label: '大中转站 · deepseek-reasoner' });
    await expect
      .poll(async () => (await readSettings(serviceWorker)).defaultModel?.model)
      .toBe('deepseek-reasoner');

    // 改回「按内置判断」就是删掉覆盖
    await unknown.getByLabel('relay-model-007 的思考能力').selectOption('');
    await unknown.getByLabel('relay-model-007 的看图能力').selectOption('');
    await unknown.getByLabel('relay-model-007 的上下文大小').fill('');
    await unknown.getByLabel('relay-model-007 的上下文大小').blur();
    await expect
      .poll(async () => (await readSettings(serviceWorker)).connections[0]?.capabilityOverrides)
      .toBeUndefined();
  } finally {
    server.close();
  }
});

test('提示词：改了基础规则，请求里的系统提示随之变化；恢复默认后变回', async ({
  page,
  context,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  await writeSettings(serviceWorker, settingsWith(r));
  const base = PROMPT_REGISTRY.find((p) => p.id === 'base');
  if (!base) throw new Error('登记表里没有基础规则');
  const defaultFirstLine = base.defaultText.split('\n')[0] as string;
  const CUSTOM = '你是端到端测试专用的阅读助手，回答前先说「收到」。';

  const options = await context.newPage();
  await openOptions(options);
  const fold = await openFold(options, 'fold-prompts');
  // 登记表里的每一条都列出来了
  await expect(fold.locator('[data-prompt-id]')).toHaveCount(PROMPT_REGISTRY.length);
  const item = fold.locator('[data-prompt-id="base"]');
  await expect(item.getByLabel('基础规则 的提示词')).toHaveValue(base.defaultText);
  await expect(item.getByRole('button', { name: '把「基础规则」恢复默认' })).toBeDisabled();
  await item.getByLabel('基础规则 的提示词').fill(CUSTOM);
  await item.getByRole('button', { name: '保存「基础规则」' }).click();
  await expect(item).toContainText('已修改');
  expect((await readSettings(serviceWorker)).promptOverrides).toEqual({ base: CUSTOM });

  await openArticle(page);
  await page.bringToFront();
  const frame = await selectAndOpen(page, '#target');
  await askInFloat(frame, r, '这段话讲了什么？');
  await expect(frame.getByTestId('answer')).toContainText(ANSWER);
  const changed = systemPrompt(r.bodies[0]);
  expect(changed).toContain(CUSTOM);
  expect(changed).not.toContain(defaultFirstLine);

  await options.bringToFront();
  await item.getByRole('button', { name: '把「基础规则」恢复默认' }).click();
  await expect(item.getByLabel('基础规则 的提示词')).toHaveValue(base.defaultText);
  await expect(item).not.toContainText('已修改');
  expect((await readSettings(serviceWorker)).promptOverrides).toEqual({});

  await page.bringToFront();
  await askInFloat(frame, r, '再说一遍', { fill: true });
  const restored = systemPrompt(r.bodies[1]);
  expect(restored).toContain(defaultFirstLine);
  expect(restored).not.toContain(CUSTOM);
});

test('自定义动作：在设置页添加后出现在工具栏，点了直接发送，提示词进了系统提示；可以改名、删除', async ({
  page,
  context,
  serviceWorker,
}) => {
  test.setTimeout(60_000);
  await writeSettings(serviceWorker, settingsWith(r));
  const PROMPT = '把选中的内容改写成小学生也能听懂的大白话。';
  const options = await context.newPage();
  await openOptions(options);
  const fold = await openFold(options, 'fold-actions');
  await fold.getByRole('button', { name: '添加自定义动作' }).click();
  const form = fold.getByTestId('action-form');
  // 校验：名字、提示词必填
  await form.getByRole('button', { name: '保存动作' }).click();
  await expect(form).toContainText('请给动作起个名字');
  await expect(form).toContainText('请写上提示词');
  await form.getByLabel('动作名字').fill('解释');
  await form.getByLabel('动作提示词').fill(PROMPT);
  await form.getByRole('button', { name: '保存动作' }).click();
  await expect(form).toContainText('已经有同名的动作了');
  await form.getByLabel('动作名字').fill('大白话');
  await form.getByRole('button', { name: '保存动作' }).click();
  await expect(form).toHaveCount(0);

  const row = fold.locator('[data-action-id^="custom:"]');
  await expect(row).toContainText('大白话');
  await expect(row.getByTestId('action-place')).toHaveText('第 4 个');
  const stored = await readSettings(serviceWorker);
  expect(stored.customActions).toHaveLength(1);
  expect(stored.customActions[0]).toMatchObject({
    label: '大白话',
    kind: 'model',
    scope: 'selection',
    needsInput: false,
    promptOverride: PROMPT,
  });
  expect(stored.toolbarActions.at(-1)).toBe(stored.customActions[0]?.id);

  await openArticle(page);
  await page.bringToFront();
  await selectUntilToolbarHas(page, '大白话');
  await clickToolbarButton(page, '大白话');
  const frame = await floatFrame(page);
  await expect.poll(() => r.bodies.length, { message: '直接发送，不经输入框', timeout: 15_000 }).toBe(1);
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
  expect(systemPrompt(r.bodies[0])).toContain(PROMPT);
  expect(JSON.stringify(parseBody(r.bodies[0]).messages)).toContain(PARAGRAPH);

  // 改名、删除
  await options.bringToFront();
  await row.getByRole('button', { name: '编辑「大白话」' }).click();
  await fold.getByTestId('action-form').getByLabel('动作名字').fill('说人话');
  await fold.getByTestId('action-form').getByRole('button', { name: '保存动作' }).click();
  await expect(row).toContainText('说人话');
  options.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: '删除「说人话」' }).click();
  await expect(row).toHaveCount(0);
  const after = await readSettings(serviceWorker);
  expect(after.customActions).toEqual([]);
  expect(after.toolbarActions).toEqual(['ask', 'explain', 'save']);
});

test('工具栏排序与停用：设置页调整后，网页上工具栏按钮的顺序与有无随之变化', async ({
  page,
  context,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, settingsWith(r));
  const options = await context.newPage();
  await openOptions(options);
  const fold = await openFold(options, 'fold-actions');
  // 「存」前移到第一个；「解释」停用；「翻译」放上工具栏
  await fold.getByRole('button', { name: '把「存」前移' }).click();
  await fold.getByRole('button', { name: '把「存」前移' }).click();
  await expect(fold.getByRole('button', { name: '把「存」前移' })).toBeDisabled();
  await fold.getByLabel('停用「解释」').check();
  await fold.getByLabel('把「翻译」放在工具栏').check();
  await expect(fold.locator('[data-action-id="translate"]').getByTestId('action-place')).toHaveText(
    '第 3 个',
  );
  await expect(fold.locator('[data-action-id="explain"]').getByTestId('action-place')).toHaveCount(0);
  await expect
    .poll(async () => {
      const s = await readSettings(serviceWorker);
      return { toolbar: s.toolbarActions, hidden: s.hiddenActions };
    })
    .toEqual({ toolbar: ['save', 'ask', 'explain', 'translate'], hidden: ['explain'] });

  await openArticle(page);
  await page.bringToFront();
  await selectUntilToolbarHas(page, '翻译');
  const cdp = await context.newCDPSession(page);
  const save = await toolbarButtonCenter(cdp, '存');
  const ask = await toolbarButtonCenter(cdp, '问');
  const translate = await toolbarButtonCenter(cdp, '翻译');
  expect(await toolbarButtonCenter(cdp, '解释')).toBeUndefined();
  if (!save || !ask || !translate) throw new Error('工具栏按钮不全');
  expect(save.x).toBeLessThan(ask.x);
  expect(ask.x).toBeLessThan(translate.x);
  await cdp.detach();
});

test('快捷键与权限说明：设置页顶部提示没绑上的快捷键；权限说明覆盖清单里的每一项权限', async ({
  page,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await openOptions(page);
  const actual = await serviceWorker.evaluate(async () =>
    (await chrome.commands.getAll()).map((c) => ({ name: c.name, shortcut: c.shortcut ?? '' })),
  );
  const unbound = actual.filter(
    (c) => ['open-float', 'toggle-sidepanel', 'capture-region'].includes(c.name ?? '') && c.shortcut === '',
  );
  // 没绑上的在页面顶部直接提示（快捷键小节平时折叠着）
  if (unbound.length > 0) {
    await expect(page.getByTestId('shortcut-notice')).toContainText(
      `有 ${unbound.length} 个预设快捷键没有绑上`,
    );
  } else {
    await expect(page.getByTestId('shortcut-notice')).toHaveCount(0);
  }
  const shortcuts = await openFold(page, 'fold-shortcuts');
  for (const c of actual.filter((x) => x.shortcut !== '')) {
    await expect(shortcuts.locator(`tr[data-command="${c.name}"] kbd`)).toHaveText(c.shortcut);
  }
  await expect(shortcuts.locator('tr[data-unbound="true"]')).toHaveCount(unbound.length);

  const manifest = await serviceWorker.evaluate(() => {
    const m = chrome.runtime.getManifest();
    return [...(m.permissions ?? []), ...(m.host_permissions ?? [])];
  });
  const permissions = await openFold(page, 'fold-permissions');
  const table = permissions.getByTestId('permission-table');
  for (const name of manifest) await expect(table.getByText(name, { exact: true })).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(manifest.length);
  await expect(permissions).toContainText('不收集、不上传任何数据');
});

test('网站黑名单：两级都能加、能删；IPv6 地址提示「不弹工具栏」对它不生效', async ({
  page,
  serviceWorker,
}) => {
  await writeSettings(serviceWorker, settingsWith(r));
  await openOptions(page);
  const common = page.getByTestId('common');
  await common.getByLabel('站点', { exact: true }).fill('不是站点');
  await common.getByRole('button', { name: '添加站点' }).click();
  await expect(common).toContainText('不是有效的站点');
  await common.getByLabel('站点', { exact: true }).fill('https://Intranet.example.com/wiki');
  await common.getByLabel('站点级别').selectOption('noRead');
  await common.getByRole('button', { name: '添加站点' }).click();
  await common.getByLabel('站点', { exact: true }).fill('[::1]');
  await expect(common).toContainText('IPv6 地址（如 [::1]）上「不弹工具栏」不生效');
  await common.getByLabel('站点级别').selectOption('noToolbar');
  await common.getByRole('button', { name: '添加站点' }).click();
  await expect
    .poll(async () => (await readSettings(serviceWorker)).sites)
    .toEqual([
      { host: 'intranet.example.com', level: 'noRead' },
      { host: '[::1]', level: 'noToolbar' },
    ]);
  await common.getByRole('button', { name: '删除站点 intranet.example.com' }).click();
  await expect.poll(async () => (await readSettings(serviceWorker)).sites).toHaveLength(1);
});
