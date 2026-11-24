// 外部图片粘贴的后台流程（决策 099）：分片收齐 → 缩放编码 → 存成这个标签页待确认的图（与框选截图同一位置，
// 新图替换旧图）→ 只推缩略图；发问带图（与框选截图一致：noVision 拒绝、原图进请求、说明这是外部图片）；
// 超限、不是图片、分片乱序的处理；侧边栏同样可用。
import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '@/core/capture/data-url';
import { MAX_PASTE_BYTES, PASTE_CHUNK_BYTES, pasteChunkCount } from '@/core/capture/paste';
import type { MessageRecord } from '@/core/domain/records';
import { EXTERNAL_IMAGE_LEAD } from '@/core/prompt/ask';
import { askMsg, type Harness, makeHarness, readyFloat, SETTINGS, TAB, until, WIN } from './harness';

type Conn = ReturnType<Harness['connect']>;

const FULL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const pngBytes = (n: number) => {
  const b = new Uint8Array(n);
  b.set(PNG_HEAD.slice(0, Math.min(n, 8)));
  for (let i = 8; i < n; i++) b[i] = i % 253;
  return b;
};

interface Fakes {
  encoded: { size: number; type: string }[];
  encodeImage: (b: Blob) => Promise<{ dataUrl: string; mime: string; width: number; height: number }>;
}

function withImages(h: Harness): Fakes {
  const f: Fakes = {
    encoded: [],
    encodeImage: async () => ({ dataUrl: FULL, mime: 'image/png', width: 200, height: 100 }),
  };
  h.deps.captureImages = {
    process: async () => 'mismatch',
    thumbnail: async () => THUMB,
    encodeImage: async (b) => {
      f.encoded.push({ size: b.size, type: b.type });
      return f.encodeImage(b);
    },
  };
  return f;
}

/** 把一张图按协议发出去（begin + 分片） */
function paste(c: Conn, bytes: Uint8Array, uploadId = 'up-00000001', mime = 'image/png') {
  c.send({ type: 'paste/begin', uploadId, mime, size: bytes.length, chunks: pasteChunkCount(bytes.length) });
  for (let i = 0; i < pasteChunkCount(bytes.length); i++)
    c.send({
      type: 'paste/chunk',
      uploadId,
      index: i,
      data: bytesToBase64(bytes.subarray(i * PASTE_CHUNK_BYTES, (i + 1) * PASTE_CHUNK_BYTES)),
    });
}

describe('粘贴 → 预览', () => {
  it('小窗：几片收齐，后台缩放编码，预览只带缩略图并标 external；原图只在 storage.session，数据库没有', async () => {
    const h = makeHarness();
    const f = withImages(h);
    const c = await readyFloat(h);
    const bytes = pngBytes(PASTE_CHUNK_BYTES * 3 + 11);
    paste(c, bytes);
    await until(() => c.ofType('conv/capture').length === 1, '预览');
    const preview = c.ofType('conv/capture')[0];
    expect(preview).toMatchObject({ thumb: THUMB, width: 200, height: 100, external: true });
    // 交给编码的就是收齐的原图字节
    expect(f.encoded).toEqual([{ size: bytes.length, type: 'image/png' }]);
    // 界面收到的只有缩略图
    expect(JSON.stringify(c.received)).not.toContain(FULL);
    expect(h.session.data.get(`capture:${TAB}`)).toMatchObject({
      captureId: preview?.captureId,
      dataUrl: FULL,
      external: true,
    });
    expect(h.db.tables.blobs.size).toBe(0);
  });

  it('再粘贴一张：替换旧图，旧图的预览被收起', async () => {
    const h = makeHarness();
    withImages(h);
    const c = await readyFloat(h);
    paste(c, pngBytes(500), 'up-00000001');
    await until(() => c.ofType('conv/capture').length === 1, '第一张');
    const first = c.ofType('conv/capture')[0]?.captureId;
    paste(c, pngBytes(600), 'up-00000002');
    await until(() => c.ofType('conv/capture').length === 2, '第二张');
    const second = c.ofType('conv/capture')[1]?.captureId;
    expect(second).not.toBe(first);
    expect(c.ofType('conv/captureCleared').map((m) => m.captureId)).toContain(first);
    expect(h.session.data.get(`capture:${TAB}`)).toMatchObject({ captureId: second });
  });

  it('侧边栏同样可以粘贴（订阅的标签页）', async () => {
    const h = makeHarness();
    withImages(h);
    const p = h.connect(h.panelSender());
    p.send({ type: 'conv/helloSidepanel', windowId: WIN });
    await until(() => p.ofType('conv/ready').length > 0, '握手');
    p.send({ type: 'conv/subscribe', tabId: TAB });
    await until(() => p.ofType('conv/snapshot').length > 0, '订阅');
    paste(p, pngBytes(900));
    await until(() => p.ofType('conv/capture').length === 1, '预览');
    expect(p.ofType('conv/capture')[0]).toMatchObject({ external: true });
  });

  it('订阅之前（没有目标标签页）粘贴：拒绝', async () => {
    const h = makeHarness();
    withImages(h);
    const p = h.connect(h.panelSender());
    p.send({ type: 'conv/helloSidepanel', windowId: WIN });
    await until(() => p.ofType('conv/ready').length > 0, '握手');
    paste(p, pngBytes(100));
    await until(() => p.ofType('conv/rejected').length > 0, '拒绝');
    expect(p.ofType('conv/capture')).toHaveLength(0);
  });

  it('重新订阅（小窗重连）时补发预览，仍带 external', async () => {
    const h = makeHarness();
    withImages(h);
    const c = await readyFloat(h);
    paste(c, pngBytes(300));
    await until(() => c.ofType('conv/capture').length === 1, '预览');
    c.send({ type: 'conv/subscribe' });
    await until(() => c.ofType('conv/capture').length === 2, '补发');
    expect(c.ofType('conv/capture')[1]).toMatchObject({ external: true });
  });
});

describe('粘贴的校验（后台不信界面）', () => {
  it('声明的大小超过上限：回 captureFailed(tooLarge)，不收分片、不编码', async () => {
    const h = makeHarness();
    const f = withImages(h);
    const c = await readyFloat(h);
    const size = MAX_PASTE_BYTES + 1;
    c.send({
      type: 'paste/begin',
      uploadId: 'up-00000001',
      mime: 'image/png',
      size,
      chunks: pasteChunkCount(size),
    });
    await until(() => c.ofType('conv/captureFailed').length === 1, '提示');
    expect(c.ofType('conv/captureFailed')[0]).toMatchObject({ reason: 'tooLarge' });
    c.send({ type: 'paste/chunk', uploadId: 'up-00000001', index: 0, data: 'AAAA' });
    await until(() => c.ofType('conv/rejected').length === 1, '拒绝');
    expect(f.encoded).toHaveLength(0);
    expect(c.ofType('conv/capture')).toHaveLength(0);
  });

  it('文件头不是声明的图片类型：badImage，不编码', async () => {
    const h = makeHarness();
    const f = withImages(h);
    const c = await readyFloat(h);
    paste(c, new TextEncoder().encode('<html>这不是图片</html>'));
    await until(() => c.ofType('conv/captureFailed').length === 1, '提示');
    expect(c.ofType('conv/captureFailed')[0]).toMatchObject({ reason: 'badImage' });
    expect(f.encoded).toHaveLength(0);
    expect(h.session.data.has(`capture:${TAB}`)).toBe(false);
  });

  it('浏览器解码失败（文件头对、内容损坏）：badImage，没有待确认的图', async () => {
    const h = makeHarness();
    const f = withImages(h);
    f.encodeImage = async () => {
      throw new Error('The source image could not be decoded.');
    };
    const c = await readyFloat(h);
    paste(c, pngBytes(300));
    await until(() => c.ofType('conv/captureFailed').length === 1, '提示');
    expect(c.ofType('conv/captureFailed')[0]).toMatchObject({ reason: 'badImage' });
    expect(h.session.data.has(`capture:${TAB}`)).toBe(false);
  });

  it('分片顺序不对：拒绝（invalid），整次丢弃，没有预览', async () => {
    const h = makeHarness();
    const f = withImages(h);
    const c = await readyFloat(h);
    const bytes = pngBytes(PASTE_CHUNK_BYTES * 2);
    c.send({
      type: 'paste/begin',
      uploadId: 'up-00000001',
      mime: 'image/png',
      size: bytes.length,
      chunks: 2,
    });
    c.send({
      type: 'paste/chunk',
      uploadId: 'up-00000001',
      index: 1,
      data: bytesToBase64(bytes.subarray(PASTE_CHUNK_BYTES)),
    });
    await until(() => c.ofType('conv/rejected').length === 1, '拒绝');
    expect(c.ofType('conv/rejected')[0]).toMatchObject({ reason: 'invalid' });
    expect(f.encoded).toHaveLength(0);
    expect(c.ofType('conv/capture')).toHaveLength(0);
  });

  it('网页内容脚本不能发 paste/*（授权表）', async () => {
    const h = makeHarness();
    const f = withImages(h);
    await h.message({ type: 'paste/begin', uploadId: 'up-00000001', mime: 'image/png', size: 10, chunks: 1 });
    expect(f.encoded).toHaveLength(0);
    expect(h.session.data.has(`capture:${TAB}`)).toBe(false);
  });
});

describe('粘贴的图发问', () => {
  async function pasted(h: Harness) {
    const c = await readyFloat(h);
    paste(c, pngBytes(400));
    await until(() => c.ofType('conv/capture').length === 1, '预览');
    return { c, id: c.ofType('conv/capture')[0]?.captureId as string };
  }

  it('原图进请求（image_url 的来源）、文字里说明是外部图片没有页面位置；图片表 refCount 1；预览收起；追问不重发', async () => {
    const h = makeHarness();
    withImages(h);
    const { c, id } = await pasted(h);
    c.send(askMsg({ captureId: id, text: '这张图讲了什么', selectionRevision: undefined }));
    await until(() => h.fetches.length === 1, '请求');
    const body = JSON.parse(String(h.fetches[0]?.init.body)) as {
      messages: { role: string; content: { kind: string; dataUrl?: string; text?: string }[] }[];
    };
    const last = body.messages.at(-1);
    expect(last?.content[0]).toEqual({ kind: 'image', dataUrl: FULL });
    const text = last?.content.find((p) => p.kind === 'text')?.text ?? '';
    expect(text).toContain(EXTERNAL_IMAGE_LEAD);
    expect(text).toContain('这张图讲了什么');
    await until(() => c.ofType('conv/accepted').length === 1, '接单');
    expect(h.logs.find((l) => l.event === 'ask/plan')?.detail?.imageCount).toBe(1);
    const user = [...h.db.tables.messages.values()].find((m) => m.role === 'user') as MessageRecord;
    expect(user.images).toHaveLength(1);
    expect(h.db.tables.blobs.get(user.images?.[0]?.blobId ?? '')).toMatchObject({
      mime: 'image/png',
      refCount: 1,
    });
    await until(() => c.ofType('conv/captureCleared').length > 0, 'captureCleared');
    expect(h.session.data.has(`capture:${TAB}`)).toBe(false);
  });

  it('没打字也能发（默认问题），框选截图的说明句不出现', async () => {
    const h = makeHarness();
    withImages(h);
    const { c, id } = await pasted(h);
    c.send(askMsg({ captureId: id, text: '', selectionRevision: undefined }));
    await until(() => h.fetches.length === 1, '请求');
    const body = String(h.fetches[0]?.init.body);
    expect(body).toContain('请看这张截图');
    expect(body).not.toContain('在网页上框选的截图');
  });

  it('模型视觉能力为「不支持」：拒绝 noVision，图留着、不发请求', async () => {
    const h = makeHarness();
    withImages(h);
    const conn = {
      ...SETTINGS.connections[0],
      capabilityOverrides: { 'mock-flash': { vision: 'no' as const } },
    };
    h.setSettings({ ...SETTINGS, connections: [conn as (typeof SETTINGS.connections)[number]] });
    const { c, id } = await pasted(h);
    c.send(askMsg({ captureId: id, text: '图里是什么', selectionRevision: undefined }));
    await until(() => c.ofType('conv/rejected').length > 0, '拒绝');
    expect(c.ofType('conv/rejected')[0]).toMatchObject({ reason: 'noVision' });
    expect(h.fetches).toHaveLength(0);
    expect(h.session.data.has(`capture:${TAB}`)).toBe(true);
  });

  it('× 去掉：待确认的图删掉', async () => {
    const h = makeHarness();
    withImages(h);
    const { c, id } = await pasted(h);
    c.send({ type: 'capture/discard', captureId: id });
    await until(() => c.ofType('conv/captureCleared').length > 0, 'captureCleared');
    expect(h.session.data.has(`capture:${TAB}`)).toBe(false);
  });
});
