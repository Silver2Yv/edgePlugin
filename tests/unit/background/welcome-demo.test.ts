// 欢迎页示例提问（demo/ask，contract-v1.5）：只认 welcome.html 所在标签页；选区按 sender.tab 存下、推给订阅者；
// 「解释」按默认模型起任务，没有默认模型时不发请求。拒绝时无副作用（规则 6、7）。
import { describe, expect, it } from 'vitest';
import type { SenderLike } from '@/background/deps';
import { SESSION_KEYS } from '@/core/domain/session-keys';
import { DEFAULT_SETTINGS } from '@/core/domain/settings';
import { EXT_ID, type Harness, makeHarness, SELECTED, TAB, until, WIN } from './harness';

const WELCOME_TAB = 21;

const welcomeSender = (over: Partial<SenderLike> = {}): SenderLike => ({
  id: EXT_ID,
  url: `chrome-extension://${EXT_ID}/welcome.html`,
  origin: `chrome-extension://${EXT_ID}`,
  tab: { id: WELCOME_TAB, windowId: WIN },
  frameId: 0,
  documentId: 'doc-welcome-1',
  ...over,
});

const demoAsk = (actionId: 'ask' | 'explain' = 'ask', extra: Record<string, unknown> = {}) => ({
  type: 'demo/ask',
  actionId,
  selectionRevision: 1_700_000_000_000,
  text: SELECTED,
  truncated: false,
  originalLength: [...SELECTED].length,
  ...extra,
});

async function readyPanel(h: Harness, tabId: number) {
  h.moveTab(tabId, WIN);
  const c = h.connect(h.panelSender());
  c.send({ type: 'conv/helloSidepanel', windowId: WIN });
  await until(() => c.ofType('conv/ready').length > 0, '侧边栏握手');
  c.send({ type: 'conv/subscribe', tabId });
  await until(() => c.ofType('conv/snapshot').length > 0, '订阅');
  return c;
}

describe('欢迎页示例提问 demo/ask', () => {
  it('问：选区记在欢迎页自己的标签页名下，推给已订阅的侧边栏，叫醒面板，不发模型请求', async () => {
    const h = makeHarness();
    h.setTabUrl(`chrome-extension://${EXT_ID}/welcome.html`, WELCOME_TAB);
    const panel = await readyPanel(h, WELCOME_TAB);
    const res = await h.message(demoAsk('ask'), welcomeSender());
    expect(res).toEqual({ ok: true, started: false });
    expect(panel.ofType('conv/quote').at(-1)).toMatchObject({
      selectionRevision: 1_700_000_000_000,
      text: SELECTED,
      truncated: false,
    });
    const stored = h.session.data.get(SESSION_KEYS.selection(WELCOME_TAB)) as {
      text: string;
      frameId: number;
    };
    expect(stored).toMatchObject({ text: SELECTED, frameId: 0, documentId: 'doc-welcome-1' });
    expect(h.session.data.has(SESSION_KEYS.selection(TAB))).toBe(false);
    expect(h.pageMessages).toContainEqual({ type: 'sidepanel/wake', windowId: WIN });
    expect(h.fetches).toHaveLength(0);
  });

  it('问之后在侧边栏发问：带上存下的示例选区', async () => {
    const h = makeHarness();
    h.setTabUrl(`chrome-extension://${EXT_ID}/welcome.html`, WELCOME_TAB);
    await h.message(demoAsk('ask'), welcomeSender());
    // 侧边栏晚于点击才订阅：订阅时取存下的选区
    const panel = await readyPanel(h, WELCOME_TAB);
    expect(panel.ofType('conv/quote')).toHaveLength(1);
    panel.send({
      type: 'conv/ask',
      clientRequestId: 'req-demo-0001',
      actionId: 'ask',
      text: '这和日落有什么关系？',
      selectionRevision: 1_700_000_000_000,
      contextTier: 'selection',
      lengthTier: 'brief',
      thinking: 'off',
      model: { connectionId: 'conn-test-0001', model: 'mock-flash' },
    });
    await until(() => h.fetches.length === 1, 'fetch');
    expect(String(h.fetches[0]?.init.body)).toContain(SELECTED);
  });

  it('解释：按默认模型起一个只带选区的任务，侧边栏订阅后看到这个任务', async () => {
    const h = makeHarness();
    h.setTabUrl(`chrome-extension://${EXT_ID}/welcome.html`, WELCOME_TAB);
    const res = await h.message(demoAsk('explain'), welcomeSender());
    expect(res).toEqual({ ok: true, started: true });
    await until(() => h.fetches.length === 1, 'fetch');
    const body = JSON.parse(String(h.fetches[0]?.init.body)) as { model: string; messages: unknown };
    expect(body.model).toBe('mock-flash');
    expect(JSON.stringify(body.messages)).toContain(SELECTED);
    const panel = await readyPanel(h, WELCOME_TAB);
    expect(panel.ofType('conv/subscribed')[0]).toMatchObject({ tabId: WELCOME_TAB, job: expect.anything() });
  });

  it('解释但还没有默认模型：选区照存，不发请求，回 noModel', async () => {
    const h = makeHarness();
    h.setSettings(structuredClone(DEFAULT_SETTINGS));
    const res = await h.message(demoAsk('explain'), welcomeSender());
    expect(res).toEqual({ ok: false, reason: 'noModel' });
    expect(h.session.data.has(SESSION_KEYS.selection(WELCOME_TAB))).toBe(true);
    expect(h.fetches).toHaveLength(0);
  });

  it.each([
    ['设置页发来', () => welcomeSender({ url: `chrome-extension://${EXT_ID}/options.html` })],
    ['不在标签页里', () => welcomeSender({ tab: undefined })],
    ['不是顶层框架', () => welcomeSender({ frameId: 3 })],
  ])('%s：拒绝，无副作用', async (_name, sender) => {
    const h = makeHarness();
    const res = await h.message(demoAsk('explain'), sender());
    expect(res).toEqual({ ok: false, reason: 'notAllowed' });
    expect([...h.session.data.keys()].filter((k) => k.startsWith('selection:'))).toEqual([]);
    expect(h.fetches).toHaveLength(0);
    expect(h.pageMessages).toHaveLength(0);
  });

  it('内容脚本发不了这条消息（角色不在授权表里）', async () => {
    const h = makeHarness();
    const res = await h.message(demoAsk('ask'), h.contentSender());
    expect(res).toMatchObject({ ok: false, reason: 'notAllowed' });
    expect([...h.session.data.keys()].filter((k) => k.startsWith('selection:'))).toEqual([]);
  });

  it.each([
    ['动作不在允许范围', { actionId: 'summarizePage' }],
    ['带了多余字段', { tabId: 7 }],
    ['带了地址', { url: 'https://evil.test/' }],
  ])('%s：按格式不对拒绝', async (_name, extra) => {
    const h = makeHarness();
    const res = await h.message(demoAsk('ask', extra), welcomeSender());
    expect(res).toMatchObject({ ok: false, reason: 'invalid' });
    expect([...h.session.data.keys()].filter((k) => k.startsWith('selection:'))).toEqual([]);
  });
});
