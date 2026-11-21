// 工具栏 / 小窗探测：复用 tests/e2e/page-helpers.ts 的调试协议穿透手法（工具栏在封闭 shadow root 里，
// 定位器进不去），这里按 V-13 的需要精简一份独立拷贝，避免这个原型脚本依赖 tests/e2e 的内部实现细节。

/** 顶层框架（含跨源子框架，pierce:true 会穿透）里可见的「问」按钮中心；没有或不可见返回 undefined */
export async function askButtonCenter(cdp) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const node = findByLabel(root, '问');
  if (!node) return undefined;
  try {
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    if (model.width === 0 || model.height === 0) return undefined;
    const q = model.content;
    return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
  } catch {
    return undefined;
  }
}

function findByLabel(node, label) {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === 'aria-label' && attrs[i + 1] === label) return node;
  }
  for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
    const hit = findByLabel(child, label);
    if (hit) return hit;
  }
  return node.contentDocument ? findByLabel(node.contentDocument, label) : undefined;
}

/**
 * 轮询等「问」按钮出现，返回出现耗时（ms）；超时抛错。
 * startMs 可传入调用方真正发起动作（如选区、点击）之前的时间戳，让耗时包含轮询开始前已经过去的时间，
 * 不然「点击已经处理完才开始轮询」会让第一次就命中、耗时被低估。
 */
export async function waitToolbar(cdp, timeoutMs = 5000, startMs) {
  const start = startMs ?? Date.now();
  for (;;) {
    const center = await askButtonCenter(cdp);
    if (center) return { ms: Date.now() - start, center };
    if (Date.now() - start > timeoutMs) throw new Error('等工具栏出现超时');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** 子框架里有没有打开的工具栏（popover-open 的宿主元素挂在 documentElement 下） */
export const frameToolbarOpen = (frame) =>
  frame.evaluate(() => [...document.documentElement.children].some((el) => el.matches(':popover-open')));

const isFloat = (f) => {
  try {
    return new URL(f.url()).pathname === '/float.html';
  } catch {
    return false;
  }
};

/** 轮询等小窗 iframe（float.html）出现，返回耗时（ms）与 Frame */
export async function waitFloatFrame(page, timeoutMs = 5000, startMs) {
  const start = startMs ?? Date.now();
  for (;;) {
    const f = page.frames().find(isFloat);
    if (f) return { ms: Date.now() - start, frame: f };
    if (Date.now() - start > timeoutMs) throw new Error('等小窗 iframe 出现超时');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** 轮询等小窗输入框可见（真正「可交互」，不只是 iframe 挂上了），返回耗时（ms） */
export async function waitFloatInputVisible(frame, timeoutMs = 5000, startMs) {
  const start = startMs ?? Date.now();
  const input = frame.getByLabel('输入问题');
  await input.waitFor({ state: 'visible', timeout: timeoutMs });
  return Date.now() - start;
}

/** 三击选中 #target 整段；返回选中操作完成的时间戳（mouseup 之后），用作「松开鼠标」的参照点 */
export async function tripleClickTarget(page, selector = '#target') {
  await page.locator(selector).click({ clickCount: 3 });
  return Date.now();
}
