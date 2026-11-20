// 小窗私有端口（5.3）：身份校验与消息分派的纯逻辑单测。真正建端口（runtime.onConnect/tabs.connect）
// 由 e2e 验证（fake-browser 不实现 onConnect，这部分留给真实浏览器）。
import { describe, expect, it, vi } from 'vitest';
import type { FloatHostApi, FloatRect } from '@/page/float-host';
import { handleFloatToReaderMessage, isFloatSender } from '@/page/float-port';

const RUNTIME_ID = 'pkahgpgifechjgdpecaebajnocgcnnnd';

describe('isFloatSender：只认本扩展 float.html 发起的连接', () => {
  it('扩展 ID 对、路径是 /float.html：通过', () => {
    expect(isFloatSender({ id: RUNTIME_ID, url: 'chrome-extension://dyn-id/float.html' }, RUNTIME_ID)).toBe(
      true,
    );
  });

  it('扩展 ID 不对：拒绝', () => {
    expect(isFloatSender({ id: 'other-ext', url: 'chrome-extension://dyn-id/float.html' }, RUNTIME_ID)).toBe(
      false,
    );
  });

  it('路径不是 /float.html：拒绝', () => {
    expect(
      isFloatSender({ id: RUNTIME_ID, url: 'chrome-extension://dyn-id/sidepanel.html' }, RUNTIME_ID),
    ).toBe(false);
  });

  it('没有 sender 或没有 url：拒绝', () => {
    expect(isFloatSender(undefined, RUNTIME_ID)).toBe(false);
    expect(isFloatSender({ id: RUNTIME_ID }, RUNTIME_ID)).toBe(false);
  });

  it('url 不是合法地址：拒绝而不是抛错', () => {
    expect(isFloatSender({ id: RUNTIME_ID, url: 'not a url' }, RUNTIME_ID)).toBe(false);
  });
});

function fakeHost(rect: FloatRect | null = { left: 0, top: 0, width: 380, height: 480 }): FloatHostApi {
  return {
    prewarm: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    resize: vi.fn(() => rect),
    reposition: vi.fn(() => rect),
    getRect: vi.fn(() => rect),
    markPortReady: vi.fn(),
    onRectSettled: vi.fn(),
  };
}

describe('handleFloatToReaderMessage：按消息类型分派到 FloatHostApi', () => {
  it('float/resize：调用 host.resize', () => {
    const host = fakeHost();
    handleFloatToReaderMessage({ type: 'float/resize', w: 400, h: 300 }, host);
    expect(host.resize).toHaveBeenCalledWith(400, 300);
  });

  it('float/reposition：调用 host.reposition', () => {
    const host = fakeHost();
    handleFloatToReaderMessage({ type: 'float/reposition', x: 10, y: 20 }, host);
    expect(host.reposition).toHaveBeenCalledWith(10, 20);
  });

  it('float/collapse：调用 host.hide', () => {
    const host = fakeHost();
    handleFloatToReaderMessage({ type: 'float/collapse' }, host);
    expect(host.hide).toHaveBeenCalled();
  });

  it('anchor/jump、anchor/back：本版本不实现，合法消息但不调用任何 host 方法', () => {
    const host = fakeHost();
    const anchor = {
      exact: 'x',
      prefix: '',
      suffix: '',
      blockDigest: '',
      headingPath: [],
      scrollRatio: 0,
      offsetInBlock: 0,
    };
    handleFloatToReaderMessage({ type: 'anchor/jump', anchor }, host);
    handleFloatToReaderMessage({ type: 'anchor/back' }, host);
    expect(host.resize).not.toHaveBeenCalled();
    expect(host.reposition).not.toHaveBeenCalled();
    expect(host.hide).not.toHaveBeenCalled();
  });

  it('不合法消息（未知类型、超出最小尺寸）：原样丢弃', () => {
    const host = fakeHost();
    handleFloatToReaderMessage({ type: 'float/unknown' }, host);
    handleFloatToReaderMessage({ type: 'float/resize', w: 50, h: 50 }, host); // 小于最小 200×160
    expect(host.resize).not.toHaveBeenCalled();
  });
});
