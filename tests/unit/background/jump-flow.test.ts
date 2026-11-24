// 回到某一页（jump/open，contract-v1.6，决策 098）的后台流程：目标地址由后台按 pageKey / favoriteId 从库里取、
// 只开 http / https / file；本窗口已有那一页就切过去，没有就新开并等加载完成；加载超时、地址变了要给原因；
// 收藏带锚点时定位并高亮（站点不读取只打开页面）；只有侧边栏能发。
import { describe, expect, it } from 'vitest';
import type { JumpTabs, TabInfo } from '@/background/deps';
import { JUMP_RETRY_MS } from '@/background/jump';
import type { FavoriteRecord } from '@/core/domain/records';
import { type Harness, makeHarness, SETTINGS, TAB, until, WIN } from './harness';

type Conn = ReturnType<Harness['connect']>;

const PAGE_A = 'https://a.test/article';
const NEW_TAB = 50;
const ANCHOR = {
  exact: '叶绿素吸收红光',
  prefix: '第三段：',
  suffix: '和蓝光',
  blockDigest: 'abc',
  headingPath: [],
  scrollRatio: 0.4,
  offsetInBlock: 0,
};

/** 假的标签页操作：记下调用，标签页列表与加载结果由测试控制 */
function fakeTabs(
  h: Harness,
  initial: TabInfo[],
  opts: { wait?: 'complete' | 'timeout' | 'closed'; createdUrl?: string } = {},
) {
  const tabs = initial.map((t) => ({ ...t }));
  const calls: string[] = [];
  const impl: JumpTabs = {
    list: async (windowId) => {
      calls.push(`list:${windowId}`);
      return tabs.map((t) => ({ ...t }));
    },
    activate: async (tabId) => {
      calls.push(`activate:${tabId}`);
      for (const t of tabs) t.active = t.id === tabId;
    },
    create: async (windowId, url) => {
      calls.push(`create:${windowId}:${url}`);
      tabs.push({ id: NEW_TAB, url, active: true });
      // 新开的标签页加载完成后的地址：默认就是请求的地址，测试可以让它被重定向
      h.setTabUrl(opts.createdUrl ?? url, NEW_TAB);
      return NEW_TAB;
    },
    waitLoaded: async (tabId) => {
      calls.push(`wait:${tabId}`);
      return opts.wait ?? 'complete';
    },
  };
  h.deps.tabs = impl;
  return calls;
}

async function readyPanel(h: Harness) {
  const c = h.connect(h.panelSender());
  c.send({ type: 'conv/helloSidepanel', windowId: WIN });
  await until(() => c.ofType('conv/ready').length + c.ofType('conv/rejected').length > 0, '侧边栏握手');
  return c;
}

let n = 0;
const rid = () => `req-j-${String(++n).padStart(6, '0')}`;
const results = (c: Conn) =>
  c.ofType('jump/result') as {
    requestId: string;
    ok: boolean;
    tabId?: number;
    opened?: string;
    level?: string;
    reason?: string;
    back?: boolean;
  }[];

const favorite = (extra: Partial<FavoriteRecord> = {}): FavoriteRecord => ({
  id: 'fav-0000001',
  pageKey: PAGE_A,
  url: PAGE_A,
  selection: '叶绿素吸收红光',
  sourceText: '第三段：叶绿素吸收红光和蓝光',
  anchor: ANCHOR,
  blobIds: [],
  createdAt: 1,
  ...extra,
});

async function seedFavorite(h: Harness, extra: Partial<FavoriteRecord> = {}) {
  const f = favorite(extra);
  await h.db.write({ favorites: [f] });
  return f;
}

async function seedPage(h: Harness, pageKey = PAGE_A, url = PAGE_A) {
  await h.db.write({ pages: [{ pageKey, host: new URL(url).host, url, title: '甲', updatedAt: 1 }] });
}

const locates = (h: Harness) =>
  h.sent.filter((s) => s.msg.type === 'page/locate') as unknown as {
    tabId: number;
    frameId: number;
    documentId: string;
    msg: { requestId: string; highlight: boolean; anchor: { exact: string } };
  }[];

const sender = (h: Harness, tabId: number) => ({ ...h.contentSender(), tab: { id: tabId } });

/** 应答第 k 次 page/locate */
async function answerLocate(h: Harness, k: number, tabId: number, level: string, back = true) {
  await until(() => locates(h).length >= k, 'page/locate');
  const cmd = locates(h)[k - 1];
  await h.message(
    { type: 'page/locateResult', requestId: cmd?.msg.requestId, level, back },
    sender(h, tabId),
  );
}

describe('回到某一页：收藏的「回到原文」', () => {
  it('本窗口已有那一页（不是活动标签页）：切过去、不新开；锚点取自库，定位并高亮后回报', async () => {
    const h = makeHarness();
    const calls = fakeTabs(h, [
      { id: 6, url: 'https://other.test/', active: true },
      { id: TAB, url: PAGE_A, active: false },
    ]);
    h.setTabUrl(PAGE_A, TAB);
    await seedFavorite(h);
    const c = await readyPanel(h);
    const requestId = rid();
    c.send({ type: 'jump/open', requestId, favoriteId: 'fav-0000001' });
    await until(() => locates(h).length === 1, 'page/locate');
    expect(locates(h)[0]).toMatchObject({ tabId: TAB, frameId: 0 });
    expect(locates(h)[0]?.msg).toMatchObject({ highlight: true, anchor: { exact: '叶绿素吸收红光' } });
    await answerLocate(h, 1, TAB, 'exact');
    await until(() => results(c).length === 1, 'jump/result');
    expect(results(c)[0]).toEqual({
      type: 'jump/result',
      requestId,
      ok: true,
      tabId: TAB,
      opened: 'existing',
      level: 'exact',
      back: true,
    });
    expect(calls).toEqual([`list:${WIN}`, `activate:${TAB}`, `wait:${TAB}`]);
  });

  it('本窗口没有那一页：在本窗口新开，等加载完成再定位；地址只用库里的', async () => {
    const h = makeHarness();
    const calls = fakeTabs(h, [{ id: 6, url: 'https://other.test/', active: true }]);
    await seedFavorite(h);
    const c = await readyPanel(h);
    const requestId = rid();
    c.send({ type: 'jump/open', requestId, favoriteId: 'fav-0000001' });
    await until(() => locates(h).length === 1, 'page/locate');
    expect(locates(h)[0]?.tabId).toBe(NEW_TAB);
    await answerLocate(h, 1, NEW_TAB, 'fuzzy');
    await until(() => results(c).length === 1);
    expect(results(c)[0]).toMatchObject({ ok: true, tabId: NEW_TAB, opened: 'new', level: 'fuzzy' });
    expect(calls).toEqual([`list:${WIN}`, `create:${WIN}:${PAGE_A}`, `wait:${NEW_TAB}`]);
  });

  it('同一页带跟踪参数的标签页算已打开（按 pageKey 规则比）', async () => {
    const h = makeHarness();
    const calls = fakeTabs(h, [{ id: TAB, url: `${PAGE_A}?utm_source=x#frag`, active: true }]);
    h.setTabUrl(`${PAGE_A}?utm_source=x#frag`, TAB);
    await seedFavorite(h);
    const c = await readyPanel(h);
    c.send({ type: 'jump/open', requestId: rid(), favoriteId: 'fav-0000001' });
    await answerLocate(h, 1, TAB, 'exact');
    await until(() => results(c).length === 1);
    expect(results(c)[0]).toMatchObject({ opened: 'existing' });
    expect(calls.some((x) => x.startsWith('create'))).toBe(false);
    expect(calls.some((x) => x.startsWith('activate'))).toBe(false);
  });

  it('新开的页面第一次没找到：隔一会儿再试一次（单页应用还在渲染）；已打开的页面不重试', async () => {
    const h = makeHarness();
    fakeTabs(h, []);
    await seedFavorite(h);
    const c = await readyPanel(h);
    c.send({ type: 'jump/open', requestId: rid(), favoriteId: 'fav-0000001' });
    await answerLocate(h, 1, NEW_TAB, 'none', false);
    const t0 = Date.now();
    await answerLocate(h, 2, NEW_TAB, 'exact');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(JUMP_RETRY_MS - 50);
    await until(() => results(c).length === 1);
    expect(results(c)[0]).toMatchObject({ opened: 'new', level: 'exact' });

    const h2 = makeHarness();
    fakeTabs(h2, [{ id: TAB, url: PAGE_A, active: true }]);
    h2.setTabUrl(PAGE_A, TAB);
    await seedFavorite(h2);
    const c2 = await readyPanel(h2);
    c2.send({ type: 'jump/open', requestId: rid(), favoriteId: 'fav-0000001' });
    await answerLocate(h2, 1, TAB, 'none', false);
    await until(() => results(c2).length === 1);
    expect(results(c2)[0]).toMatchObject({ ok: true, level: 'none', reason: 'notFound' });
    expect(locates(h2)).toHaveLength(1);
  });

  it('站点设为不读取：只打开页面，说明原因，不让阅读器定位', async () => {
    const h = makeHarness();
    fakeTabs(h, [{ id: TAB, url: PAGE_A, active: true }]);
    h.setTabUrl(PAGE_A, TAB);
    h.setSettings({ ...SETTINGS, sites: [{ host: 'a.test', level: 'noRead' }] });
    await seedFavorite(h);
    const c = await readyPanel(h);
    c.send({ type: 'jump/open', requestId: rid(), favoriteId: 'fav-0000001' });
    await until(() => results(c).length === 1);
    expect(results(c)[0]).toMatchObject({ ok: true, tabId: TAB, level: 'none', reason: 'siteBlocked' });
    expect(locates(h)).toHaveLength(0);
  });

  it('没有锚点的收藏：只打开页面，回 noAnchor（界面按有没有来源对话决定显不显示）', async () => {
    const h = makeHarness();
    fakeTabs(h, [{ id: TAB, url: PAGE_A, active: true }]);
    h.setTabUrl(PAGE_A, TAB);
    const { anchor: _a, ...noAnchor } = favorite();
    await h.db.write({
      favorites: [{ ...noAnchor, source: { conversationId: 'conv-0000001', messageId: 'msg-0000001' } }],
    });
    const c = await readyPanel(h);
    c.send({ type: 'jump/open', requestId: rid(), favoriteId: 'fav-0000001' });
    await until(() => results(c).length === 1);
    expect(results(c)[0]).toMatchObject({ ok: true, tabId: TAB, reason: 'noAnchor' });
    expect(results(c)[0]?.level).toBeUndefined();
    expect(locates(h)).toHaveLength(0);
  });

  it('阅读器注入不了（浏览器内部页面等）：回 unavailable', async () => {
    const h = makeHarness();
    fakeTabs(h, [{ id: TAB, url: PAGE_A, active: true }]);
    h.setTabUrl(PAGE_A, TAB);
    h.deps.injectReader = async () => {
      throw new Error('Cannot access');
    };
    await seedFavorite(h);
    const c = await readyPanel(h);
    c.send({ type: 'jump/open', requestId: rid(), favoriteId: 'fav-0000001' });
    await until(() => results(c).length === 1);
    expect(results(c)[0]).toMatchObject({ ok: true, level: 'none', reason: 'unavailable' });
  });
});

describe('回到某一页：别的页面的对话', () => {
  it('按 pageKey 从库里取地址：切到或新开那一页，到了就回报，不定位', async () => {
    const h = makeHarness();
    const calls = fakeTabs(h, [{ id: 6, url: 'https://other.test/', active: true }]);
    await seedPage(h);
    const c = await readyPanel(h);
    const requestId = rid();
    c.send({ type: 'jump/open', requestId, pageKey: PAGE_A });
    await until(() => results(c).length === 1);
    expect(results(c)[0]).toEqual({
      type: 'jump/result',
      requestId,
      ok: true,
      tabId: NEW_TAB,
      opened: 'new',
    });
    expect(calls).toContain(`create:${WIN}:${PAGE_A}`);
    expect(locates(h)).toHaveLength(0);
  });
});

describe('回到某一页：到不了的原因', () => {
  async function jumpOnce(h: Harness, msg: Record<string, unknown>) {
    const c = await readyPanel(h);
    c.send({ type: 'jump/open', requestId: rid(), ...msg });
    await until(() => results(c).length === 1, 'jump/result');
    return results(c)[0];
  }

  it('库里没有这一页或这条收藏：noRecord，不开标签页', async () => {
    const h = makeHarness();
    const calls = fakeTabs(h, []);
    expect(await jumpOnce(h, { pageKey: PAGE_A })).toMatchObject({ ok: false, reason: 'noRecord' });
    const h2 = makeHarness();
    fakeTabs(h2, []);
    expect(await jumpOnce(h2, { favoriteId: 'fav-9999999' })).toMatchObject({
      ok: false,
      reason: 'noRecord',
    });
    expect(calls).toEqual([]);
  });

  it('地址不是 http / https / file：badUrl，不开标签页', async () => {
    for (const url of ['chrome://settings/', 'javascript:alert(1)', 'chrome-extension://abc/options.html']) {
      const h = makeHarness();
      const calls = fakeTabs(h, []);
      await seedFavorite(h, { url });
      expect(await jumpOnce(h, { favoriteId: 'fav-0000001' })).toMatchObject({ ok: false, reason: 'badUrl' });
      expect(calls).toEqual([]);
    }
  });

  it('file 地址可以打开（按整个地址比，不看 # 之后）', async () => {
    const h = makeHarness();
    const url = 'file:///C:/notes/a.html';
    const calls = fakeTabs(h, [{ id: TAB, url: `${url}#top`, active: true }]);
    h.setTabUrl(`${url}#top`, TAB);
    const { anchor: _a, ...noAnchor } = favorite({ url, pageKey: '' });
    await h.db.write({ favorites: [noAnchor] });
    const r = await jumpOnce(h, { favoriteId: 'fav-0000001' });
    expect(r).toMatchObject({ ok: true, tabId: TAB, opened: 'existing' });
    expect(calls.some((x) => x.startsWith('create'))).toBe(false);
  });

  it('加载超时：loadTimeout；中途被关：openFailed；没有标签页操作能力：openFailed', async () => {
    const h = makeHarness();
    fakeTabs(h, [], { wait: 'timeout' });
    await seedFavorite(h);
    expect(await jumpOnce(h, { favoriteId: 'fav-0000001' })).toMatchObject({
      ok: false,
      reason: 'loadTimeout',
    });
    expect(locates(h)).toHaveLength(0);

    const h2 = makeHarness();
    fakeTabs(h2, [], { wait: 'closed' });
    await seedFavorite(h2);
    expect(await jumpOnce(h2, { favoriteId: 'fav-0000001' })).toMatchObject({
      ok: false,
      reason: 'openFailed',
    });

    const h3 = makeHarness();
    await seedFavorite(h3);
    expect(await jumpOnce(h3, { favoriteId: 'fav-0000001' })).toMatchObject({
      ok: false,
      reason: 'openFailed',
    });
  });

  it('打开后地址变了（重定向到别处）：redirected，不定位', async () => {
    const h = makeHarness();
    fakeTabs(h, [], { createdUrl: 'https://login.test/signin' });
    await seedFavorite(h);
    expect(await jumpOnce(h, { favoriteId: 'fav-0000001' })).toMatchObject({
      ok: false,
      reason: 'redirected',
    });
    expect(locates(h)).toHaveLength(0);
  });
});

describe('回到某一页：授权', () => {
  it('小窗、内容脚本、设置页都不能发；两个目标都给或都不给：invalid', async () => {
    const h = makeHarness();
    fakeTabs(h, []);
    await seedFavorite(h);
    const float = h.connect();
    float.send({ type: 'jump/open', requestId: rid(), favoriteId: 'fav-0000001' });
    await until(() => float.ofType('conv/rejected').length === 1);
    expect(float.ofType('conv/rejected')[0]).toMatchObject({ reason: 'notAllowed', refType: 'jump/open' });
    expect(await h.message({ type: 'jump/open', requestId: rid(), favoriteId: 'fav-0000001' })).toMatchObject(
      {
        ok: false,
      },
    );

    const c = await readyPanel(h);
    c.send({ type: 'jump/open', requestId: rid() });
    c.send({ type: 'jump/open', requestId: rid(), pageKey: PAGE_A, favoriteId: 'fav-0000001' });
    // 消息里带地址之类的未知字段：拒绝（规则 6）
    c.send({ type: 'jump/open', requestId: rid(), favoriteId: 'fav-0000001', url: 'https://evil.test/' });
    await until(() => c.ofType('conv/rejected').length === 3);
    expect(c.ofType('conv/rejected').map((m) => m.reason)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(results(c)).toHaveLength(0);
  });

  it('只在握手定下的窗口里找标签页', async () => {
    const h = makeHarness();
    h.addWindow(2);
    const calls = fakeTabs(h, [{ id: TAB, url: PAGE_A, active: true }]);
    h.setTabUrl(PAGE_A, TAB);
    await seedPage(h);
    const c = h.connect(h.panelSender());
    c.send({ type: 'conv/helloSidepanel', windowId: 2 });
    await until(() => c.ofType('conv/ready').length === 1);
    c.send({ type: 'jump/open', requestId: rid(), pageKey: PAGE_A });
    await until(() => results(c).length === 1);
    expect(calls[0]).toBe('list:2');
  });
});
