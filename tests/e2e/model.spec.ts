// 模型下拉与连不上时切换（H4、H5、H6、H12、J10）：按连接分组只列勾选过的常用模型，切换后请求体里的 model
// 随之变化；「新对话」回到默认模型。默认模型连不上（network）时提示换个模型，选别的连接的模型后带着同样的问题
// 新发一问（不是 conv/retry）并成功。截图（模型下拉展开，小窗/侧边栏，亮/暗各一张）只在设了 UI_SHOTS_DIR 时保存。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import {
  askInFloat,
  connection,
  MODEL,
  parseBody,
  type Relay,
  selectAndOpen,
  settingsWith,
  startRelay,
  writeSettings,
} from './page-helpers';
import { attachPanel, openPanelByTrustedClick, type PanelHandle, panelText } from './sidepanel-helpers';

const ARTICLE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>模型下拉测试文章</title></head>
<body style="max-width: 720px; margin: 24px auto; font: 16px/1.7 system-ui">
<article><h1>模型下拉测试文章</h1>
<p id="p1">这是一段用来测试模型下拉与换模型再试的文字。</p>
</article></body></html>`;

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

const SHOTS = process.env.UI_SHOTS_DIR;
function saveShot(name: string, png: Buffer) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, name), png);
}

test('模型下拉按连接分组列出常用模型；切换后请求体里的 model 随之变化；新对话回到默认模型', async ({
  page,
  serviceWorker,
}) => {
  const connA = connection(r, { models: [MODEL, 'mock-pro'] });
  const connB = connection(r, { id: 'e2e-conn-0002', name: '连接二', models: ['other-model'] });
  await writeSettings(
    serviceWorker,
    settingsWith(r, { connections: [connA, connB], defaultModel: { connectionId: connA.id, model: MODEL } }),
  );
  await page.goto('https://e2e.test/article');
  if (SHOTS) await page.emulateMedia({ colorScheme: 'light' });
  const frame = await selectAndOpen(page, '#p1');
  await askInFloat(frame, r, '第一问');
  expect(parseBody(r.bodies[0]).model).toBe(MODEL);

  const trigger = frame.getByLabel('切换模型');
  await expect(trigger).toHaveText(MODEL);
  await trigger.click();
  await expect(frame.getByTestId('model-panel')).toBeVisible();
  // 按连接分组：两个连接的名字都出现
  await expect(frame.getByText('连接二')).toBeVisible();
  if (SHOTS) {
    await page.waitForTimeout(150);
    saveShot('float-light-model-panel.png', await page.screenshot());
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(150);
    saveShot('float-dark-model-panel.png', await page.screenshot());
    await page.emulateMedia({ colorScheme: 'light' });
  }
  await frame.locator('[data-testid="model-option"][data-model="other-model"]').click();
  await expect(trigger).toHaveText('other-model');

  await frame.getByLabel('输入问题').click();
  await askInFloat(frame, r, '第二问');
  expect(parseBody(r.bodies[1]).model).toBe('other-model');

  // 新对话：模型回到设置里的默认值
  await frame.getByRole('button', { name: '新对话' }).click();
  await expect(trigger).toHaveText(MODEL);
  await frame.getByLabel('输入问题').click();
  await askInFloat(frame, r, '第三问');
  expect(parseBody(r.bodies[2]).model).toBe(MODEL);
});

test('侧边栏：模型下拉同一个组件，深色下也能展开查看（截图）', async ({ context, page, serviceWorker }) => {
  test.skip(!SHOTS, '只在要截图时跑');
  const connA = connection(r, { models: [MODEL, 'mock-pro'] });
  const connB = connection(r, { id: 'e2e-conn-0002', name: '连接二', models: ['other-model'] });
  await writeSettings(
    serviceWorker,
    settingsWith(r, { connections: [connA, connB], defaultModel: { connectionId: connA.id, model: MODEL } }),
  );
  await page.goto('https://e2e.test/article');
  expect(await openPanelByTrustedClick(context)).toBe('ok');
  await page.bringToFront();
  const panel: PanelHandle = await attachPanel(context);
  await panel.cdp('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await panel.click('[aria-label="切换模型"]');
  await expect.poll(() => panelText(panel, 'model-panel')).not.toBe('');
  await page.waitForTimeout(200);
  const shot = async (name: string) => {
    const { data } = await panel.cdp<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    saveShot(name, Buffer.from(data, 'base64'));
  };
  await shot('sidepanel-light-model-panel.png');
  await panel.cdp('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await page.waitForTimeout(150);
  await shot('sidepanel-dark-model-panel.png');
});

test('默认模型连不上：失败后点「换个模型再试」，选别的连接的模型带着同样的问题重新发问并成功', async ({
  page,
  serviceWorker,
}) => {
  const broken = connection(r, {
    id: 'e2e-conn-broken',
    name: '连不上的连接',
    baseUrl: 'http://127.0.0.1:1/v1',
    models: ['broken-model'],
  });
  const working = connection(r, { id: 'e2e-conn-working', name: '备用连接', models: [MODEL] });
  await writeSettings(
    serviceWorker,
    settingsWith(r, {
      connections: [broken, working],
      defaultModel: { connectionId: broken.id, model: 'broken-model' },
    }),
  );
  await page.goto('https://e2e.test/article');
  const frame = await selectAndOpen(page, '#p1');
  const input = frame.getByLabel('输入问题');
  await expect(input).toBeFocused();
  await frame.page().keyboard.type('连不上的问题');
  await input.press('Enter');
  await expect(frame.getByTestId('job-state')).toHaveText('failed', { timeout: 15_000 });

  const switchArea = frame.getByTestId('switch-model');
  await expect(switchArea).toBeVisible();
  await switchArea.getByRole('button', { name: new RegExp(MODEL) }).click();

  await expect.poll(() => r.bodies.length).toBe(1);
  await expect(frame.getByTestId('job-state')).toHaveText('completed', { timeout: 15_000 });
  const body = parseBody(r.bodies[0]);
  expect(body.model).toBe(MODEL);
  expect(body.messages.at(-1)?.content).toContain('连不上的问题');
});
