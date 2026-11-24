// 输入框粘贴图片的界面侧（决策 099）：认图（图片 / 文字 / 多张）、切片、发送前的本地拦截、「不再提醒」的记忆。
import { describe, expect, it } from 'vitest';
import { createPasteAssembler, MAX_PASTE_BYTES, PASTE_CHUNK_BYTES } from '@/core/capture/paste';
import type { ClientToBackground } from '@/core/domain/messages';
import { type PasteData, pasteMessages, pickPastedImage, sendPastedImage } from '@/ui/chat/paste';
import {
  type HintStorage,
  loadPasteHintOff,
  PASTE_HINT_OFF_KEY,
  savePasteHintOff,
} from '@/ui/chat/paste-hint';
import { T } from '@/ui/strings';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngBytes = (n: number) => {
  const b = new Uint8Array(n);
  b.set(PNG_HEAD.slice(0, Math.min(n, 8)));
  return b;
};
const pngFile = (n = 100, name = 'a.png') => new File([pngBytes(n) as BlobPart], name, { type: 'image/png' });

function clip(opts: { text?: string; files?: File[]; viaItems?: boolean }): PasteData {
  const files = opts.files ?? [];
  return {
    getData: (f) => (f === 'text/plain' ? (opts.text ?? '') : ''),
    ...(opts.viaItems === false
      ? { files }
      : {
          items: [
            ...(opts.text ? [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] : []),
            ...files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
          ],
        }),
  };
}

describe('pickPastedImage', () => {
  it('只有图片：接管，取这张', () => {
    const f = pngFile();
    expect(pickPastedImage(clip({ files: [f] }))).toBe(f);
  });

  it('多张图片：只取第一张', () => {
    const a = pngFile(10, 'a.png');
    const b = pngFile(20, 'b.png');
    expect(pickPastedImage(clip({ files: [a, b] }))).toBe(a);
  });

  it('只有文字：不接管（文字粘贴照旧）', () => {
    expect(pickPastedImage(clip({ text: '一段文字' }))).toBeNull();
  });

  it('文字与图片同时在（从表格、文档里复制）：不接管，要的是文字', () => {
    expect(pickPastedImage(clip({ text: '单元格', files: [pngFile()] }))).toBeNull();
  });

  it('文字只是空白、图片在：接管', () => {
    const f = pngFile();
    expect(pickPastedImage(clip({ text: '  \n', files: [f] }))).toBe(f);
  });

  it('不是图片的文件（pdf 等）、空剪贴板、没有 clipboardData：不接管', () => {
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    expect(pickPastedImage(clip({ files: [pdf] }))).toBeNull();
    expect(pickPastedImage(clip({}))).toBeNull();
    expect(pickPastedImage(null)).toBeNull();
    expect(pickPastedImage(undefined)).toBeNull();
  });

  it('没有 items 只有 files 的环境：也能取到', () => {
    const f = pngFile();
    expect(pickPastedImage(clip({ files: [f], viaItems: false }))).toBe(f);
  });
});

describe('pasteMessages 切片', () => {
  it('begin 声明大小与片数；每片不超过 36 KB 原始字节；后台拼装器能原样收回', () => {
    const bytes = pngBytes(PASTE_CHUNK_BYTES * 2 + 77);
    const msgs = [...pasteMessages('up-00000002', 'image/png', bytes)];
    expect(msgs[0]).toEqual({
      type: 'paste/begin',
      uploadId: 'up-00000002',
      mime: 'image/png',
      size: bytes.length,
      chunks: 3,
    });
    expect(msgs).toHaveLength(4);
    const a = createPasteAssembler();
    let last: ReturnType<typeof a.chunk> | undefined;
    for (const m of msgs) {
      if (m.type === 'paste/begin') a.begin(m);
      else if (m.type === 'paste/chunk') last = a.chunk(m);
    }
    expect(last?.kind).toBe('done');
    if (last?.kind === 'done') expect(Array.from(last.bytes)).toEqual(Array.from(bytes));
  });

  it('不在白名单的类型直接抛', () => {
    expect(() => [...pasteMessages('up-00000003', 'image/svg+xml', new Uint8Array(3))]).toThrow();
  });
});

describe('sendPastedImage', () => {
  const make = (ready = true) => {
    const posted: ClientToBackground[] = [];
    const fails: string[] = [];
    const wakes: number[] = [];
    return {
      posted,
      fails,
      wakes,
      deps: {
        ready: () => ready,
        post: (m: ClientToBackground) => void posted.push(m),
        fail: (s: string) => void fails.push(s),
        wake: () => void wakes.push(1),
        newId: () => 'up-00000004',
      },
    };
  };

  it('正常：begin + 分片都发出去', async () => {
    const t = make();
    await sendPastedImage(pngFile(PASTE_CHUNK_BYTES + 5), t.deps);
    expect(t.fails).toEqual([]);
    expect(t.posted.map((m) => m.type)).toEqual(['paste/begin', 'paste/chunk', 'paste/chunk']);
  });

  it('连接没就绪：提示并叫醒重连，什么都不发', async () => {
    const t = make(false);
    await sendPastedImage(pngFile(), t.deps);
    expect(t.posted).toEqual([]);
    expect(t.fails).toEqual([T.error.notReady]);
    expect(t.wakes).toHaveLength(1);
  });

  it('超过上限：明确提示，不发任何消息', async () => {
    const t = make();
    const big = {
      size: MAX_PASTE_BYTES + 1,
      type: 'image/png',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as File;
    await sendPastedImage(big, t.deps);
    expect(t.posted).toEqual([]);
    expect(t.fails).toEqual([T.capture.failed.tooLarge]);
  });

  it('不支持的图片格式、空文件：提示不是可用图片', async () => {
    const t = make();
    await sendPastedImage(new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }), t.deps);
    await sendPastedImage(new File([], 'a.png', { type: 'image/png' }), t.deps);
    expect(t.posted).toEqual([]);
    expect(t.fails).toEqual([T.capture.failed.badImage, T.capture.failed.badImage]);
  });

  it('发送中端口断了：提示，不抛', async () => {
    const t = make();
    t.deps.post = () => {
      throw new Error('Attempting to use a disconnected port object');
    };
    await sendPastedImage(pngFile(), t.deps);
    expect(t.fails).toHaveLength(1);
  });

  it('提示文案里的上限与常量一致', () => {
    expect(T.capture.failed.tooLarge).toContain(`${MAX_PASTE_BYTES / 1024 / 1024} MB`);
  });
});

describe('「不再提醒」的记忆', () => {
  const fakeArea = (): HintStorage & { data: Record<string, unknown> } => {
    const data: Record<string, unknown> = {};
    return {
      data,
      get: async (k) => (k in data ? { [k]: data[k] } : {}),
      set: async (items) => void Object.assign(data, items),
    };
  };

  it('默认要提醒；点过「不再提醒」后记住，换一个页面（新读一次）也是关的', async () => {
    const area = fakeArea();
    expect(await loadPasteHintOff(area)).toBe(false);
    await savePasteHintOff(area);
    expect(area.data[PASTE_HINT_OFF_KEY]).toBe(true);
    expect(await loadPasteHintOff(area)).toBe(true);
  });

  it('读存储失败：按没点过处理，不抛', async () => {
    const broken: HintStorage = {
      get: async () => {
        throw new Error('boom');
      },
      set: async () => undefined,
    };
    expect(await loadPasteHintOff(broken)).toBe(false);
  });

  it('不是 true 的脏值不算关掉', async () => {
    const area = fakeArea();
    area.data[PASTE_HINT_OFF_KEY] = 'yes';
    expect(await loadPasteHintOff(area)).toBe(false);
  });
});
