// 阅读器（ARCHITECTURE 4.3 规则 1-5、5.3）：只在顶层框架，由后台注入。
// 接小窗相关指令、网页提示（page/notice）、页面读取（page/read）、引用定位与高亮（page/locate、page/back，5.7）
// 与截图框选（capture/*，见 capture.ts）。
// 不发网络请求，不持有对话内容。
import { browser } from 'wxt/browser';
import { backgroundToContent, type ContentToBackground } from '@/core/domain/messages';
import { createCaptureOverlay } from './capture';
import { createFloatHost } from './float-host';
import { attachFloatPort } from './float-port';
import { createLocator } from './locate';
import { createPageNotice } from './notice';
import { createPageReader } from './page-read';

const INJECTED = Symbol.for('readingAssistant.readerInjected');

/** live（contract-v1.5，5.1/5.6）：正文有实质变化、或是换了路由（看 CLAUDE.md 哨兵以外没有 10 KB 门槛） */
const CHANGE_DEBOUNCE_MS = 1500;
/** 字数变化小于这个数不算「实质变化」——光标闪烁、小动画一般不改 DOM 文本量，不会碰到这条线 */
const CHANGE_MIN_DELTA = 40;

/**
 * 页面变化观察器：只在小窗/侧边栏开着期间挂（start/stop 由后台的 live/toggle 驱动，与引用实时上报同一个开关）。
 * 正文的 MutationObserver 节流后比较文本长度；SPA 换路由（pushState/replaceState/popstate/hashchange）
 * 不比字数，直接当作「已变化」（跳转后内容多半还在异步加载，字数比较这时不可靠）。
 * history.pushState/replaceState 的补丁只打一次、常驻；start/stop 只切 MutationObserver 与一个 active 开关，
 * 界面都关了之后 popstate 等监听器仍挂着但 active 为假、什么都不做，不是这里要断开的那个「观察器」
 */
function createChangeWatcher(send: (msg: ContentToBackground) => unknown) {
  let active = false;
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let baseline = 0;

  const notify = () => void send({ type: 'page/changed' });

  function checkMutation(): void {
    if (!active) return;
    const len = document.body?.textContent?.length ?? 0;
    if (Math.abs(len - baseline) >= CHANGE_MIN_DELTA) notify();
    baseline = len;
  }
  function scheduleCheck(): void {
    if (!active) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(checkMutation, CHANGE_DEBOUNCE_MS);
  }
  function onNavigate(): void {
    if (!active) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    baseline = document.body?.textContent?.length ?? 0;
    notify();
  }

  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = (...args: Parameters<History['pushState']>) => {
    origPush(...args);
    onNavigate();
  };
  history.replaceState = (...args: Parameters<History['replaceState']>) => {
    origReplace(...args);
    onNavigate();
  };
  window.addEventListener('popstate', onNavigate);
  window.addEventListener('hashchange', onNavigate);

  return {
    start(): void {
      if (active) return;
      active = true;
      baseline = document.body?.textContent?.length ?? 0;
      observer = new MutationObserver(scheduleCheck);
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    },
    stop(): void {
      active = false;
      observer?.disconnect();
      observer = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function startReader(): void {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (g[INJECTED]) return;
  g[INJECTED] = true;

  const notice = createPageNotice();
  const floatHost = createFloatHost(
    (result) => {
      const msg: { type: 'float/loadResult'; result: 'ready' | 'failedTransient' } = {
        type: 'float/loadResult',
        result,
      };
      void browser.runtime.sendMessage(msg);
    },
    // 用户等着的小窗用不了：在网页上提示改用侧边栏（选区后台已存下，侧边栏打开时带上引用）
    () => notice.show('floatFailed'),
  );
  attachFloatPort(floatHost);
  // 框选截图（5.13）：遮罩、视口修订号；截图期间小窗只藏起来，不收起
  const capture = createCaptureOverlay({
    send: (msg) => void browser.runtime.sendMessage(msg).catch(() => undefined),
    setFloatHidden: (on) => floatHost.setCaptureHidden(on),
  });

  // 点网页别处或在网页里按 Esc 收起小窗（6.1：隐藏，不销毁）。小窗内部的事件发生在 iframe 自己的文档里，
  // 不会传到网页文档；但小窗外壳（边框、拖动条、缩放把手）在网页文档里，按在上面不算「别处」，
  // 否则一按住拖动条小窗就收起了（用户在 Edge 实测发现）。焦点在小窗里时按 Esc 收不到，留给小窗私有端口（5.3）
  document.addEventListener(
    'pointerdown',
    (e) => {
      // 钉住的小窗（B3 图钉）点网页别处不收起；框选截图时在遮罩上拖动也不算
      if (e.isTrusted && !floatHost.owns(e) && !floatHost.keepsOpen() && !capture.active()) floatHost.hide();
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'keydown',
    (e) => e.isTrusted && e.key === 'Escape' && !capture.active() && floatHost.hide(),
    { capture: true },
  );

  const pageReader = createPageReader((msg) => browser.runtime.sendMessage(msg));
  // 引用跳回（5.7）与回到刚才的位置（F4）：滚过去时让开显示着的小窗（小窗不挪，原文挪到它旁边）
  const locator = createLocator(document, () => {
    const shown = document.querySelector('[data-ra-float-host="true"]')?.matches(':popover-open');
    return shown ? floatHost.getRect() : null;
  });
  const changeWatcher = createChangeWatcher((msg) => browser.runtime.sendMessage(msg));

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    // 只认来自后台的指令：sender.id 是本扩展，且没有 sender.tab（内容脚本发的消息都带 tab）
    if (sender.id !== browser.runtime.id || sender.tab !== undefined) return;
    const r = backgroundToContent.parse(raw);
    if (!r.ok) return;
    switch (r.value.type) {
      case 'float/prewarm':
        floatHost.prewarm(r.value.token);
        break;
      case 'float/show':
        floatHost.show({ token: r.value.token, focusInput: r.value.focusInput });
        break;
      case 'float/hide':
        floatHost.hide();
        break;
      case 'page/notice':
        // 本该改用侧边栏、浏览器却没让后台打开时（5.2）：提示用户自己打开
        floatHost.hide();
        notice.show(r.value.kind);
        break;
      case 'page/read':
        // 页面读取（5.6）：抽取在时间片里做，结果经 page/docPart / page/docUnchanged 回传
        void pageReader.read(r.value.readId, r.value.knownContentVersion).catch(() => undefined);
        break;
      case 'page/locate': {
        // 定位与高亮（5.7）：结果经 page/locateResult 回传；出错按找不到
        const { requestId, type: _type, ...req } = r.value;
        void locator
          .locate(req)
          .catch(() => ({ level: 'none' as const, back: false }))
          .then((res) =>
            browser.runtime.sendMessage({ type: 'page/locateResult', requestId, ...res } satisfies Extract<
              ContentToBackground,
              { type: 'page/locateResult' }
            >),
          )
          .catch(() => undefined);
        break;
      }
      case 'page/back':
        locator.back();
        break;
      case 'live/toggle':
        if (r.value.enabled) changeWatcher.start();
        else changeWatcher.stop();
        break;
      // 框选截图（5.13）：隐藏遮罩与小窗、等两帧后应答；结束时恢复。应答是当前视口修订号，后台据此核对
      case 'capture/start':
        capture.start(r.value.captureId);
        break;
      case 'capture/hideOverlay':
        void capture.hide(r.value.captureId).then(sendResponse);
        return true;
      case 'capture/end':
        sendResponse(capture.end(r.value.captureId));
        break;
      // 页面图片（E2，contract-v1.5 增量）：块号与内容版本原样带回，后台据此核对没有套到新内容上
      case 'page/images':
        sendResponse({
          requestId: r.value.requestId,
          contentVersion: r.value.contentVersion,
          urls: pageReader.imagesIn(r.value.blockIds, r.value.contentVersion),
        });
        break;
      default:
        break;
    }
  });
}
