// 思考强度按模型列档位（决策 100、H6、J10）：DeepSeek 只有 关/低/高/最高，选「最高」后请求体里
// reasoning_effort 为 max；旧设置里的「中」用在 DeepSeek 上就近取「高」，显示的与发出去的一致；
// 切到别的模型时当前档位不在新模型里取最接近的一档；设置页给自定义模型勾选档位后思考下拉随之变化。
import type { Locator } from '@playwright/test';
import { EXTENSION_ID, expect, test } from './fixtures';
import {
  askInFloat,
  connection,
  MODEL,
  parseBody,
  type Relay,
  readSettings,
  selectAndOpen,
  settingsWith,
  startRelay,
  writeSettings,
} from './page-helpers';

const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>思考档位测试文章</title></head>
<body style="max-width: 720px; margin: 24px auto; font: 16px/1.7 system-ui">
<article><h1>思考档位测试文章</h1>
<p id="p1">这是一段用来测试思考强度档位的文字。</p>
</article></body></html>`;
const OPTIONS_URL = `chrome-extension://${EXTENSION_ID}/options.html`;

let r: Relay;
test.beforeAll(async () => {
  r = await startRelay();
});
test.afterAll(() => r.relay.close());
test.beforeEach(async ({ context }) => {
  await r.reset();
  await context.route('https://e2e.test/**', (rt) =>
    rt.fulfill({ contentType: 'text/html; charset=utf-8', body: ARTICLE }),
  );
});

const expectOptions = (select: Locator, texts: string[]) =>
  expect(select.locator('option')).toHaveText(texts);

test('DeepSeek：下拉只有 关/低/高/最高；旧设置的「中」显示并发送「高」；选最高发 reasoning_effort=max', async ({
  page,
  serviceWorker,
}) => {
  const conn = connection(r, { models: ['deepseek-flash', MODEL] });
  const s = settingsWith(r, {
    connections: [conn],
    defaultModel: { connectionId: conn.id, model: 'deepseek-flash' },
  });
  // 旧设置里存的「中」：DeepSeek 没有这一档
  s.reply = { ...s.reply, thinking: 'medium' };
  await writeSettings(serviceWorker, s);
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#p1');
  const select = frame.getByLabel('思考强度');

  await expectOptions(select, ['思考 关', '思考 低', '思考 高', '思考 最高']);
  // 界面显示的就是实际发送的：「中」就近取「高」
  await expect(select).toHaveValue('high');
  await askInFloat(frame, r, '第一问');
  const first = parseBody(r.bodies[0]);
  expect(first.model).toBe('deepseek-flash');
  expect(first.thinking).toEqual({ type: 'enabled' });
  expect(first.reasoning_effort).toBe('high');

  await select.selectOption('max');
  await frame.getByLabel('输入问题').click();
  await askInFloat(frame, r, '第二问');
  const second = parseBody(r.bodies[1]);
  expect(second.thinking).toEqual({ type: 'enabled' });
  expect(second.reasoning_effort).toBe('max');

  // 切到别的模型：当前档位「最高」不在新模型里，取最接近的「高」并照实显示；新模型（认不出的厂商）不发思考字段
  await frame.getByLabel('切换模型').click();
  await frame.locator(`[data-testid="model-option"][data-model="${MODEL}"]`).click();
  await expectOptions(select, ['思考 关', '思考 低', '思考 中', '思考 高']);
  await expect(select).toHaveValue('high');
  await frame.getByLabel('输入问题').click();
  await askInFloat(frame, r, '第三问');
  const third = parseBody(r.bodies[2]);
  expect(third.model).toBe(MODEL);
  expect(third.reasoning_effort).toBeUndefined();
  expect(third.thinking).toBeUndefined();

  // 新对话回到默认模型；选「关」：显式发送 disabled，不带强度
  await frame.getByRole('button', { name: '新对话' }).click();
  await expect(select).toHaveValue('high');
  await select.selectOption('off');
  await frame.getByLabel('输入问题').click();
  await askInFloat(frame, r, '第四问');
  const fourth = parseBody(r.bodies[3]);
  expect(fourth.model).toBe('deepseek-flash');
  expect(fourth.thinking).toEqual({ type: 'disabled' });
  expect(fourth.reasoning_effort).toBeUndefined();
});

test('设置页给自定义模型勾选思考档位：思考下拉随之变化，选「最高」按 reasoning_effort 发送；改回按内置判断', async ({
  page,
  serviceWorker,
}) => {
  const conn = connection(r, { models: ['corp-model'] });
  await writeSettings(
    serviceWorker,
    settingsWith(r, {
      connections: [conn],
      defaultModel: { connectionId: conn.id, model: 'corp-model' },
    }),
  );
  await page.goto(OPTIONS_URL);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('设置');
  const advanced = page.getByTestId('advanced');
  await advanced.locator('summary').first().click();
  const fold = page.getByTestId('fold-connections');
  await fold.locator('summary').first().click();
  await fold.getByTestId('connection-item').getByRole('button', { name: '编辑' }).click();
  const row = page
    .getByTestId('common-models')
    .getByTestId('capability-table')
    .locator('[data-model="corp-model"]');

  // 认不出的模型：思考「未知」，没有档位可勾；改成「可调强度」后出现档位，默认是 关/低/中/高
  await expect(row.getByTestId('thinking-levels')).toHaveCount(0);
  await row.getByLabel('corp-model 的思考能力').selectOption('effort');
  const levels = row.getByTestId('thinking-levels');
  await expect(levels).toBeVisible();
  for (const [name, checked] of [
    ['关', true],
    ['低', true],
    ['中', true],
    ['高', true],
    ['最高', false],
  ] as const) {
    const box = levels.getByLabel(`corp-model 思考档位 ${name}`);
    if (checked) await expect(box).toBeChecked();
    else await expect(box).not.toBeChecked();
  }

  // 勾上最高、去掉中：这个模型支持 关/低/高/最高
  await levels.getByLabel('corp-model 思考档位 最高').check();
  await levels.getByLabel('corp-model 思考档位 中').uncheck();
  await expect
    .poll(async () => (await readSettings(serviceWorker)).connections[0]?.capabilityOverrides?.['corp-model'])
    .toEqual({ thinking: 'effort', thinkingLevels: ['off', 'low', 'high', 'max'] });

  // 输入区的思考下拉按勾选的档位列；选「最高」后请求体里 reasoning_effort 为 max
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#p1');
  const select = frame.getByLabel('思考强度');
  await expectOptions(select, ['思考 关', '思考 低', '思考 高', '思考 最高']);
  await select.selectOption('max');
  await askInFloat(frame, r, '问一个问题');
  const body = parseBody(r.bodies[0]);
  expect(body.model).toBe('corp-model');
  expect(body.reasoning_effort).toBe('max');

  // 改回「按内置判断」：覆盖里的档位被删掉
  await page.goto(OPTIONS_URL);
  await page.getByTestId('advanced').locator('summary').first().click();
  await page.getByTestId('fold-connections').locator('summary').first().click();
  await page
    .getByTestId('fold-connections')
    .getByTestId('connection-item')
    .getByRole('button', { name: '编辑' })
    .click();
  const row2 = page
    .getByTestId('common-models')
    .getByTestId('capability-table')
    .locator('[data-model="corp-model"]');
  await row2.getByRole('button', { name: 'corp-model 的思考档位改回按内置判断' }).click();
  await expect
    .poll(async () => (await readSettings(serviceWorker)).connections[0]?.capabilityOverrides?.['corp-model'])
    .toEqual({ thinking: 'effort' });
  await expect(row2.getByLabel('corp-model 思考档位 中')).toBeChecked();
  await expect(row2.getByLabel('corp-model 思考档位 最高')).not.toBeChecked();
});
