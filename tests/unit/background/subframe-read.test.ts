// 子框架正文读取（D10，5.6）：顶层读完后探测所有框架，按站点矩阵与尺寸挑出要读的，注入子框架阅读器并行读取，
// 合并进同一份页面模型（块整页重新编号、排在顶层之后、指纹含子框架内容）；子框架里的选区在合并后的页面里找块。
import { describe, expect, it, vi } from 'vitest';
import { makeAnchor } from '@/core/anchor/anchor';
import { contentVersionOf } from '@/core/context/content-version';
import type { BlockReport, PageDocReport } from '@/core/context/page-doc';
import { splitByJsonBytes } from '@/core/domain/bytes';
import { askMsg, click, type Harness, makeHarness, readyFloat, SETTINGS, TOP_DOC, until } from './harness';

function report(texts: string[], title: string): PageDocReport {
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

const SELECTED = '光合作用把光能转成化学能。';
const TOP = report(['顶层标题', '顶层第一段：顶层正文内容。', '顶层第二段：还是顶层的内容。'], '顶层页面');
const INNER = report(['内嵌标题', `内嵌第一段：${SELECTED}`, '内嵌第二段：内嵌页面的其他内容。'], '内嵌页面');
const F2 = { frameId: 2, documentId: 'doc-frame-2' };
const F3 = { frameId: 3, documentId: 'doc-frame-3' };

type ReadMsg = { type: 'page/read'; readId: string; knownContentVersion?: string };
const readsTo = (h: Harness, frameId: number) =>
  h.sent
    .filter((s) => s.msg.type === 'page/read' && s.frameId === frameId)
    .map((s) => s.msg as unknown as ReadMsg);

async function waitRead(h: Harness, frameId: number, n = 1): Promise<ReadMsg> {
  await until(() => readsTo(h, frameId).length >= n, `发给框架 ${frameId} 的第 ${n} 次 page/read`);
  return readsTo(h, frameId)[n - 1] as ReadMsg;
}

async function respond(
  h: Harness,
  readId: string,
  doc: PageDocReport,
  sender: ReturnType<Harness['contentSender']>,
  anchorBlock?: string,
) {
  if (anchorBlock) {
    const b = doc.blocks.find((x) => x.id === anchorBlock) as BlockReport;
    const i = b.text.indexOf(SELECTED);
    const anchor = makeAnchor(b, i, i + SELECTED.length, 0.5);
    const r = await h.message(
      {
        type: 'selection/anchored',
        selectionRevision: 1,
        anchor: { ...anchor, headingPath: [...anchor.headingPath] },
        blockIds: [b.id],
        contentVersion: doc.contentVersion,
      },
      sender,
    );
    expect(r).toEqual({ ok: true });
  }
  const parts = splitByJsonBytes(JSON.stringify(doc), 300);
  for (const [index, data] of parts.entries()) {
    expect(
      await h.message({ type: 'page/docPart', readId, index, total: parts.length, data }, sender),
    ).toEqual({ ok: true });
  }
}

type C = Awaited<ReturnType<typeof readyFloat>>;
const plans = (c: C) => c.ofType('conv/plan').map((m) => m.plan as Record<string, unknown>);
const notesOf = (c: C, i = 0) => ((plans(c)[i]?.notes ?? []) as string[]).join();
const sentOf = (c: C, i = 0) => (plans(c)[i]?.sentBlockIds ?? []) as string[];
const userTexts = (h: Harness, i: number) =>
  (JSON.parse(String(h.fetches[i]?.init.body)) as { messages: { role: string; content: unknown }[] }).messages
    .filter((m) => m.role !== 'system')
    .map((m) => JSON.stringify(m.content))
    .join('\n');

/** 顶层先应答，再应答各子框架 */
async function answerAll(
  h: Harness,
  frames: { f: { frameId: number; documentId: string }; doc: PageDocReport; url?: string; anchor?: string }[],
  top: PageDocReport = TOP,
  topAnchor?: string,
) {
  await respond(h, (await waitRead(h, 0)).readId, top, h.contentSender(0, TOP_DOC), topAnchor);
  for (const { f, doc, url, anchor } of frames)
    await respond(
      h,
      (await waitRead(h, f.frameId)).readId,
      doc,
      h.frameSender(f.frameId, f.documentId, url),
      anchor,
    );
}

describe('子框架正文读取（D10）', () => {
  it('全文档位：子框架正文排在顶层之后、整页重新编号，请求与计划对得上；块的 frameId 取自 sender', async () => {
    const h = makeHarness();
    h.setFrames([F2]);
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'fullPage' }));
    await answerAll(h, [{ f: F2, doc: INNER }]);
    await until(() => h.fetches.length === 1, '请求发出');
    expect(h.injectedFrames).toEqual([2]);
    // 子框架的读取没有带已知指纹（子框架不进缓存）
    expect(readsTo(h, 2)[0]?.knownContentVersion).toBeUndefined();
    expect(sentOf(c)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
    const sent = userTexts(h, 0);
    expect(sent).toContain('内嵌第一段');
    expect(sent).toContain('顶层第二段');
    // 编号 4 是内嵌页面的标题块，在顶层 3 块之后
    expect(sent.indexOf('[3]')).toBeLessThan(sent.indexOf('内嵌标题'));
    const p = plans(c)[0] as { coverage: { sentChars: number; extractableChars: number } };
    expect(p.coverage.sentChars).toBe(p.coverage.extractableChars);
    expect(notesOf(c)).not.toContain('没有读取');
    // 正文内容不进诊断日志
    expect(JSON.stringify(h.logs)).not.toContain('内嵌第一段');
  });

  it('框架来源在「不读取」名单：不注入、不读，计划写明；「不弹工具栏」一级照矩阵仍可读', async () => {
    const h = makeHarness();
    h.setSettings({
      ...SETTINGS,
      sites: [
        { host: 'blocked.test', level: 'noRead' },
        { host: 'toolbar.test', level: 'noToolbar' },
      ],
    });
    h.setFrames([
      { ...F2, url: 'https://a.blocked.test/x' },
      { ...F3, url: 'https://toolbar.test/y' },
    ]);
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'fullPage' }));
    await answerAll(h, [{ f: F3, doc: INNER, url: 'https://toolbar.test/y' }]);
    await until(() => h.fetches.length === 1, '请求发出');
    expect(h.injectedFrames).toEqual([3]);
    expect(readsTo(h, 2)).toHaveLength(0);
    expect(notesOf(c)).toContain('1 个内嵌页面按站点规则不读取');
    expect(userTexts(h, 0)).toContain('内嵌第一段');
  });

  it('顶层在「不读取」名单：子框架同样不读，也不探测', async () => {
    const h = makeHarness();
    h.setSettings({ ...SETTINGS, sites: [{ host: 'example.test', level: 'noRead' }] });
    h.setFrames([F2]);
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'fullPage' }));
    await until(() => h.fetches.length === 1);
    expect(h.deps.probeSubframes).not.toHaveBeenCalled();
    expect(h.sent.filter((s) => s.msg.type === 'page/read')).toHaveLength(0);
    expect(plans(c)[0]).toMatchObject({ pageRead: false });
  });

  it('太小的框架跳过并说明；注入被浏览器拒绝的框架跳过并说明，顶层与其他框架照读', async () => {
    const h = makeHarness();
    h.setFrames([{ ...F2, tooSmall: true }, F3, { frameId: 4, documentId: 'doc-frame-4' }]);
    h.failInject.add(4);
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'fullPage' }));
    await answerAll(h, [{ f: F3, doc: INNER }]);
    await until(() => h.fetches.length === 1, '请求发出');
    expect(h.injectedFrames).toEqual([3]);
    expect(readsTo(h, 2)).toHaveLength(0);
    expect(notesOf(c)).toContain('1 个内嵌页面太小或不可见');
    expect(notesOf(c)).toContain('1 个内嵌页面读取失败');
    expect(userTexts(h, 0)).toContain('内嵌第一段');
  });

  it('子框架超时没应答：跳过并说明，不卡住这次发问', async () => {
    const h = makeHarness();
    h.setFrames([F2]);
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'fullPage' }));
    await respond(h, (await waitRead(h, 0)).readId, TOP, h.contentSender(0, TOP_DOC));
    await waitRead(h, 2);
    // 子框架一直不应答：等读取超时（READ_TIMEOUT_MS，真实计时）后照常发请求
    await vi.waitFor(
      () => {
        if (h.fetches.length !== 1) throw new Error('等待请求发出');
      },
      { timeout: 8000, interval: 20 },
    );
    expect(notesOf(c)).toContain('读取失败');
    expect(sentOf(c)).toEqual(['b1', 'b2', 'b3']);
  }, 12_000);

  it('身份取自 sender：别的框架冒充子框架应答被拒（notOwner）；子框架不能应答顶层的读取', async () => {
    const h = makeHarness();
    h.setFrames([F2]);
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'fullPage' }));
    const topRead = await waitRead(h, 0);
    const part = (readId: string, doc: PageDocReport) => ({
      type: 'page/docPart',
      readId,
      index: 0,
      total: 1,
      data: JSON.stringify(doc),
    });
    // 子框架拿顶层的 readId 应答
    expect(await h.message(part(topRead.readId, INNER), h.frameSender(2, F2.documentId))).toEqual({
      ok: false,
      reason: 'notOwner',
    });
    await respond(h, topRead.readId, TOP, h.contentSender(0, TOP_DOC));
    const subRead = await waitRead(h, 2);
    // 别的框架、别的文档拿子框架的 readId 应答
    expect(await h.message(part(subRead.readId, INNER), h.frameSender(5, F2.documentId))).toEqual({
      ok: false,
      reason: 'notOwner',
    });
    expect(await h.message(part(subRead.readId, INNER), h.frameSender(2, 'doc-other'))).toEqual({
      ok: false,
      reason: 'notOwner',
    });
    await respond(h, subRead.readId, INNER, h.frameSender(2, F2.documentId));
    await until(() => h.fetches.length === 1);
    expect(sentOf(c)).toHaveLength(6);
  });

  it('内容指纹含子框架：子框架内容变了，页面指纹变；顶层没变时仍走「未变」捷径', async () => {
    const h = makeHarness();
    h.setFrames([F2]);
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'fullPage' }));
    await answerAll(h, [{ f: F2, doc: INNER }]);
    await until(() => h.fetches.length === 1);
    const v1 = (plans(c)[0] as { contentVersion: string }).contentVersion;
    const call = h.fetches[0] as Harness['fetches'][number];
    call.res.push('T:好。\nF\n');
    call.res.close();
    await until(() => c.ofType('conv/jobState').some((m) => m.state === 'completed'));
    const conversationId = c.ofType('conv/accepted')[0]?.conversationId;
    // 第二次：顶层未变（docUnchanged），子框架内容改了
    c.send(askMsg({ contextTier: 'fullPage', clientRequestId: 'req-00000002', conversationId }));
    const r2 = await waitRead(h, 0, 2);
    expect(r2.knownContentVersion).toBe(TOP.contentVersion);
    expect(
      await h.message(
        { type: 'page/docUnchanged', readId: r2.readId, contentVersion: TOP.contentVersion },
        h.contentSender(0, TOP_DOC),
      ),
    ).toEqual({ ok: true });
    const changed = report(['内嵌标题', '内嵌第一段：内容被改写了。', '内嵌第二段：新增内容。'], '内嵌页面');
    await respond(h, (await waitRead(h, 2, 2)).readId, changed, h.frameSender(2, F2.documentId));
    await until(() => h.fetches.length === 2);
    const v2 = (plans(c)[1] as { contentVersion: string }).contentVersion;
    expect(v2).not.toBe(v1);
    expect(userTexts(h, 1)).toContain('内容被改写了');
    // 页面正文里不再有旧的内嵌内容（选区文字本身仍在 selected_text 里，不算）
    expect(userTexts(h, 1)).not.toContain('内嵌第一段：光合作用');
  });

  it('子框架里的选区：带上下文档位时在合并后的页面里找到所在块（锚点）', async () => {
    const h = makeHarness();
    h.setFrames([F2]);
    const c = await readyFloat(h);
    await h.message(click(), h.frameSender(2, F2.documentId));
    c.send(askMsg({ contextTier: 'nearby' }));
    await answerAll(h, [{ f: F2, doc: INNER, anchor: 'b2' }]);
    await until(() => h.fetches.length === 1, '请求发出');
    // 内嵌页面的 b2 在合并后是 b5；前后各取若干段，含内嵌页面前后文，没有顶层的段落
    expect(sentOf(c)).toContain('b5');
    expect(plans(c)[0]).toMatchObject({ pageRead: true, contextTier: 'nearby' });
    const sent = userTexts(h, 0);
    expect(sent).toContain('内嵌第二段');
    expect(notesOf(c)).not.toContain('没有按选区取前后段落');
  });

  it('子框架里的选区没有锚点：按文字在合并后的页面里找块', async () => {
    const h = makeHarness();
    h.setFrames([F2]);
    const c = await readyFloat(h);
    await h.message(click(), h.frameSender(2, F2.documentId));
    c.send(askMsg({ contextTier: 'nearby' }));
    await answerAll(h, [{ f: F2, doc: INNER }]);
    await until(() => h.fetches.length === 1, '请求发出');
    expect(sentOf(c)).toContain('b5');
  });

  it('顶层选区在带子框架的页面里仍用顶层锚点的块号：顶层与内嵌页面有同样的句子也不混', async () => {
    const h = makeHarness();
    h.setFrames([F2]);
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'nearby' }));
    const top = report(['顶层标题', `顶层第一段：${SELECTED}`, '顶层第二段。'], '顶层页面');
    await answerAll(h, [{ f: F2, doc: INNER }], top, 'b2');
    await until(() => h.fetches.length === 1, '请求发出');
    // 选中的句子在顶层 b2 和内嵌页面（合并后 b5）里各有一处：按块号只取顶层的，不当作位置不确定
    expect(sentOf(c)).toContain('b2');
    expect(notesOf(c)).not.toContain('位置不确定');
  });

  it('选区所在的子框架没读成：说明原因，不拿别处冒充选区位置', async () => {
    const h = makeHarness();
    h.setSettings({ ...SETTINGS, sites: [{ host: 'blocked.test', level: 'noRead' }] });
    h.setFrames([{ ...F2, url: 'https://blocked.test/x' }]);
    const c = await readyFloat(h);
    await h.message(click(), h.frameSender(2, F2.documentId, 'https://blocked.test/x'));
    c.send(askMsg({ contextTier: 'nearby' }));
    await respond(h, (await waitRead(h, 0)).readId, TOP, h.contentSender(0, TOP_DOC));
    await until(() => h.fetches.length === 1, '请求发出');
    expect(readsTo(h, 2)).toHaveLength(0);
    expect(notesOf(c)).toContain('选区所在的内嵌页面没有被读取');
    expect(sentOf(c)).toEqual([]);
    expect(userTexts(h, 0)).toContain(SELECTED);
  });

  it('引用落在内嵌页面的块上：回 subframe 原因，不发 page/locate；顶层的块照常定位', async () => {
    const h = makeHarness();
    h.setFrames([F2]);
    const c = await readyFloat(h);
    c.send(
      askMsg({
        contextTier: 'fullPage',
        actionId: 'summarizePage',
        text: '总结本页',
        selectionRevision: undefined,
        fresh: true,
      }),
    );
    await answerAll(h, [{ f: F2, doc: INNER }]);
    await until(() => h.fetches.length === 1, '请求发出');
    h.fetches[0]?.res.push('T:顶层要点【2】，内嵌要点【5】。\nF\n');
    h.fetches[0]?.res.close();
    await until(() => c.ofType('conv/jobState').some((m) => m.state === 'completed'), '完成');
    await h.app.history.search({ limit: 1 }); // 等排队的写库完成
    const messageId = (c.ofType('conv/accepted').at(-1) as { messageId: string }).messageId;
    const located = () => c.ofType('citation/located') as { level: string; reason?: string }[];
    c.send({ type: 'citation/locate', requestId: 'req-loc-00000001', messageId, citation: '5' });
    await until(() => located().length === 1, 'citation/located');
    expect(located()[0]).toMatchObject({ level: 'none', reason: 'subframe' });
    expect(h.sent.filter((s) => s.msg.type === 'page/locate')).toHaveLength(0);
    c.send({ type: 'citation/locate', requestId: 'req-loc-00000002', messageId, citation: '2' });
    await until(() => h.sent.some((s) => s.msg.type === 'page/locate'), 'page/locate');
  });
});
