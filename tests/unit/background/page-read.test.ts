// 页面读取链路（5.6、6.1、4.1、D-01）：page/read → page/docPart 分片 → 后台校验、重算指纹、按 sender 盖章 → 缓存；
// 选区锚点定中心；站点「不读取」不抽取、不缓存、去掉历史旧正文；策略变更取消未发出的请求；导航后不套用旧选区。
import { describe, expect, it } from 'vitest';
import { makeAnchor } from '@/core/anchor/anchor';
import { contentVersionOf } from '@/core/context/content-version';
import type { BlockReport, PageDocReport } from '@/core/context/page-doc';
import { splitByJsonBytes } from '@/core/domain/bytes';
import { askMsg, click, type Harness, makeHarness, readyFloat, SETTINGS, TOP_DOC, until } from './harness';

function report(texts: string[], title = '测试文章'): PageDocReport {
  const blocks: BlockReport[] = texts.map((text, i) => ({
    id: `b${i + 1}`,
    kind: i === 0 ? 'heading' : 'paragraph',
    ...(i === 0 ? { level: 1 } : {}),
    text,
    headingPath: i === 0 ? [] : [texts[0] as string],
  }));
  return {
    contentVersion: contentVersionOf(title, blocks),
    title,
    blocks,
    notes: [],
    textLength: texts.reduce((n, t) => n + [...t].length, 0),
    extractedAt: 1,
  };
}

const PARAS = ['测试文章', ...Array.from({ length: 19 }, (_, i) => `第${i + 2}段：段落内容编号${i + 2}。`)];
/** 选区（click 的默认文字）放在第 10 块 */
const SELECTED = '光合作用把光能转成化学能。';
PARAS[9] = `第10段：${SELECTED}`;

type ReadMsg = { type: 'page/read'; readId: string; knownContentVersion?: string };
const reads = (h: Harness) =>
  h.sent.filter((s) => s.msg.type === 'page/read').map((s) => ({ ...s, msg: s.msg as unknown as ReadMsg }));

async function nextRead(h: Harness, n: number) {
  await until(() => reads(h).length >= n, `第 ${n} 次 page/read`);
  return reads(h)[n - 1] as ReturnType<typeof reads>[number];
}

/** 阅读器的应答：先锚点，再分片（故意切得很碎，验证拼合） */
async function respond(
  h: Harness,
  readId: string,
  doc: PageDocReport,
  opts: { documentId?: string; anchorBlock?: string; anchorVersion?: string; revision?: number } = {},
) {
  const sender = h.contentSender(0, opts.documentId ?? TOP_DOC);
  if (opts.anchorBlock) {
    const b = doc.blocks.find((x) => x.id === opts.anchorBlock) as BlockReport;
    const i = b.text.indexOf(SELECTED);
    const anchor = makeAnchor(b, i, i + SELECTED.length, 0.5);
    const r = await h.message(
      {
        type: 'selection/anchored',
        selectionRevision: opts.revision ?? 1,
        anchor: { ...anchor, headingPath: [...anchor.headingPath] },
        blockIds: [b.id],
        contentVersion: opts.anchorVersion ?? doc.contentVersion,
      },
      sender,
    );
    expect(r).toEqual({ ok: true });
  }
  const parts = splitByJsonBytes(JSON.stringify(doc), 300);
  for (const [index, data] of parts.entries()) {
    const r = await h.message({ type: 'page/docPart', readId, index, total: parts.length, data }, sender);
    expect(r).toEqual({ ok: true });
  }
}

const bodyOf = (h: Harness, i: number) =>
  JSON.parse(String(h.fetches[i]?.init.body)) as { messages: { role: string; content: string }[] };
const userTexts = (h: Harness, i: number) =>
  bodyOf(h, i)
    .messages.filter((m) => m.role !== 'system')
    .map((m) => JSON.stringify(m.content))
    .join('\n');
const plans = (c: { ofType: (t: string) => Record<string, unknown>[] }) =>
  c.ofType('conv/plan').map((m) => m.plan as Record<string, unknown>);
const notesOf = (c: { ofType: (t: string) => Record<string, unknown>[] }, i: number) =>
  ((plans(c)[i]?.notes ?? []) as string[]).join();
const sentOf = (c: { ofType: (t: string) => Record<string, unknown>[] }, i: number) =>
  (plans(c)[i]?.sentBlockIds ?? []) as string[];
const stateOf = (c: { ofType: (t: string) => Record<string, unknown>[] }) =>
  c.ofType('conv/jobState').map((m) => m.state);

async function finish(h: Harness, c: Awaited<ReturnType<typeof readyFloat>>, i: number) {
  const call = h.fetches[i] as Harness['fetches'][number];
  call.res.push('T:回答。\nF\n');
  call.res.close();
  await until(() => stateOf(c).filter((s) => s === 'completed').length === i + 1, '完成');
}

describe('页面读取 → nearby 装配', () => {
  it('分片拼合、指纹核对、按 sender 盖章；选区前后各 3 段进请求，计划与请求对得上', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    const doc = report(PARAS);
    c.send(askMsg({ contextTier: 'nearby' }));
    const r = await nextRead(h, 1);
    // 读取发给顶层框架的当前文档；接单先于读取（D-01：读取期间可取消）
    expect(r).toMatchObject({ frameId: 0, documentId: TOP_DOC });
    expect(r.msg.knownContentVersion).toBeUndefined();
    expect(c.ofType('conv/accepted')).toHaveLength(1);
    expect(h.fetches).toHaveLength(0);
    await respond(h, r.msg.readId, doc, { anchorBlock: 'b10' });
    await until(() => h.fetches.length === 1, '请求发出');
    const plan = plans(c)[0] as Record<string, unknown>;
    expect(plan).toMatchObject({
      contextTier: 'nearby',
      pageRead: true,
      sentBlockIds: ['b7', 'b8', 'b9', 'b10', 'b11', 'b12', 'b13'],
      pageKey: 'https://example.test/article',
      documentId: TOP_DOC,
      contentVersion: doc.contentVersion,
    });
    const sent = userTexts(h, 0);
    for (const id of plan.sentBlockIds as string[]) expect(sent).toContain(`[${id.slice(1)}]`);
    expect(sent).toContain('段落内容编号13');
    expect(sent).not.toContain('段落内容编号14');
    expect(sent).not.toContain('段落内容编号6');
    // 诊断日志只有结构，没有页面文字
    const logged = JSON.stringify(h.logs);
    expect(logged).toContain('ask/plan');
    expect(logged).not.toContain('段落内容');
    expect(logged).not.toContain(SELECTED);
  });

  it('同一文档再问：带上已知指纹，阅读器回 docUnchanged 就用缓存，不重传正文', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    const doc = report(PARAS);
    c.send(askMsg({ contextTier: 'nearby' }));
    await respond(h, (await nextRead(h, 1)).msg.readId, doc, { anchorBlock: 'b10' });
    await until(() => h.fetches.length === 1);
    await finish(h, c, 0);
    const conversationId = c.ofType('conv/accepted')[0]?.conversationId;
    c.send(askMsg({ contextTier: 'nearby', clientRequestId: 'req-00000002', conversationId }));
    const r2 = await nextRead(h, 2);
    expect(r2.msg.knownContentVersion).toBe(doc.contentVersion);
    const res = await h.message(
      { type: 'page/docUnchanged', readId: r2.msg.readId, contentVersion: doc.contentVersion },
      h.contentSender(0, TOP_DOC),
    );
    expect(res).toEqual({ ok: true });
    await until(() => h.fetches.length === 2);
    expect(plans(c)[1]).toMatchObject({ pageRead: true, contentVersion: doc.contentVersion });
    expect(userTexts(h, 1)).toContain('段落内容编号12');
  });

  it('伪造身份的分片被拒（规则 7）；篡改正文使指纹对不上时整份丢弃，只发选区', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'nearby' }));
    const r = await nextRead(h, 1);
    const doc = report(PARAS);
    const part = {
      type: 'page/docPart',
      readId: r.msg.readId,
      index: 0,
      total: 1,
      data: JSON.stringify(doc),
    };
    expect(await h.message(part, h.contentSender(0, 'doc-other'))).toEqual({ ok: false, reason: 'notOwner' });
    expect(await h.message(part, h.contentSender(2, TOP_DOC))).toEqual({ ok: false, reason: 'notOwner' });
    const tampered = {
      ...doc,
      blocks: doc.blocks.map((b) => ({ ...b, text: b.text.replace('编号', '篡改') })),
    };
    expect(await h.message({ ...part, data: JSON.stringify(tampered) }, h.contentSender(0, TOP_DOC))).toEqual(
      { ok: false, reason: 'invalid' },
    );
    await until(() => h.fetches.length === 1, '只发选区的请求');
    expect(plans(c)[0]).toMatchObject({ pageRead: false, sentBlockIds: [] });
    expect(notesOf(c, 0)).toContain('页面读取失败');
    expect(userTexts(h, 0)).not.toContain('篡改');
    expect(h.logs.some((l) => l.event === 'page/read' && l.detail?.result === 'versionMismatch')).toBe(true);
  });

  it('全文 → 选区降档：第二次不带全文，计划写明已移除先前的全文', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    const doc = report(PARAS);
    c.send(askMsg({ contextTier: 'fullPage' }));
    await respond(h, (await nextRead(h, 1)).msg.readId, doc, { anchorBlock: 'b10' });
    await until(() => h.fetches.length === 1);
    expect(plans(c)[0]).toMatchObject({ contextTier: 'fullPage', sentBlockIds: doc.blocks.map((b) => b.id) });
    expect(bodyOf(h, 0).messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    await finish(h, c, 0);
    const conversationId = c.ofType('conv/accepted')[0]?.conversationId;
    c.send(askMsg({ contextTier: 'selection', clientRequestId: 'req-00000002', conversationId }));
    await until(() => h.fetches.length === 2);
    expect(reads(h)).toHaveLength(1);
    expect(plans(c)[1]).toMatchObject({
      contextTier: 'selection',
      removedEarlierPageText: true,
      pageRead: false,
    });
    expect(userTexts(h, 1)).not.toContain('段落内容编号2');
  });
});

describe('站点策略（V-04）', () => {
  const noRead = { ...SETTINGS, sites: [{ host: 'example.test', level: 'noRead' as const }] };

  it('「不读取」站点：不发 page/read、不读正文，计划 pageRead=false 并说明', async () => {
    const h = makeHarness();
    h.setSettings(noRead);
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'fullPage' }));
    await until(() => h.fetches.length === 1);
    expect(reads(h)).toHaveLength(0);
    expect(plans(c)[0]).toMatchObject({ pageRead: false, sentBlockIds: [], contextTier: 'selection' });
    expect(notesOf(c, 0)).toContain('不读取页面内容');
    expect(userTexts(h, 0)).toContain(SELECTED);
  });

  it('对话中途改成「不读取」：缓存清掉，历史里先前发送的正文不再携带', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'nearby' }));
    await respond(h, (await nextRead(h, 1)).msg.readId, report(PARAS), { anchorBlock: 'b10' });
    await until(() => h.fetches.length === 1);
    await finish(h, c, 0);
    expect(h.app.cachedPageVersion(7)).toBeDefined();
    h.setSettings(noRead);
    h.app.onSettingsChanged(true);
    expect(h.app.cachedPageVersion(7)).toBeUndefined();
    const conversationId = c.ofType('conv/accepted')[0]?.conversationId;
    c.send(askMsg({ contextTier: 'nearby', clientRequestId: 'req-00000002', conversationId }));
    await until(() => h.fetches.length === 2);
    expect(reads(h)).toHaveLength(1);
    const second = userTexts(h, 1);
    expect(second).not.toContain('page_content');
    expect(second).not.toContain('段落内容编号');
    expect(second).toContain(SELECTED);
    expect(plans(c)[1]).toMatchObject({ pageRead: false, removedEarlierPageText: true });
  });

  it('读取期间改了策略：已接单未发出的请求取消（stopped），之后到达的正文不再使用', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'nearby' }));
    const r = await nextRead(h, 1);
    h.setSettings(noRead);
    h.app.onSettingsChanged(true);
    await until(() => stateOf(c).includes('stopped'), '取消');
    await respond(h, r.msg.readId, report(PARAS)).catch(() => undefined);
    await new Promise((res) => setTimeout(res, 20));
    expect(h.fetches).toHaveLength(0);
    expect(h.logs.some((l) => l.event === 'settings/sitesChanged' && l.detail?.cancelledJobs === 1)).toBe(
      true,
    );
  });

  it('读取期间设置变了但没收到变更事件：发请求前复核级别，同样取消', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'nearby' }));
    const r = await nextRead(h, 1);
    h.setSettings({ ...SETTINGS, sites: [{ host: 'example.test', level: 'noToolbar' }] });
    await respond(h, r.msg.readId, report(PARAS), { anchorBlock: 'b10' });
    await until(() => stateOf(c).includes('stopped'), '取消');
    expect(h.fetches).toHaveLength(0);
    expect(h.logs.some((l) => l.event === 'ask/policyChanged')).toBe(true);
  });

  it('选区在子框架里：不读顶层正文，计划说明', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click(), h.contentSender(2, 'doc-frame-2'));
    c.send(askMsg({ contextTier: 'nearby' }));
    await until(() => h.fetches.length === 1);
    expect(reads(h)).toHaveLength(0);
    expect(notesOf(c, 0)).toContain('子框架');
  });

  it('子框架的页面配置取顶层与框架来源更严', async () => {
    const h = makeHarness();
    h.setSettings({ ...SETTINGS, sites: [{ host: 'example.test', level: 'noToolbar' }] });
    h.setTabUrl('https://example.test/article');
    const frame = { ...h.contentSender(3, 'doc-frame-3'), url: 'https://other.test/embed' };
    expect(await h.message({ type: 'config/get' }, frame)).toMatchObject({ siteLevel: 'noToolbar' });
    h.setTabUrl('https://fine.test/');
    expect(await h.message({ type: 'config/get' }, frame)).toMatchObject({ siteLevel: 'normal' });
  });
});

describe('页面身份（V-06）', () => {
  it('导航后：选区属于旧文档，不套到新文档上', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    h.navigate('doc-top-2');
    c.send(askMsg({ contextTier: 'nearby' }));
    const r = await nextRead(h, 1);
    expect(r.documentId).toBe('doc-top-2');
    await respond(h, r.msg.readId, report(PARAS), { documentId: 'doc-top-2' });
    await until(() => h.fetches.length === 1);
    expect(plans(c)[0]).toMatchObject({ pageRead: false, sentBlockIds: [] });
    expect(notesOf(c, 0)).toContain('之前打开的页面');
  });

  it('内容变了（指纹不同）：锚点在新版本里重新定位，不沿用旧块号', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'nearby' }));
    const r = await nextRead(h, 1);
    // 新版本里前面插了两段，选区所在段落挪到 b12；锚点按旧版本的 b10 发来
    const moved = [...PARAS.slice(0, 2), '插入甲。', '插入乙。', ...PARAS.slice(2)];
    const newDoc = report(moved);
    const oldDoc = report(PARAS);
    const b10 = oldDoc.blocks[9] as BlockReport;
    const i = b10.text.indexOf(SELECTED);
    const anchor = makeAnchor(b10, i, i + SELECTED.length, 0.5);
    await h.message(
      {
        type: 'selection/anchored',
        selectionRevision: 1,
        anchor: { ...anchor, headingPath: [...anchor.headingPath] },
        blockIds: ['b10'],
        contentVersion: oldDoc.contentVersion,
      },
      h.contentSender(0, TOP_DOC),
    );
    await respond(h, r.msg.readId, newDoc);
    await until(() => h.fetches.length === 1);
    expect(sentOf(c, 0).includes('b12')).toBe(true);
    expect(plans(c)[0]).toMatchObject({ contentVersion: newDoc.contentVersion });
  });

  it('文字里找不到选区（没有锚点）：不猜位置，只发选区', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await h.message(click(1, 'ask', '页面里没有的文字'));
    c.send(askMsg({ contextTier: 'nearby' }));
    await respond(h, (await nextRead(h, 1)).msg.readId, report(PARAS));
    await until(() => h.fetches.length === 1);
    expect(plans(c)[0]).toMatchObject({ pageRead: false });
    expect(notesOf(c, 0)).toContain('没能在页面正文里找到选区');
  });
});
