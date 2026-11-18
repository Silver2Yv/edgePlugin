// 选区策略（ARCHITECTURE 5.2、规则 4.3.5）：工具栏、右键、快捷键、降级抽取、诊断统一走这里
// 判断「要不要弹」「是不是代码」。只做纯判断，不碰事件、不读写 DOM 以外的状态。

const FORM_FIELD_SELECTOR = 'input, textarea, [contenteditable=""], [contenteditable="true"]';
const CODE_SELECTOR = 'pre, code';

export interface SelectionDecision {
  /** 是否应当弹出工具栏 */
  show: boolean;
  /** show 为真时的选中文字；否则空串 */
  text: string;
  /** 选区在代码块 / 代码页里（A6），show 为假时恒为假 */
  inCode: boolean;
}

function closest(node: Node | null, selector: string): Element | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest(selector) ?? null;
}

// 选区落在表单输入、可编辑区域（含密码框，密码框本身也是 input）里：M6 不读敏感输入。
// TODO：只读多行输入框是例外（A1、M6），这轮先按表单输入统一处理，不做例外。
function inFormField(sel: Selection): boolean {
  return (
    closest(sel.anchorNode, FORM_FIELD_SELECTOR) !== null ||
    closest(sel.focusNode, FORM_FIELD_SELECTOR) !== null
  );
}

function inCodeBlock(sel: Selection): boolean {
  return closest(sel.anchorNode, CODE_SELECTOR) !== null && closest(sel.focusNode, CODE_SELECTOR) !== null;
}

/** 松开鼠标 / 键盘改变选区后调用；`sel` 一般是 `window.getSelection()` */
export function evaluateSelection(sel: Selection | null): SelectionDecision {
  if (sel === null || sel.isCollapsed) return { show: false, text: '', inCode: false };
  const text = sel.toString();
  if (text.trim() === '') return { show: false, text: '', inCode: false };
  if (inFormField(sel)) return { show: false, text: '', inCode: false };
  return { show: true, text, inCode: inCodeBlock(sel) };
}

/** 选区最后一行的矩形，取不到（如选区被折叠或范围异常）时返回 null */
export function lastLineRect(sel: Selection): DOMRect | null {
  if (sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(sel.rangeCount - 1);
  const rects = range.getClientRects();
  if (rects.length > 0) return rects[rects.length - 1] ?? null;
  const fallback = range.getBoundingClientRect();
  return fallback.width > 0 || fallback.height > 0 ? fallback : null;
}
