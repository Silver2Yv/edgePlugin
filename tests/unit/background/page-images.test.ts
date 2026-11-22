// 页面图片（E2、5.14「页面图片（可选）」）：设置开关、向阅读器要选区所在块的图片地址（page/images，应答做运行时校验）、
// 后台取图的选项（不带凭据、不带自定义头、手动重定向）、重定向/非图片/超限被跳过并写进计划说明、
// 视觉能力为 no 时不取、开关关着不问阅读器；图片进请求、进图片表、地址进计划。
import { describe, expect, it } from 'vitest';
import { createPageImages } from '@/background/page-images';
import { makeAnchor } from '@/core/anchor/anchor';
import { contentVersionOf } from '@/core/context/content-version';
import type { BlockReport, PageDocReport } from '@/core/context/page-doc';
import { splitByJsonBytes } from '@/core/domain/bytes';
import { MAX_PAGE_IMAGES, parsePageImagesReply } from '@/core/domain/messages';
import type { MessageRecord } from '@/core/domain/records';
import { DEFAULT_SETTINGS } from '@/core/domain/settings';
import { askMsg, click, type Harness, makeHarness, readyFloat, SETTINGS, TOP_DOC, until } from './harness';

const IMG = 'https://img.test/a.png';
const IMG2 = 'https://img.test/b.png';
const ENCODED = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mime: 'image/png', width: 64, height: 48 };
const SELECTED = '光合作用把光能转成化学能。';

const imgResponse = (type = 'image/png', extra: Record<string, string> = {}) =>
  new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': type, ...extra } });

describe('page/images 应答校验', () => {
  const ok = { requestId: 'req-00000001', contentVersion: 'v1', urls: [IMG] };
  it('合法应答通过；非 http(s)、超过上限、多余字段、缺字段都拒绝', () => {
    expect(parsePageImagesReply(ok).ok).toBe(true);
    expect(parsePageImagesReply({ ...ok, urls: ['javascript:alert(1)'] }).ok).toBe(false);
    expect(parsePageImagesReply({ ...ok, urls: ['data:image/png;base64,AAAA'] }).ok).toBe(false);
    expect(parsePageImagesReply({ ...ok, urls: Array(MAX_PAGE_IMAGES + 1).fill(IMG) }).ok).toBe(false);
    expect(parsePageImagesReply({ ...ok, extra: 1 }).ok).toBe(false);
    expect(parsePageImagesReply({ requestId: 'req-00000001' }).ok).toBe(false);
    expect(parsePageImagesReply(undefined).ok).toBe(false);
  });
});

describe('createPageImages.collect：取图选项与跳过原因', () => {
  function setup(urls: string[], respond: (url: string) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const frames: unknown[] = [];
    const deps = {
      newId: () => 'req-00000001',
      requestFrame: async (_t: number, f: number, d: string, msg: unknown) => {
        frames.push({ f, d, msg });
        return { requestId: 'req-00000001', contentVersion: 'v1', urls };
      },
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return respond(url);
      },
      captureImages: {
        encodeImage: async () => ENCODED,
        process: async () => 'mismatch' as const,
        thumbnail: async () => '',
      },
    } as unknown as Parameters<typeof createPageImages>[0];
    return { svc: createPageImages(deps), calls, frames };
  }

  it('只发给顶层框架当前文档；fetch 不带凭据、手动重定向、不带 referrer、没有任何自定义请求头', async () => {
    const t = setup([IMG], () => imgResponse());
    const r = await t.svc.collect(3, TOP_DOC, ['b2'], 'v1');
    expect(r.images).toEqual([{ url: IMG, ...ENCODED }]);
    expect(t.frames).toEqual([
      {
        f: 0,
        d: TOP_DOC,
        msg: { type: 'page/images', requestId: 'req-00000001', blockIds: ['b2'], contentVersion: 'v1' },
      },
    ]);
    expect(t.calls).toHaveLength(1);
    const init = t.calls[0]?.init as RequestInit;
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer' });
    expect(init.headers).toBeUndefined();
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('重定向（含跨主机）、非图片、状态错误、声明超限、实际超限、网络失败：逐张跳过并写原因，其余照取', async () => {
    const big = new Response(new Uint8Array(5 * 1024 * 1024 + 1), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
    const table: Record<string, () => Response | Promise<Response>> = {
      'https://img.test/redir.png': () =>
        new Response(null, { status: 302, headers: { location: 'https://other.test/x.png' } }),
      'https://img.test/page.png': () => imgResponse('text/html'),
      'https://img.test/404.png': () => new Response('no', { status: 404 }),
      'https://img.test/declared.png': () => imgResponse('image/png', { 'content-length': '9999999' }),
      'https://img.test/actual.png': () => big,
      'https://img.test/down.png': () => Promise.reject(new TypeError('network')),
      [IMG]: () => imgResponse(),
    };
    const urls = Object.keys(table);
    const t = setup(urls.slice(0, 3), (u) => (table[u] as () => Response)());
    // 应答最多 3 张：分两次覆盖全部情形
    const a = await t.svc.collect(3, TOP_DOC, ['b2'], 'v1');
    expect(a.images).toHaveLength(0);
    expect(a.notes.join('\n')).toContain('重定向');
    expect(a.notes.join('\n')).toContain('不是图片');
    expect(a.notes.join('\n')).toContain('状态 404');
    const t2 = setup(urls.slice(3, 6), (u) => (table[u] as () => Response | Promise<Response>)());
    const b = await t2.svc.collect(3, TOP_DOC, ['b2'], 'v1');
    expect(b.images).toHaveLength(0);
    expect(b.notes.filter((n) => n.includes('大小上限'))).toHaveLength(2);
    expect(b.notes.join('\n')).toContain('没能取到');
    for (const n of [...a.notes, ...b.notes]) expect(n).toContain('https://img.test/');
  });

  it('编码失败（格式不支持）只跳过那一张', async () => {
    let calls = 0;
    const deps = {
      newId: () => 'req-00000001',
      requestFrame: async () => ({ requestId: 'req-00000001', contentVersion: 'v1', urls: [IMG, IMG2] }),
      fetch: async () => imgResponse(),
      captureImages: {
        encodeImage: async () => {
          if (++calls === 1) throw new Error('decode');
          return ENCODED;
        },
      },
    } as unknown as Parameters<typeof createPageImages>[0];
    const r = await createPageImages(deps).collect(3, TOP_DOC, ['b2'], 'v1');
    expect(r.images).toHaveLength(1);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain('无法读取');
  });

  it('应答的请求号或版本对不上、格式不对、阅读器没应答：当作没有图，不取、不报错', async () => {
    for (const reply of [
      { requestId: 'req-other', contentVersion: 'v1', urls: [IMG] },
      { requestId: 'req-00000001', contentVersion: 'v2', urls: [IMG] },
      { requestId: 'req-00000001', contentVersion: 'v1', urls: ['file:///etc/passwd'] },
      'garbage',
    ]) {
      let fetched = 0;
      const deps = {
        newId: () => 'req-00000001',
        requestFrame: async () => reply,
        fetch: async () => {
          fetched++;
          return imgResponse();
        },
      } as unknown as Parameters<typeof createPageImages>[0];
      expect(await createPageImages(deps).collect(3, TOP_DOC, ['b2'], 'v1')).toEqual({
        images: [],
        notes: [],
      });
      expect(fetched).toBe(0);
    }
    const dead = {
      newId: () => 'req-00000001',
      requestFrame: async () => Promise.reject(new Error('No document')),
      fetch: async () => imgResponse(),
    } as unknown as Parameters<typeof createPageImages>[0];
    expect(await createPageImages(dead).collect(3, TOP_DOC, ['b2'], 'v1')).toEqual({ images: [], notes: [] });
  });

  it('没有选区块时不问阅读器', async () => {
    const t = setup([IMG], () => imgResponse());
    expect(await t.svc.collect(3, TOP_DOC, [], 'v1')).toEqual({ images: [], notes: [] });
    expect(t.frames).toHaveLength(0);
  });
});

// ───────────── 发问全流程 ─────────────

function report(): PageDocReport {
  const texts = ['测试文章', ...Array.from({ length: 5 }, (_, i) => `第${i + 2}段内容。`)];
  texts[2] = `第3段：${SELECTED}`;
  const blocks: BlockReport[] = texts.map((text, i) => ({
    id: `b${i + 1}`,
    kind: i === 0 ? 'heading' : 'paragraph',
    ...(i === 0 ? { level: 1 } : {}),
    text,
    headingPath: i === 0 ? [] : [texts[0] as string],
  }));
  return {
    contentVersion: contentVersionOf('测试文章', blocks),
    title: '测试文章',
    blocks,
    notes: [],
    textLength: texts.reduce((n, t) => n + [...t].length, 0),
    extractedAt: 1,
  };
}

interface Fakes {
  imageFrames: { blockIds: string[]; contentVersion: string }[];
  imageFetches: { url: string; init: RequestInit }[];
  urls: string[];
}

function withPageImages(h: Harness, doc: PageDocReport, urls: string[]): Fakes {
  const f: Fakes = { imageFrames: [], imageFetches: [], urls };
  h.deps.requestFrame = async (_t, _f, _d, msg) => {
    const m = msg as unknown as {
      type: string;
      requestId: string;
      blockIds: string[];
      contentVersion: string;
    };
    f.imageFrames.push({ blockIds: m.blockIds, contentVersion: m.contentVersion });
    return { requestId: m.requestId, contentVersion: m.contentVersion, urls: f.urls };
  };
  h.deps.captureImages = {
    process: async () => 'mismatch',
    thumbnail: async () => '',
    encodeImage: async () => ENCODED,
  };
  const orig = h.deps.fetch;
  h.deps.fetch = async (url, init) => {
    if (url.startsWith('https://img.test/')) {
      f.imageFetches.push({ url, init });
      return imgResponse();
    }
    return orig(url, init);
  };
  void doc;
  return f;
}

async function answerRead(h: Harness, doc: PageDocReport) {
  await until(() => h.sent.some((s) => s.msg.type === 'page/read'), 'page/read');
  const readMsg = h.sent.find((s) => s.msg.type === 'page/read')?.msg as unknown as { readId: string };
  const { readId } = readMsg;
  const sender = h.contentSender(0, TOP_DOC);
  const b = doc.blocks.find((x) => x.id === 'b3') as BlockReport;
  const i = b.text.indexOf(SELECTED);
  const anchor = makeAnchor(b, i, i + SELECTED.length, 0.5);
  await h.message(
    {
      type: 'selection/anchored',
      selectionRevision: 1,
      anchor: { ...anchor, headingPath: [...anchor.headingPath] },
      blockIds: ['b3'],
      contentVersion: doc.contentVersion,
    },
    sender,
  );
  const parts = splitByJsonBytes(JSON.stringify(doc), 300);
  for (const [index, data] of parts.entries())
    await h.message({ type: 'page/docPart', readId, index, total: parts.length, data }, sender);
}

const withToggle = (on: boolean, vision?: 'no') => {
  const conn = {
    ...SETTINGS.connections[0],
    ...(vision ? { capabilityOverrides: { 'mock-flash': { vision } } } : {}),
  } as (typeof SETTINGS.connections)[number];
  return {
    ...SETTINGS,
    connections: [conn],
    context: { ...DEFAULT_SETTINGS.context, includePageImages: on },
  };
};

async function ask(h: Harness) {
  const doc = report();
  const c = await readyFloat(h);
  await h.message(click());
  c.send(askMsg({ contextTier: 'nearby' }));
  await answerRead(h, doc);
  return { c, doc };
}

describe('发问：页面图片', () => {
  it('开关打开：选区块的图进请求（图在文字前）、计划 imageCount 与地址、图片表与用户消息引用、删对话后解引用', async () => {
    const h = makeHarness();
    h.setSettings(withToggle(true));
    const doc = report();
    const f = withPageImages(h, doc, [IMG, IMG2]);
    const { c } = await ask(h);
    await until(() => h.fetches.length === 1, '请求发出');
    expect(f.imageFrames).toEqual([{ blockIds: ['b3'], contentVersion: doc.contentVersion }]);
    expect(f.imageFetches.map((x) => x.url)).toEqual([IMG, IMG2]);
    const body = JSON.parse(String(h.fetches[0]?.init.body)) as {
      messages: { role: string; content: { kind: string; dataUrl?: string; text?: string }[] }[];
    };
    const last = body.messages.at(-1)?.content ?? [];
    expect(last.slice(0, 2)).toEqual([
      { kind: 'image', dataUrl: ENCODED.dataUrl },
      { kind: 'image', dataUrl: ENCODED.dataUrl },
    ]);
    expect(last[2]?.text).toContain('2 张配图');
    // 凭据与地址：模型请求里没有图片地址，图片请求里没有模型 Key
    expect(JSON.stringify(body)).not.toContain('img.test');
    for (const x of f.imageFetches) expect(JSON.stringify(x.init)).not.toContain('test-secret-key');
    const plan = c.ofType('conv/plan')[0]?.plan as { imageCount: number; pageImageUrls: string[] };
    expect(plan.imageCount).toBe(2);
    expect(plan.pageImageUrls).toEqual([IMG, IMG2]);
    await until(() => h.db.tables.blobs.size === 2, '图片入库');
    const user = [...h.db.tables.messages.values()].find((m) => m.role === 'user') as MessageRecord;
    expect(user.images).toHaveLength(2);
    expect([...h.db.tables.blobs.values()].every((b) => b.refCount === 1)).toBe(true);
    await h.db.deleteConversation(user.conversationId);
    expect(h.db.tables.blobs.size).toBe(0);
  });

  it('页面里有读成的子框架（D10）：只问顶层阅读器，块号限顶层、版本用顶层自己的指纹（不是合并后的）', async () => {
    const h = makeHarness();
    h.setSettings(withToggle(true));
    const frame = { frameId: 2, documentId: 'doc-frame-2' };
    h.setFrames([frame]);
    const doc = report();
    const f = withPageImages(h, doc, [IMG]);
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'fullPage' }));
    await answerRead(h, doc);
    await until(() => h.sent.some((s) => s.msg.type === 'page/read' && s.frameId === 2), '子框架读取');
    const sub = h.sent.find((s) => s.msg.type === 'page/read' && s.frameId === 2)?.msg as unknown as {
      readId: string;
    };
    const innerBlocks: BlockReport[] = [
      { id: 'b1', kind: 'paragraph', text: '内嵌页面的正文。', headingPath: [] },
    ];
    const inner: PageDocReport = {
      contentVersion: contentVersionOf('内嵌页面', innerBlocks),
      title: '内嵌页面',
      blocks: innerBlocks,
      notes: [],
      textLength: 8,
      extractedAt: 1,
    };
    const parts = splitByJsonBytes(JSON.stringify(inner), 300);
    for (const [index, data] of parts.entries())
      await h.message(
        { type: 'page/docPart', readId: sub.readId, index, total: parts.length, data },
        h.frameSender(2, frame.documentId),
      );
    await until(() => h.fetches.length === 1, '请求发出');
    const plan = c.ofType('conv/plan')[0]?.plan as { contentVersion: string; imageCount: number };
    expect(plan.contentVersion).not.toBe(doc.contentVersion);
    expect(f.imageFrames).toEqual([{ blockIds: ['b3'], contentVersion: doc.contentVersion }]);
    expect(plan.imageCount).toBe(1);
  });

  it('开关关着（默认）：不问阅读器、不取图，请求里没有图片，计划没有地址', async () => {
    const h = makeHarness();
    h.setSettings(withToggle(false));
    const f = withPageImages(h, report(), [IMG]);
    const { c } = await ask(h);
    await until(() => h.fetches.length === 1, '请求发出');
    expect(f.imageFrames).toHaveLength(0);
    expect(f.imageFetches).toHaveLength(0);
    expect(JSON.stringify(h.fetches[0]?.init.body)).not.toContain('"kind":"image"');
    const plan = c.ofType('conv/plan')[0]?.plan as { imageCount: number; pageImageUrls?: string[] };
    expect(plan.imageCount).toBe(0);
    expect(plan.pageImageUrls).toBeUndefined();
  });

  it('模型视觉能力为「不支持」：不取图，计划说明里写原因，请求照常发出', async () => {
    const h = makeHarness();
    h.setSettings(withToggle(true, 'no'));
    const f = withPageImages(h, report(), [IMG]);
    const { c } = await ask(h);
    await until(() => h.fetches.length === 1, '请求发出');
    expect(f.imageFrames).toHaveLength(0);
    expect(f.imageFetches).toHaveLength(0);
    const plan = c.ofType('conv/plan')[0]?.plan as { imageCount: number; notes: string[] };
    expect(plan.imageCount).toBe(0);
    expect(plan.notes.join()).toContain('不支持看图');
  });

  it('档位为只看选中（没有页面块）：不取图', async () => {
    const h = makeHarness();
    h.setSettings(withToggle(true));
    const f = withPageImages(h, report(), [IMG]);
    const c = await readyFloat(h);
    await h.message(click());
    c.send(askMsg({ contextTier: 'selection' }));
    await until(() => h.fetches.length === 1, '请求发出');
    expect(f.imageFrames).toHaveLength(0);
  });

  it('取图被重定向拦下：图不进请求，计划说明写原因，请求照常发出', async () => {
    const h = makeHarness();
    h.setSettings(withToggle(true));
    const f = withPageImages(h, report(), [IMG]);
    const orig = h.deps.fetch;
    h.deps.fetch = async (url, init) =>
      url === IMG
        ? new Response(null, { status: 302, headers: { location: 'https://evil.test/x' } })
        : orig(url, init);
    const { c } = await ask(h);
    await until(() => h.fetches.length === 1, '请求发出');
    expect(f.imageFrames).toHaveLength(1);
    expect(JSON.stringify(h.fetches[0]?.init.body)).not.toContain('"kind":"image"');
    const plan = c.ofType('conv/plan')[0]?.plan as { imageCount: number; notes: string[] };
    expect(plan.imageCount).toBe(0);
    expect(plan.notes.join()).toContain('重定向');
  });
});
