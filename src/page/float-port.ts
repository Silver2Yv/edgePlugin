// 小窗私有端口（ARCHITECTURE 5.3）：小窗 ↔ 所在标签页的阅读器，用 tabs.connect 直连，不经过
// 后台中转，不用 window.postMessage。只接恢复位置/尺寸、收起；引用跳转（anchor/*）本版本不实现
// （待页面读取 / 定位落地），收到也不报错，按已知消息类型忽略。
// 实时拖动 / 缩放不经过这个端口——由宿主侧不可见把手直接处理（见 float-host.ts 文件头注释），
// 这里只在手势结束时把最终 rect 回报给小窗用于落盘。
import { browser } from 'wxt/browser';
import { FLOAT_PORT, floatToReader, type ReaderToFloat } from '@/core/domain/messages';
import type { FloatHostApi, FloatRect } from './float-host';

interface PortLike {
  readonly name: string;
  readonly sender?: { id?: string; url?: string };
  postMessage(msg: ReaderToFloat): void;
  disconnect(): void;
  readonly onMessage: { addListener(cb: (msg: unknown) => void): void };
  readonly onDisconnect: { addListener(cb: () => void): void };
}

/**
 * 只认本扩展 float.html 发起的连接。小窗声明了 use_dynamic_url，sender.url 的主机可能是动态 ID
 * 而不是扩展 ID，是不是本扩展已由 sender.id 核对（与 background/roles.ts 的判定同例）。
 * runtimeId 由调用方传入（取自 browser.runtime.id）而不是在这里读取，方便纯函数单测。
 */
export function isFloatSender(sender: { id?: string; url?: string } | undefined, runtimeId: string): boolean {
  if (sender?.id !== runtimeId || !sender.url) return false;
  try {
    return new URL(sender.url).pathname === '/float.html';
  } catch {
    return false;
  }
}

function sendRect(port: PortLike, r: FloatRect | null, settled: boolean): void {
  if (r) port.postMessage({ type: 'float/rect', x: r.left, y: r.top, w: r.width, h: r.height, settled });
}

/**
 * 解析并执行一条收到的消息（恢复尺寸 / 恢复位置 / 收起）；不合法的消息原样丢弃。
 * 单独导出：不需要真的建端口就能单测分派逻辑，只用一个假的 FloatHostApi。
 */
export function handleFloatToReaderMessage(raw: unknown, host: FloatHostApi): void {
  const r = floatToReader.parse(raw);
  if (!r.ok) return;
  switch (r.value.type) {
    case 'float/resize':
      host.resize(r.value.w, r.value.h);
      break;
    case 'float/reposition':
      host.reposition(r.value.x, r.value.y);
      break;
    case 'float/collapse':
      host.hide();
      break;
    default:
      // anchor/jump、anchor/back：本版本不实现
      break;
  }
}

/**
 * 挂接到 runtime.onConnect。同一时刻只服务最近一次连接——旧连接多半是已经销毁的旧小窗文档
 * （宿主导航后 float-host 会重建），直接断开，不保留僵尸端口。
 */
export function attachFloatPort(host: FloatHostApi): void {
  let current: PortLike | null = null;
  const runtimeId = browser.runtime.id;

  // 宿主侧把手完成一次拖动/缩放手势：把最终 rect 回报给当前连接的小窗（没有连接就丢弃，小窗
  // 重连后会按 float/rect 的初始推送拿到最新 rect，不会丢数据——只是这次手势不会立刻落盘）
  host.onRectSettled((rect) => {
    if (current) sendRect(current, rect, true);
  });

  browser.runtime.onConnect.addListener((port) => {
    const p = port as unknown as PortLike;
    if (p.name !== FLOAT_PORT) return;
    if (!isFloatSender(p.sender, runtimeId)) {
      p.disconnect();
      return;
    }
    current?.disconnect();
    current = p;
    host.markPortReady();
    sendRect(p, host.getRect(), false);
    p.onMessage.addListener((raw) => {
      handleFloatToReaderMessage(raw, host);
      sendRect(p, host.getRect(), false);
    });
    p.onDisconnect.addListener(() => {
      if (current === p) current = null;
    });
  });
}
