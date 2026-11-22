// @vitest-environment happy-dom
// 哨兵的实时选区上报（live，contract-v1.5，D11/B5）：开关（live/toggle）与防抖。
// 选区判定、矩形、工具栏渲染不是这里要测的东西（且 happy-dom 不做真实布局，rect 恒为 0），
// 直接换成可控的假实现；只关心「什么时候发、什么时候不发 selection/live」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Decision {
  show: boolean;
  text: string;
  inCode: boolean;
}

let decision: Decision = { show: true, text: '段落一', inCode: false };

vi.mock('@/page/selection-policy', () => ({
  evaluateSelection: () => decision,
  lastLineRect: () => new DOMRect(0, 0, 10, 10),
  readonlyInputRect: () => new DOMRect(0, 0, 10, 10),
}));

vi.mock('@/page/toolbar', () => ({
  createToolbar: () => ({
    el: document.createElement('div'),
    show: () => undefined,
    hide: () => undefined,
    tip: () => undefined,
    confirm: () => undefined,
  }),
  needsLongConfirm: () => false,
}));

const { browser } = await import('wxt/browser');
const { startSentinel } = await import('@/page/sentinel');

type Raw = { type?: string; [k: string]: unknown };
type BgListener = (raw: unknown, sender: { id?: string; tab?: unknown }) => void;

/** happy-dom 派发的事件默认不受信任（isTrusted 为假）；哨兵只认受信任的事件，测试里手动盖章 */
function trustedMouseUp(): void {
  const e = new MouseEvent('mouseup', { bubbles: true });
  Object.defineProperty(e, 'isTrusted', { value: true });
  window.dispatchEvent(e);
}

describe('哨兵：live 实时上报选区（contract-v1.5）', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let bgListener: BgListener | undefined;

  beforeEach(() => {
    decision = { show: true, text: '段落一', inCode: false };
    document.body.innerHTML = '<p id="t">段落一</p>';
    bgListener = undefined;
    sendSpy = vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(() => Promise.resolve(undefined));
    vi.spyOn(browser.runtime.onMessage, 'addListener').mockImplementation(((cb: BgListener) => {
      bgListener = cb;
    }) as typeof browser.runtime.onMessage.addListener);
    startSentinel();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const toggleLive = (enabled: boolean) =>
    bgListener?.({ type: 'live/toggle', enabled }, { id: browser.runtime.id });
  const liveMsgs = (): Raw[] => {
    const all: Raw[] = sendSpy.mock.calls.map((call: unknown[]) => call[0] as Raw);
    return all.filter((m) => m.type === 'selection/live');
  };

  it('没打开 live：选中文字不上报 selection/live（隐私：没人看着就不发）', () => {
    trustedMouseUp();
    expect(liveMsgs()).toHaveLength(0);
  });

  it('后台开启 live 后，新选中的文字立即上报（D11、B5）', () => {
    toggleLive(true);
    decision = { show: true, text: '段落二', inCode: false };
    trustedMouseUp();
    expect(liveMsgs()).toHaveLength(1);
    expect(liveMsgs()[0]).toMatchObject({ text: '段落二', truncated: false, inCode: false });
  });

  it('同一段文字连续触发（偶发的重复 mouseup）不重发：防抖', () => {
    toggleLive(true);
    trustedMouseUp();
    trustedMouseUp();
    expect(liveMsgs()).toHaveLength(1);
  });

  it('换选了新的一段：照常重发', () => {
    toggleLive(true);
    trustedMouseUp();
    decision = { show: true, text: '段落三', inCode: false };
    trustedMouseUp();
    expect(liveMsgs()).toHaveLength(2);
  });

  it('后台撤回 live（订阅者没了）后不再上报', () => {
    toggleLive(true);
    toggleLive(false);
    trustedMouseUp();
    expect(liveMsgs()).toHaveLength(0);
  });

  it('不是来自后台的消息（带 sender.tab，内容脚本的消息都带）不改开关状态', () => {
    bgListener?.({ type: 'live/toggle', enabled: true }, { id: browser.runtime.id, tab: { id: 1 } });
    trustedMouseUp();
    expect(liveMsgs()).toHaveLength(0);
  });
});
