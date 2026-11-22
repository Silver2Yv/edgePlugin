// 引用跳回原文（5.7、F1、F2、F4）与「总结本页」完整版（6.2、验收第 8 条）的后台流程：
// 编号只在那次请求发送的块里有效（规则 9）、只能定位所订阅标签页当前页面的引用、结果只认同一标签页顶层同一文档（规则 7）；
// 上次总结按内容版本标注，页面没变时再点「总结本页」不发新请求。
import { describe, expect, it } from 'vitest';
import { contentVersionOf } from '@/core/context/content-version';
import type { BlockReport, PageDocReport } from '@/core/context/page-doc';
import { splitByJsonBytes } from '@/core/domain/bytes';
import {
  askMsg,
  click,
  type Harness,
  makeHarness,
  readyFloat,
  SETTINGS,
  TAB,
  TOP_DOC,
  until,
  WIN,
} from './harness';

type Conn = ReturnType<Harness['connect']>;
const PAGE = 'https://example.test/article';

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
const PARAS = ['测试文章', '第二段讲光合作用。', '第三段：叶绿素吸收红光和蓝光。', '第四段。'];

const reads = (h: Harness) => h.sent.filter((s) => s.msg.type === 'page/read');
const readIdOf = (h: Harness, n: number) =>
  (reads(h)[n - 1]?.msg as unknown as { readId: string } | undefined)?.readId ?? '';

/** 应答第 n 次 page/read：回传整页 */
async function readPage(h: Harness, n: number, doc: PageDocReport) {
  await until(() => reads(h).length >= n, 'page/read');
  const readId = readIdOf(h, n);
  const parts = splitByJsonBytes(JSON.stringify(doc), 4000);
  for (const [index, data] of parts.entries())
    await h.message({ type: 'page/docPart', readId, index, total: parts.length, data }, h.contentSender());
}

/** 应答第 n 次 page/read：指纹没变 */
async function readUnchanged(h: Harness, n: number, doc: PageDocReport) {
  await until(() => reads(h).length >= n, 'page/read');
  await h.message(
    { type: 'page/docUnchanged', readId: readIdOf(h, n), contentVersion: doc.contentVersion },
    h.contentSender(),
  );
}

let reqs = 0;
const rid = () => `req-c-${String(++reqs).padStart(6, '0')}`;
const states = (c: Conn) => c.ofType('conv/jobState').map((m) => m.state);

/** 小窗里「总结本页」并答完，返回助手消息编号 */
async function summarize(h: Harness, c: Conn, doc: PageDocReport, answer: string, readNo = 1) {
  const n = h.fetches.length;
  const done = states(c).filter((s) => s === 'completed').length;
  c.send(
    askMsg({
      clientRequestId: rid(),
      actionId: 'summarizePage',
      text: '总结本页',
      selectionRevision: undefined,
      contextTier: 'fullPage',
      fresh: true,
    }),
  );
  await readPage(h, readNo, doc);
  await until(() => h.fetches.length === n + 1, '请求发出');
  h.fetches[n]?.res.push(`T:${answer}\nF\n`);
  h.fetches[n]?.res.close();
  await until(() => states(c).filter((s) => s === 'completed').length === done + 1, '完成');
  await h.app.history.search({ limit: 1 }); // 等排队的写库完成
  return (c.ofType('conv/accepted').at(-1) as { messageId: string }).messageId;
}

const locates = (h: Harness) =>
  h.sent
    .filter((s) => s.msg.type === 'page/locate')
    .map((s) => ({ ...s, msg: s.msg as unknown as LocateCmd }));
interface LocateCmd {
  requestId: string;
  anchor: { exact: string; blockDigest: string };
  blockId?: string;
  contentVersion?: string;
  highlight: boolean;
}
const located = (c: Conn) =>
  c.ofType('citation/located') as { requestId: string; level: string; reason?: string; back?: boolean }[];

async function locate(c: Conn, messageId: string, citation: string, quote?: string) {
  const requestId = rid();
  const before = located(c).length;
  c.send({ type: 'citation/locate', requestId, messageId, citation, ...(quote ? { quote } : {}) });
  return { requestId, before };
}

describe('引用跳回原文（5.7）', () => {
  it('逐字引用：后台按快照里的块建锚点，发给顶层阅读器的这个文档；阅读器回报精确，界面收到 exact 与可以回去', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const doc = report(PARAS);
    const id = await summarize(h, c, doc, '要点一【2】。原文：【3】叶绿素吸收红光【/3】');
    await locate(c, id, '3', '叶绿素吸收红光');
    await until(() => locates(h).length === 1, 'page/locate');
    const cmd = locates(h)[0];
    expect(cmd).toMatchObject({ tabId: TAB, frameId: 0, documentId: TOP_DOC });
    expect(cmd?.msg).toMatchObject({
      blockId: 'b3',
      contentVersion: doc.contentVersion,
      highlight: true,
      anchor: { exact: '叶绿素吸收红光', prefix: '第三段：' },
    });
    // 高亮样式注入了这个文档（没有提供 insertCss 的假依赖时跳过，不影响定位）
    const r = await h.message(
      { type: 'page/locateResult', requestId: cmd?.msg.requestId, level: 'exact', back: true },
      h.contentSender(),
    );
    expect(r).toEqual({ ok: true });
    await until(() => located(c).length === 1, 'citation/located');
    expect(located(c)[0]).toMatchObject({ level: 'exact', back: true });
  });

  it('要点编号：锚点是整块；结果只认同一标签页、顶层、同一文档发来的（规则 7）', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const doc = report(PARAS);
    const id = await summarize(h, c, doc, '要点一【2】。');
    await locate(c, id, '2');
    await until(() => locates(h).length === 1, 'page/locate');
    const cmd = locates(h)[0]?.msg as LocateCmd;
    expect(cmd.anchor.exact).toBe('第二段讲光合作用。');
    const fake = { type: 'page/locateResult', requestId: cmd.requestId, level: 'exact' };
    expect(await h.message(fake, h.contentSender(2, TOP_DOC))).toMatchObject({
      ok: false,
      reason: 'notOwner',
    });
    expect(await h.message(fake, h.contentSender(0, 'doc-other'))).toMatchObject({ ok: false });
    expect(located(c)).toHaveLength(0);
    await h.message({ ...fake, level: 'fuzzy', back: true }, h.contentSender());
    await until(() => located(c).length === 1, 'citation/located');
    expect(located(c)[0]).toMatchObject({ level: 'fuzzy', back: true });
  });

  it('编号不在那次发送的块里（规则 9）、消息没有计划：不发 page/locate，回 notCited', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const id = await summarize(h, c, report(PARAS), '编造的【99】。');
    await locate(c, id, '99');
    await until(() => located(c).length === 1);
    expect(located(c)[0]).toMatchObject({ level: 'none', reason: 'notCited' });
    await locate(c, 'msg-not-exist-0001', '2');
    await until(() => located(c).length === 2);
    expect(located(c)[1]).toMatchObject({ level: 'none', reason: 'notCited' });
    expect(locates(h)).toHaveLength(0);
  });

  it('标签页现在不是回答引用的那一页：otherPage；站点改为不读取：siteBlocked', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const id = await summarize(h, c, report(PARAS), '要点【2】。');
    h.setTabUrl('https://other.test/page');
    await locate(c, id, '2');
    await until(() => located(c).length === 1);
    expect(located(c)[0]).toMatchObject({ level: 'none', reason: 'otherPage' });
    h.setTabUrl(PAGE);
    h.setSettings({ ...SETTINGS, sites: [{ host: 'example.test', level: 'noRead' }] });
    await locate(c, id, '2');
    await until(() => located(c).length === 2);
    expect(located(c)[1]).toMatchObject({ level: 'none', reason: 'siteBlocked' });
    expect(locates(h)).toHaveLength(0);
  });

  it('快照过期：只能按引用原文，且原文须出现在回答里；没有原文时块号只在页面没变时可用，找不到回 expired', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const doc = report(PARAS);
    const id = await summarize(h, c, doc, '原文：【3】叶绿素吸收红光【/3】，要点【2】。');
    h.db.tables.snapshots.clear();
    // 回答里核对得上的原文：作为锚点
    await locate(c, id, '3', '叶绿素吸收红光');
    await until(() => locates(h).length === 1);
    expect(locates(h)[0]?.msg.anchor).toMatchObject({ exact: '叶绿素吸收红光', blockDigest: '' });
    // 回答里没有的「原文」不采信：锚点留空，只剩块号
    await locate(c, id, '3', '网页上没有的话');
    await until(() => locates(h).length === 2);
    const second = locates(h)[1]?.msg as LocateCmd;
    expect(second).toMatchObject({ blockId: 'b3', anchor: { exact: '' } });
    await h.message(
      { type: 'page/locateResult', requestId: second.requestId, level: 'none' },
      h.contentSender(),
    );
    await until(() => located(c).length === 1);
    expect(located(c)[0]).toMatchObject({ level: 'none', reason: 'expired' });
  });

  it('侧边栏也能定位所订阅标签页的引用；回到刚才的位置只在定位过之后、发给同一个文档', async () => {
    const h = makeHarness();
    const f = await readyFloat(h);
    const id = await summarize(h, f, report(PARAS), '要点【2】。');
    const p = h.connect(h.panelSender());
    p.send({ type: 'conv/helloSidepanel', windowId: WIN });
    await until(() => p.ofType('conv/ready').length > 0);
    p.send({ type: 'conv/subscribe', tabId: TAB });
    await until(() => p.ofType('conv/snapshot').some((m) => m.done));
    p.send({ type: 'citation/back', requestId: rid() });
    await until(() => p.ofType('conv/rejected').length === 1);
    expect(p.ofType('conv/rejected')[0]).toMatchObject({ reason: 'notAllowed', refType: 'citation/back' });
    await locate(p, id, '2');
    await until(() => locates(h).length === 1);
    p.send({ type: 'citation/back', requestId: rid() });
    await until(() => h.sent.some((s) => s.msg.type === 'page/back'));
    expect(h.sent.find((s) => s.msg.type === 'page/back')).toMatchObject({ frameId: 0, documentId: TOP_DOC });
  });
});

const lastOf = (c: Conn) =>
  c.ofType('summary/last') as {
    requestId?: string;
    tabId: number;
    show?: boolean;
    summary?: { message: { id: string }; contentVersion: string; current: string };
  }[];

describe('「总结本页」完整版（6.2）', () => {
  it('summary/get：没有上次总结时空；有了之后让阅读器算一次指纹，没变是 same、变了是 changed', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    c.send({ type: 'summary/get', requestId: rid() });
    await until(() => lastOf(c).length === 1);
    expect(lastOf(c)[0]?.summary).toBeUndefined();

    const doc = report(PARAS);
    const id = await summarize(h, c, doc, '这页讲了光合作用【2】。');
    c.send({ type: 'summary/get', requestId: rid() });
    await readUnchanged(h, 2, doc);
    await until(() => lastOf(c).length === 2);
    expect(lastOf(c)[1]).toMatchObject({
      tabId: TAB,
      summary: { message: { id }, contentVersion: doc.contentVersion, current: 'same' },
    });
    expect(lastOf(c)[1]?.show).toBeUndefined();

    const changed = report([...PARAS.slice(0, 3), '第四段改过了。']);
    c.send({ type: 'summary/get', requestId: rid() });
    await readPage(h, 3, changed);
    await until(() => lastOf(c).length === 3);
    expect(lastOf(c)[2]?.summary).toMatchObject({ contentVersion: doc.contentVersion, current: 'changed' });
  });

  it('站点设为不读取：不注入、不抽取，版本记 unknown', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    await summarize(h, c, report(PARAS), '总结。');
    const readsBefore = reads(h).length;
    h.setSettings({ ...SETTINGS, sites: [{ host: 'example.test', level: 'noRead' }] });
    c.send({ type: 'summary/get', requestId: rid() });
    await until(() => lastOf(c).length === 1);
    expect(lastOf(c)[0]?.summary?.current).toBe('unknown');
    expect(reads(h)).toHaveLength(readsBefore);
  });

  it('再点工具栏「总结本页」：页面没变就推上次的总结（show），不发新请求；页面变了照常发起新总结', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    const doc = report(PARAS);
    const id = await summarize(h, c, doc, '总结【2】。');
    await h.message(click(2, 'summarizePage'));
    await readUnchanged(h, 2, doc);
    await until(() => lastOf(c).some((m) => m.show === true), '推上次总结');
    expect(lastOf(c).find((m) => m.show)).toMatchObject({ summary: { message: { id }, current: 'same' } });
    expect(lastOf(c).find((m) => m.show)?.requestId).toBeUndefined();
    expect(h.fetches).toHaveLength(1);
    // 刚打开、还没订阅的界面（侧边栏）订阅后来取时也带上 show
    c.send({ type: 'summary/get', requestId: rid() });
    await readUnchanged(h, 3, doc);
    await until(() => lastOf(c).filter((m) => m.requestId !== undefined).length === 1);
    expect(lastOf(c).at(-1)?.show).toBe(true);

    const changed = report([...PARAS.slice(0, 3), '第四段改过了。']);
    await h.message(click(3, 'summarizePage'));
    await readPage(h, 4, changed);
    // 新总结的读取：指纹与刚才缓存的相同，阅读器只回「没变」
    await readUnchanged(h, 5, changed);
    await until(() => h.fetches.length === 2, '新总结发出');
  });

  it('快捷键「总结本页」同样复用；没有上次总结时照常发起', async () => {
    const h = makeHarness();
    const c = await readyFloat(h);
    h.app.onCommand('summarize-page', { id: TAB, windowId: WIN, url: PAGE });
    await readPage(h, 1, report(PARAS));
    await until(() => h.fetches.length === 1, '第一次总结发出');
    h.fetches[0]?.res.push('T:总结。\nF\n');
    h.fetches[0]?.res.close();
    await until(() => states(c).includes('completed'));
    await h.app.history.search({ limit: 1 });
    h.app.onCommand('summarize-page', { id: TAB, windowId: WIN, url: PAGE });
    await readUnchanged(h, 2, report(PARAS));
    await until(() => lastOf(c).some((m) => m.show === true));
    expect(h.fetches).toHaveLength(1);
  });
});
