// @vitest-environment happy-dom
// 小窗不可见满 10 分钟销毁 iframe（决策 078/101，5.3）：计时开始、取消、到点销毁并通知。
// 用假计时器推进时间；happy-dom 不做真实布局与加载，iframe 的 load 不会触发，这里只看宿主 div 与通知。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOAT_LIMITS } from '@/core/domain/float';
import { createFloatHost, type FloatHostApi } from '@/page/float-host';

const IDLE = FLOAT_LIMITS.idleDestroyMs;
const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

const hostEl = () => document.querySelector<HTMLElement>('[data-ra-float-host]');
// 宿主的 shadow root 是封闭的：靠 DOM 里有没有宿主 div 判断建没建；可见与否看 popover 是否打开
const visible = () => hostEl()?.matches(':popover-open') ?? false;

let host: FloatHostApi;
let destroyed: ReturnType<typeof vi.fn<(missed: boolean) => void>>;
let loadResults: string[];

// happy-dom 没有 Popover API：用最小实现顶上（showPopover / hidePopover，matches(':popover-open')）
const open = new WeakSet<Element>();
const nativeMatches = Element.prototype.matches;
HTMLElement.prototype.showPopover = function (this: HTMLElement) {
  open.add(this);
};
HTMLElement.prototype.hidePopover = function (this: HTMLElement) {
  open.delete(this);
};
Element.prototype.matches = function (this: Element, selector: string) {
  return selector === ':popover-open' ? open.has(this) : nativeMatches.call(this, selector);
};
// 宿主的 shadow root 在生产里是封闭的；测试里改成开放，才摸得到 iframe 去触发 load
const nativeAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
  return nativeAttachShadow.call(this, { ...init, mode: 'open' });
};

// 扩展地址在 happy-dom 里加载不了，它每次都往控制台刷错误；这里不关心 iframe 里的页面，让它接入文档时什么都不做
const proto = HTMLIFrameElement.prototype as unknown as Record<symbol, () => void>;
const connected = Object.getOwnPropertySymbols(proto).find((s) => s.description === 'connectedToDocument');
if (connected) proto[connected] = () => undefined;

/** 模拟小窗页面加载完成（否则 5 秒后按加载超时处理，会把显示着的小窗收起） */
const loadIframe = () => hostEl()?.shadowRoot?.querySelector('iframe')?.dispatchEvent(new Event('load'));

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.innerHTML = '<head></head><body></body>';
  destroyed = vi.fn<(missed: boolean) => void>();
  loadResults = [];
  host = createFloatHost(
    (r) => loadResults.push(r),
    () => undefined,
    destroyed,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('空闲销毁计时', () => {
  it('预热后从未显示：满 10 分钟销毁并通知一次；之前不动', () => {
    host.prewarm(TOKEN_A);
    expect(hostEl()).not.toBeNull();
    vi.advanceTimersByTime(IDLE - 1);
    expect(hostEl()).not.toBeNull();
    expect(destroyed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hostEl()).toBeNull();
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(destroyed).toHaveBeenLastCalledWith(false);
    // 之后不会再通知
    vi.advanceTimersByTime(IDLE * 3);
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it('显示期间不计时；收起后才开始，满 10 分钟销毁', () => {
    host.prewarm(TOKEN_A);
    loadIframe();
    host.show({ token: undefined, focusInput: false });
    expect(visible()).toBe(true);
    vi.advanceTimersByTime(IDLE * 2);
    expect(hostEl()).not.toBeNull();
    expect(destroyed).not.toHaveBeenCalled();

    host.hide();
    expect(visible()).toBe(false);
    vi.advanceTimersByTime(IDLE - 1);
    expect(hostEl()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(hostEl()).toBeNull();
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it('期间再次显示：取消计时，旧的到点时间过了也不销毁；再收起重新计满 10 分钟', () => {
    host.prewarm(TOKEN_A);
    loadIframe();
    host.show({ token: undefined, focusInput: false });
    host.hide();
    vi.advanceTimersByTime(IDLE - 1000);
    host.show({ token: undefined, focusInput: false });
    vi.advanceTimersByTime(IDLE * 2);
    expect(hostEl()).not.toBeNull();
    expect(destroyed).not.toHaveBeenCalled();

    host.hide();
    vi.advanceTimersByTime(IDLE - 1);
    expect(hostEl()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(hostEl()).toBeNull();
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it('网页上每次点击都会调 hide()：不能把已在走的计时重置', () => {
    host.prewarm(TOKEN_A);
    host.show({ token: undefined, focusInput: false });
    host.hide();
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(IDLE / 10);
      host.hide();
    }
    vi.advanceTimersByTime(IDLE / 10);
    expect(hostEl()).toBeNull();
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it('没有小窗时 hide() 不起计时，也不通知', () => {
    host.hide();
    vi.advanceTimersByTime(IDLE * 2);
    expect(destroyed).not.toHaveBeenCalled();
  });

  it('钉住的、一直显示着的小窗不销毁', () => {
    host.prewarm(TOKEN_A);
    loadIframe();
    host.show({ token: undefined, focusInput: false });
    host.setKeepOpen(true);
    vi.advanceTimersByTime(IDLE * 3);
    expect(visible()).toBe(true);
    expect(destroyed).not.toHaveBeenCalled();
  });
});

describe('销毁之后', () => {
  it('再次显示带新令牌：新建 iframe 并显示；没有令牌就造不出小窗', () => {
    host.prewarm(TOKEN_A);
    host.show({ token: undefined, focusInput: false });
    host.hide();
    vi.advanceTimersByTime(IDLE);
    expect(hostEl()).toBeNull();

    host.show({ token: undefined, focusInput: false });
    expect(hostEl()).toBeNull();

    host.show({ token: TOKEN_B, focusInput: false });
    expect(hostEl()).not.toBeNull();
    expect(visible()).toBe(true);
  });

  it('销毁后收到没带令牌的显示（后台撞上了销毁）：以 missed 再通知后台；重建之后不再这样', () => {
    host.prewarm(TOKEN_A);
    vi.advanceTimersByTime(IDLE);
    expect(destroyed).toHaveBeenCalledTimes(1);

    host.show({ token: undefined, focusInput: true });
    expect(hostEl()).toBeNull();
    expect(destroyed).toHaveBeenCalledTimes(2);
    expect(destroyed).toHaveBeenLastCalledWith(true);

    host.show({ token: TOKEN_B, focusInput: false });
    expect(hostEl()).not.toBeNull();
    host.hide();
    host.show({ token: undefined, focusInput: false }); // 已有小窗，正常显示
    expect(destroyed).toHaveBeenCalledTimes(2);
  });

  it('从没销毁过、也没有小窗时收到无令牌的显示：不通知（没有销毁可报）', () => {
    host.show({ token: undefined, focusInput: false });
    expect(destroyed).not.toHaveBeenCalled();
  });

  it('新建后的小窗照常计时：收起满 10 分钟再次销毁并再通知', () => {
    host.prewarm(TOKEN_A);
    vi.advanceTimersByTime(IDLE);
    expect(destroyed).toHaveBeenCalledTimes(1);

    host.prewarm(TOKEN_B);
    expect(hostEl()).not.toBeNull();
    vi.advanceTimersByTime(IDLE);
    expect(hostEl()).toBeNull();
    expect(destroyed).toHaveBeenCalledTimes(2);
  });

  it('用户调过的尺寸沿用到新建的小窗；钉住状态不带过去（换了小窗文档重新报）', () => {
    host.prewarm(TOKEN_A);
    host.show({ token: undefined, focusInput: false });
    host.resize(500, 400);
    host.setKeepOpen(true);
    host.hide();
    vi.advanceTimersByTime(IDLE);
    expect(hostEl()).toBeNull();
    expect(host.keepsOpen()).toBe(false);

    host.show({ token: TOKEN_B, focusInput: false });
    expect(host.getRect()).toMatchObject({ width: 500, height: 400 });
  });

  it('加载超时失败的小窗收起后同样计时销毁', () => {
    host.prewarm(TOKEN_A);
    host.show({ token: undefined, focusInput: false });
    vi.advanceTimersByTime(FLOAT_LIMITS.loadTimeoutMs);
    expect(loadResults).toEqual(['failedTransient']);
    expect(visible()).toBe(false);
    vi.advanceTimersByTime(IDLE);
    expect(hostEl()).toBeNull();
    expect(destroyed).toHaveBeenCalledTimes(1);
  });
});
