// 选区策略（ARCHITECTURE 5.2、规则 4.3.5）：工具栏、右键、快捷键、降级抽取、诊断统一走这里
// 判断「要不要弹」「是不是代码」。只做纯判断，不碰事件、不读写 DOM 以外的状态。
//
// M6：密码框与所有表单输入的值不读。唯一例外是只读多行输入框（A1：GitHub 代码页的选区就落在只读输入框里）——
// 只认 textarea，且带 readonly 或 aria-readonly="true"、未禁用；单行输入框、密码框即使只读也不例外。
// Chrome 里选中输入框内的文字时，window.getSelection() 的锚点是输入框的父元素、toString() 却是框里的文字，
// 只看锚点会把输入框里的内容当成网页文字（V-04 实测），所以先看焦点元素。

const FORM_FIELD_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
const CODE_SELECTOR = 'pre, code';

export interface SelectionDecision {
  /** 是否应当弹出工具栏 */
  show: boolean;
  /** show 为真时的选中文字；否则空串 */
  text: string;
  /** 选区在代码块 / 代码页里（A6），show 为假时恒为假 */
  inCode: boolean;
  /** 选区来自只读多行输入框（取不到文字矩形，工具栏按指针或输入框位置定位） */
  readonlyInput?: HTMLTextAreaElement;
}

const NO: SelectionDecision = { show: false, text: '', inCode: false };

/** 选中少于 2 个字不弹（A5），按码点数，与 originalLength 同口径 */
const MIN_SELECTION_CHARS = 2;
const longEnough = (text: string): boolean => [...text].length >= MIN_SELECTION_CHARS;

/** 只读多行输入框：A1/M6 的唯一例外。抽取（extract.ts）与选区共用这一个判断 */
export function isReadonlyCodeInput(el: Element | null | undefined): el is HTMLTextAreaElement {
  if (el?.tagName !== 'TEXTAREA') return false;
  const ta = el as HTMLTextAreaElement;
  return !ta.disabled && (ta.readOnly || ta.getAttribute('aria-readonly') === 'true');
}

function closest(node: Node | null, selector: string): Element | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest(selector) ?? null;
}

/** 焦点所在的元素，穿过开放的 shadow root */
function deepActive(doc: Document): Element | null {
  let a: Element | null = doc.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

// 选区落在可编辑区域（contenteditable）或表单元素里
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
  if (sel === null) return NO;
  // 先看焦点：输入框里的选区在 Selection 上可能表现为折叠（isCollapsed）或锚点落在父元素上
  const doc = (sel.anchorNode?.ownerDocument ?? globalThis.document) as Document | undefined;
  const active = doc ? deepActive(doc) : null;
  if (active?.matches('input, textarea, select')) {
    if (!isReadonlyCodeInput(active)) return NO;
    const { selectionStart, selectionEnd, value } = active;
    const text = value.slice(Math.min(selectionStart, selectionEnd), Math.max(selectionStart, selectionEnd));
    if (text.trim() === '' || !longEnough(text)) return NO;
    return { show: true, text, inCode: true, readonlyInput: active };
  }
  if (sel.isCollapsed) return NO;
  const text = sel.toString();
  if (text.trim() === '') return NO;
  if (!longEnough(text)) return NO;
  if (inFormField(sel)) return NO;
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

/**
 * 选区第一行的顶边（A5）：工具栏翻到上方时要贴着整个选区的上沿，不能按最后一行算——
 * 多行选区的最后一行贴近视口底部时，按最后一行翻上去会盖住选区前面几行。取不到时返回 null。
 */
export function selectionTop(sel: Selection): number | null {
  if (sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  if (rects.length > 0) return rects[0]?.top ?? null;
  const fallback = range.getBoundingClientRect();
  return fallback.width > 0 || fallback.height > 0 ? fallback.top : null;
}

/**
 * 只读输入框拿不到文字矩形时的定位（A1、5.2）：有松开鼠标的位置就用它（当作一行高的矩形），
 * 键盘选择时用输入框自身矩形的左下角
 */
export function readonlyInputRect(input: Element, pointer?: { x: number; y: number }): DOMRect {
  if (pointer) return new DOMRect(pointer.x, pointer.y - 16, 1, 16);
  const r = input.getBoundingClientRect();
  return new DOMRect(r.left, r.bottom - 16, 1, 16);
}
