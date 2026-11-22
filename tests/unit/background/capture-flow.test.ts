// 框选截图的后台流程（5.13、E1–E4）：身份核对（文档变了、视口变了、不再是活动页 → 丢弃）、待确认截图的保管、
// 发问时原图进请求与图片表（refCount）、视觉能力为「不支持」时拒绝、删除对话时图片引用跟着减、历史缩略图的授权。
import { describe, expect, it } from 'vitest';
import type { CaptureStart } from '@/background/capture';
import { verifyRect } from '@/background/capture';
import type { CaptureImages } from '@/background/capture-image';
import type { MessageRecord } from '@/core/domain/records';
import { askMsg, type Harness, makeHarness, readyFloat, SETTINGS, TAB, TOP_DOC, until, WIN } from './harness';

type Conn = ReturnType<Harness['connect']>;

const VP = { w: 800, h: 600 };
const FULL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

interface Fakes {
  /** 阅读器应答的修订号（按消息类型）；默认 1 */
  revision: { hide: number; end: number };
  frames: string[];
  shots: number;
  tab: { active: boolean; windowId: number } | undefined;
  process: CaptureImages['process'];
}

function withCapture(h: Harness): Fakes {
  const f: Fakes = {
    revision: { hide: 1, end: 1 },
    frames: [],
    shots: 0,
    tab: { active: true, windowId: WIN },
    process: async () => ({ dataUrl: FULL, mime: 'image/png', width: 200, height: 100, thumb: THUMB }),
  };
  h.deps.requestFrame = async (_tabId, _frameId, documentId, msg) => {
    if (documentId !== TOP_DOC) throw new Error('No document');
    f.frames.push(msg.type);
    const captureId = (msg as { captureId: string }).captureId;
    const viewportRevision = msg.type === 'capture/hideOverlay' ? f.revision.hide : f.revision.end;
    return { captureId, viewportRevision, viewport: VP };
  };
  h.deps.tabState = async () => f.tab;
  h.deps.captureVisibleTab = async () => {
    f.shots++;
    return 'data:image/png;base64,AAAA';
  };
  h.deps.captureImages = {
    process: (...a) => f.process(...a),
    thumbnail: async () => THUMB,
  };
  return f;
}

/** 小窗点「截图」→ 后台让阅读器显示遮罩，返回这次的 captureId */
async function begin(h: Harness, c: Conn): Promise<string> {
  const n = h.sent.filter((s) => s.msg.type === 'capture/start').length;
  c.send({ type: 'capture/begin' });
  await until(() => h.sent.filter((s) => s.msg.type === 'capture/start').length === n + 1, 'capture/start');
  const start = h.sent.filter((s) => s.msg.type === 'capture/start').at(-1)?.msg as unknown as {
    captureId: string;
  };
  return start.captureId;
}

const rectMsg = (captureId: string, extra: Record<string, unknown> = {}) => ({
  type: 'capture/rect',
  captureId,
  viewportRevision: 1,
  rect: { x: 10, y: 20, w: 200, h: 100 },
  viewport: VP,
  ...extra,
});

const notices = (h: Harness) =>
  h.sent.filter((s) => s.msg.type === 'page/notice').map((s) => (s.msg as unknown as { kind: string }).kind);

async function captured(h: Harness, c: Conn): Promise<string> {
  const id = await begin(h, c);
  await h.message(rectMsg(id));
  await until(() => c.ofType('conv/capture').length > 0, 'conv/capture');
  return id;
}

describe('verifyRect（纯函数）', () => {
  const start: CaptureStart = {
    captureId: 'cap-00000001',
    tabId: TAB,
    windowId: WIN,
    documentId: TOP_DOC,
    origin: 'command',
    toPanel: false,
    at: 1000,
  };
  const who = { tabId: TAB, frameId: 0, documentId: TOP_DOC };
  const active = { active: true, windowId: WIN };

  it('一切对得上', () => {
    expect(verifyRect(start, { captureId: start.captureId }, who, active, 2000)).toBe('ok');
  });
  it('不是这次、不是这个文档、不是顶层框架、没开始过、过期：notOwner', () => {
    expect(verifyRect(start, { captureId: 'cap-00000002' }, who, active, 2000)).toBe('notOwner');
    expect(verifyRect(start, start, { ...who, documentId: 'doc-other' }, active, 2000)).toBe('notOwner');
    expect(verifyRect(start, start, { ...who, frameId: 2 }, active, 2000)).toBe('notOwner');
    expect(verifyRect(start, start, { ...who, tabId: TAB + 1 }, active, 2000)).toBe('notOwner');
    expect(verifyRect(undefined, start, who, active, 2000)).toBe('notOwner');
    expect(verifyRect(start, start, who, active, 1000 + 5 * 60_000 + 1)).toBe('notOwner');
  });
  it('标签页不再是活动页、挪到了别的窗口、不在了：changed', () => {
    expect(verifyRect(start, start, who, { active: false, windowId: WIN }, 2000)).toBe('changed');
    expect(verifyRect(start, start, who, { active: true, windowId: WIN + 1 }, 2000)).toBe('changed');
    expect(verifyRect(start, start, who, undefined, 2000)).toBe('changed');
  });
});

describe('框选 → 截图 → 预览', () => {
  it('成功：隐藏遮罩、截图、恢复，预览推给小窗，待确认截图只在 storage.session', async () => {
    const h = makeHarness();
    const f = withCapture(h);
    const c = await readyFloat(h);
    const id = await captured(h, c);
    expect(f.frames).toEqual(['capture/hideOverlay', 'capture/end']);
    expect(f.shots).toBe(1);
    expect(c.ofType('conv/capture')[0]).toMatchObject({
      captureId: id,
      thumb: THUMB,
      width: 200,
      height: 100,
    });
    // 推给界面的只有缩略图，原图不出后台
    expect(JSON.stringify(c.received)).not.toContain(FULL);
    expect(h.session.data.get(`capture:${TAB}`)).toMatchObject({ captureId: id, dataUrl: FULL });
    expect(h.db.tables.blobs.size).toBe(0);
  });

  it('别的文档发来的 capture/rect（页面已导航）：拒绝，不截图', async () => {
    const h = makeHarness();
    const f = withCapture(h);
    const c = await readyFloat(h);
    const id = await begin(h, c);
    await h.message(rectMsg(id), h.contentSender(0, 'doc-top-2'));
    expect(f.shots).toBe(0);
    expect(c.ofType('conv/capture')).toHaveLength(0);
  });

  it('隐藏遮罩后修订号变了（框选后滚动、缩放）：丢弃，界面与网页都提示重选', async () => {
    const h = makeHarness();
    const f = withCapture(h);
    f.revision.hide = 2;
    const c = await readyFloat(h);
    const id = await begin(h, c);
    await h.message(rectMsg(id));
    await until(() => c.ofType('conv/captureFailed').length > 0, 'captureFailed');
    expect(c.ofType('conv/captureFailed')[0]).toMatchObject({ reason: 'changed' });
    expect(f.shots).toBe(0);
    expect(f.frames).toContain('capture/end');
    await until(() => notices(h).includes('captureChanged'), '网页提示');
    expect(h.session.data.has(`capture:${TAB}`)).toBe(false);
  });

  it('截图期间视口变了（capture/end 报的修订号不同）：丢弃', async () => {
    const h = makeHarness();
    const f = withCapture(h);
    f.revision.end = 3;
    const c = await readyFloat(h);
    const id = await begin(h, c);
    await h.message(rectMsg(id));
    await until(() => c.ofType('conv/captureFailed').length > 0, 'captureFailed');
    expect(f.shots).toBe(1);
    expect(c.ofType('conv/capture')).toHaveLength(0);
  });

  it('标签页不再是活动页（切了标签页）：丢弃', async () => {
    const h = makeHarness();
    const f = withCapture(h);
    const c = await readyFloat(h);
    const id = await begin(h, c);
    f.tab = { active: false, windowId: WIN };
    await h.message(rectMsg(id));
    await until(() => c.ofType('conv/captureFailed').length > 0, 'captureFailed');
    expect(f.shots).toBe(0);
  });

  it('图片比例与视口不符（裁剪报 mismatch）：丢弃', async () => {
    const h = makeHarness();
    const f = withCapture(h);
    f.process = async () => 'mismatch';
    const c = await readyFloat(h);
    const id = await begin(h, c);
    await h.message(rectMsg(id));
    await until(() => c.ofType('conv/captureFailed').length > 0, 'captureFailed');
    expect(h.session.data.has(`capture:${TAB}`)).toBe(false);
  });

  it('取消：之后同一编号的 capture/rect 不再截图', async () => {
    const h = makeHarness();
    const f = withCapture(h);
    const c = await readyFloat(h);
    const id = await begin(h, c);
    await h.message({ type: 'capture/cancel', captureId: id });
    await h.message(rectMsg(id));
    expect(f.shots).toBe(0);
  });

  it('× 去掉：待确认截图删掉，界面收到 captureCleared', async () => {
    const h = makeHarness();
    withCapture(h);
    const c = await readyFloat(h);
    const id = await captured(h, c);
    c.send({ type: 'capture/discard', captureId: id });
    await until(() => c.ofType('conv/captureCleared').length > 0, 'captureCleared');
    expect(h.session.data.has(`capture:${TAB}`)).toBe(false);
  });

  it('重新订阅（小窗重连）时补发预览', async () => {
    const h = makeHarness();
    withCapture(h);
    const c = await readyFloat(h);
    const id = await captured(h, c);
    c.send({ type: 'conv/subscribe' });
    await until(() => c.ofType('conv/capture').length === 2, '补发');
    expect(c.ofType('conv/capture')[1]).toMatchObject({ captureId: id });
  });
});

describe('发问带图', () => {
  it('原图进请求（本轮用户消息的图片部分）、计划 imageCount 为 1；图片表 refCount 1；用户消息引用它；预览收起', async () => {
    const h = makeHarness();
    withCapture(h);
    const c = await readyFloat(h);
    const id = await captured(h, c);
    c.send(askMsg({ captureId: id, text: '', selectionRevision: undefined }));
    await until(() => h.fetches.length === 1, '请求');
    const body = JSON.parse(String(h.fetches[0]?.init.body)) as {
      messages: { role: string; content: { kind: string; dataUrl?: string; text?: string }[] }[];
    };
    const last = body.messages.at(-1);
    expect(last?.content[0]).toEqual({ kind: 'image', dataUrl: FULL });
    await until(() => c.ofType('conv/accepted').length === 1, '接单');
    const plan = h.logs.find((l) => l.event === 'ask/plan')?.detail;
    expect(plan?.imageCount).toBe(1);
    const user = [...h.db.tables.messages.values()].find((m) => m.role === 'user') as MessageRecord;
    expect(user.images).toHaveLength(1);
    const blob = h.db.tables.blobs.get(user.images?.[0]?.blobId ?? '');
    expect(blob).toMatchObject({ mime: 'image/png', refCount: 1 });
    await until(() => c.ofType('conv/captureCleared').length > 0, 'captureCleared');
    expect(h.session.data.has(`capture:${TAB}`)).toBe(false);

    // 删除对话：图片引用跟着减到 0，图片删掉
    await h.db.deleteConversation(user.conversationId);
    expect(h.db.tables.blobs.size).toBe(0);
  });

  it('编号对不上（截图已被去掉或过期）：拒绝 gone，不发请求', async () => {
    const h = makeHarness();
    withCapture(h);
    const c = await readyFloat(h);
    await captured(h, c);
    c.send(askMsg({ captureId: 'cap-99999999', text: '图里是什么', selectionRevision: undefined }));
    await until(() => c.ofType('conv/rejected').length > 0, '拒绝');
    expect(c.ofType('conv/rejected')[0]).toMatchObject({ reason: 'gone' });
    expect(h.fetches).toHaveLength(0);
  });

  it('模型视觉能力为「不支持」：拒绝 noVision，截图留着、不发请求', async () => {
    const h = makeHarness();
    withCapture(h);
    const conn = {
      ...SETTINGS.connections[0],
      capabilityOverrides: { 'mock-flash': { vision: 'no' as const } },
    };
    h.setSettings({ ...SETTINGS, connections: [conn as (typeof SETTINGS.connections)[number]] });
    const c = await readyFloat(h);
    const id = await captured(h, c);
    c.send(askMsg({ captureId: id, text: '图里是什么', selectionRevision: undefined }));
    await until(() => c.ofType('conv/rejected').length > 0, '拒绝');
    expect(c.ofType('conv/rejected')[0]).toMatchObject({ reason: 'noVision' });
    expect(h.fetches).toHaveLength(0);
    expect(h.session.data.has(`capture:${TAB}`)).toBe(true);
    expect(h.db.tables.blobs.size).toBe(0);
  });

  it('历史缩略图：image/get 按授权给缩略图；不存在的消息回 gone', async () => {
    const h = makeHarness();
    withCapture(h);
    const c = await readyFloat(h);
    const id = await captured(h, c);
    c.send(askMsg({ captureId: id, text: '', selectionRevision: undefined }));
    await until(() => h.fetches.length === 1, '请求');
    await until(() => c.ofType('conv/accepted').length === 1, '接单');
    const user = [...h.db.tables.messages.values()].find((m) => m.role === 'user') as MessageRecord;
    await until(() => h.db.tables.blobs.size === 1, '写库');
    c.send({ type: 'image/get', requestId: 'img-00000001', messageId: user.id, index: 0 });
    await until(() => c.ofType('image/thumb').length > 0, '缩略图');
    expect(c.ofType('image/thumb')[0]).toMatchObject({ messageId: user.id, index: 0, thumb: THUMB });
    c.send({ type: 'image/get', requestId: 'img-00000002', messageId: 'msg-00000404', index: 0 });
    await until(() => c.ofType('conv/rejected').some((m) => m.reason === 'gone'), 'gone');
  });
});
