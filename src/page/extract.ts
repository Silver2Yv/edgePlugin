// 页面读取（5.6 抽取）：V-08 方案 A 的移植（prototypes/v08-extraction/src/extractor-src/scheme-a.js、shared.js）。
// 规则照原型：找正文根节点（语义标签 → 文本密度 → body）→ 自上而下分块；导航、页眉页脚、表单、脚本等整枝跳过；
// display:none / visibility:hidden / hidden 不读，语义折叠容器（未展开的 details、aria-expanded="false"）里的照读。
// 相对原型修了 RESULT.md 第 5、10 节点名的两类缺陷：
//   1. 根节点误选：原型只看候选元素自身的样式，祖先被隐藏的弹框（MIT OCW「即将离开本站」）也能当选；
//      公式密集的小块（nLab）文本密度虚高。现在候选要整条祖先链可见，且正文至少占整页可读文字的一定比例，
//      不够就退回语义容器或 body。
//   2. GitHub 代码页：代码在只读多行输入框里（逐行渲染的那一层是 aria-hidden），按 A1/M6 的唯一例外整体读成一个代码块。
// 表单输入值一律不读（M6）：密码框、普通输入框、可编辑的 textarea、select 整枝跳过；contenteditable 区域也不读。
// 分时间片执行（5.15）：每片不超过 SLICE_MS，用 scheduler.yield / setTimeout 让出主线程。
// 块到 DOM 的对应只留在阅读器里（elements），不随消息传递。

import { contentVersionOf } from '@/core/context/content-version';
import type { BlockKind, BlockReport, PageDocReport, PageNote } from '@/core/context/page-doc';
import { isReadonlyCodeInput } from './selection-policy';

const SKIP_SELECTOR = [
  'nav',
  'header',
  'footer',
  'form',
  'script',
  'style',
  'noscript',
  'template',
  'button',
  'input',
  'textarea',
  'select',
  'iframe',
  'frame',
  'object',
  'embed',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
].join(',');

const NOISE_CLASS_HINT =
  /(^|[\s_-])(comment|comments|advert|ads|sidebar|promo|subscribe|newsletter|related|recommend|breadcrumb|pagination|share|social|cookie|banner|masthead)([\s_-]|$)/i;

const INLINE_TAGS = new Set([
  'SPAN',
  'A',
  'B',
  'I',
  'EM',
  'STRONG',
  'BR',
  'SUP',
  'SUB',
  'CODE',
  'IMG',
  'SMALL',
  'U',
  'MARK',
  'ABBR',
  'TIME',
  'WBR',
]);

/** 单片时长上限（毫秒）。5.15 的 50 ms 是风险上限，不是切片目标 */
export const SLICE_MS = 8;
/** 单块最多这么多字，超出按行切成几块（契约 blockSchema 上限 6 万字；块小一些，前后段落的粒度才有意义） */
const MAX_BLOCK_CHARS = 8000;
/** 整页最多读这么多字、这么多块，超出记 truncated */
const MAX_TOTAL_CHARS = 1_000_000;
const MAX_BLOCKS = 20_000;
/** 文本密度候选的正文至少占整页可读文字的比例，低于它视为误选（修复 1） */
const ROOT_MIN_SHARE = 0.3;
const TOO_LITTLE_TEXT = 200;
/** 正文几乎为零（D15 失败兜底）：已经退到 body 兜底仍几乎读不到字，给出下一步建议而不是静默返回空结果 */
const NEARLY_EMPTY_TEXT = 40;
const NEARLY_EMPTY_HINT =
  '可能是画布 / 图片类页面，正文几乎无法读取；可以框选需要的内容截图提问（截图功能尚未上线）';
const HEADING_PATH_CHARS = 200;

export interface ExtractResult {
  report: PageDocReport;
  /** 块编号 → 元素（切开的长块几个编号指向同一个元素）；只留在阅读器里 */
  elements: Map<string, Element>;
  rootMethod: 'semantic-tag' | 'text-density' | 'fallback-body';
  stats: { totalMs: number; slices: number; maxSliceMs: number };
}

// ───────────── 可见性与文字 ─────────────

function insideSemanticCollapsed(el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur.tagName === 'DETAILS' && !(cur as HTMLDetailsElement).open) return true;
    if (cur.getAttribute('aria-expanded') === 'false') return true;
  }
  return false;
}

/** 元素自身的显示状态（自上而下遍历时祖先已检查过） */
function selfVisible(el: Element): boolean {
  if (el.hasAttribute('hidden')) return insideSemanticCollapsed(el);
  let style: CSSStyleDeclaration;
  try {
    style = getComputedStyle(el);
  } catch {
    return true;
  }
  if (style.display === 'none' || style.visibility === 'hidden') return insideSemanticCollapsed(el);
  return true;
}

/**
 * 整条祖先链都可见（选根节点用，修复 1）：自身按 selfVisible，祖先只看 display:none（visibility 会继承到自身）。
 * 不用 checkVisibility：未升级的自定义元素里的内容（脚本没跑完时）它判为不可见，原型却能读到，会误伤。
 * memo 缓存祖先的结果，一次抽取里每个元素只算一次样式
 */
function chainVisible(el: Element, memo: Map<Element, boolean>): boolean {
  if (!selfVisible(el)) return false;
  const seen: Element[] = [];
  let ok = true;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const known = memo.get(p);
    if (known !== undefined) {
      ok = known;
      break;
    }
    seen.push(p);
    let display = '';
    try {
      display = getComputedStyle(p).display;
    } catch {
      // 取不到样式按可见
    }
    if (display === 'none' && !insideSemanticCollapsed(p)) {
      ok = false;
      break;
    }
  }
  for (const p of seen) memo.set(p, ok);
  return ok;
}

function looksLikeNoise(el: Element): boolean {
  const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '';
  return NOISE_CLASS_HINT.test(cls) || NOISE_CLASS_HINT.test(el.id);
}

/** 用渲染后的文字（innerText）：隐藏的、换行与空白都按页面实际显示算；取不到（未渲染）再退回 textContent */
// biome-ignore lint/performance/useDomNodeTextContent: 抽取要的是用户看得到的文字，textContent 会混进隐藏内容
const rawText = (el: Element): string => (el as HTMLElement).innerText || el.textContent || '';
const textLen = (el: Element): number => rawText(el).replace(/\s+/g, '').length;

// ───────────── 序列化 ─────────────

function headingLevel(tag: string): number | undefined {
  const m = /^H([1-6])$/.exec(tag);
  return m ? Number(m[1]) : undefined;
}

function isFormulaBlock(el: Element): boolean {
  if (
    el.matches('.katex-display, .MathJax_Display, math[display="block"], .mwe-math-element, annotation-xml')
  )
    return true;
  return el.tagName.toUpperCase() === 'MATH' && !el.closest('p,li,td,span');
}

/** 公式优先取页面自带的 LaTeX 源（D6） */
function formulaSource(el: Element): string {
  const attr = el.getAttribute('data-latex');
  if (attr) return attr.trim();
  const tex = el.querySelector('annotation[encoding="application/x-tex"]');
  if (tex?.textContent) return tex.textContent.trim();
  const script = el.querySelector('script[type="math/tex"], script[type="math/tex; mode=display"]');
  if (script?.textContent) return script.textContent.trim();
  return rawText(el).trim();
}

const cell = (c: Element) => rawText(c).trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|');

/** 表格整表一个块，序列化为 Markdown 表格（首行后加分隔行） */
function serializeTable(table: Element): string {
  const rows = [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('th,td')].map(cell));
  const lines = rows.filter((r) => r.length > 0).map((r) => `| ${r.join(' | ')} |`);
  if (lines.length > 1) {
    const cols = rows[0]?.length ?? 1;
    lines.splice(1, 0, `|${' --- |'.repeat(Math.max(1, cols))}`);
  }
  return lines.join('\n');
}

/**
 * 列表项：每个 <li> 一个块（修复 3：列表页粒度塌陷）。整组列表仍是同一个上下文单元（5.6「列表项归入
 * 所属列表」），只是不再把所有项挤成一个不可拆分的大块：块越细，预算放不下时能保留前面几项而不是整组都丢，
 * 引用锚点也能精确指到某一项，而不是整个列表。isUnit/widen（select.ts）按「连续的 listItem 算一个单元」
 * 把这些块收拢回「一个单元」，对「前后 3 段」的计数效果和原先一样
 */
function listItemsOf(list: Element): Element[] {
  return [...list.children].filter((c) => c.tagName === 'LI');
}
function formatListItem(li: Element, index: number, ordered: boolean): string {
  return `${ordered ? `${index + 1}.` : '-'} ${rawText(li).trim().replace(/\s+/g, ' ')}`;
}

function codeLang(el: Element): string | undefined {
  const cls = `${el.className} ${el.querySelector('code')?.className ?? ''}`;
  const m = /(?:^|\s)(?:language|lang)-([\w+#.-]{1,40})/.exec(cls);
  return m?.[1];
}

const fence = (code: string, lang = '') => {
  const ticks = /```/.test(code) ? '~~~~' : '```';
  return `${ticks}${lang}\n${code.replace(/\n+$/, '')}\n${ticks}`;
};

/** 按行切成不超过 max 字的几段；单行超长时硬切 */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > max) {
      if (cur) out.push(cur);
      cur = '';
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    if (cur && cur.length + 1 + rest.length > max) {
      out.push(cur);
      cur = rest;
    } else {
      cur = cur ? `${cur}\n${rest}` : rest;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 子元素全是行内标签（或没有子元素）的容器也当段落（原型：百度百科的 div.para） */
function isLeafTextBlock(el: Element): boolean {
  const children = [...el.children];
  if (children.length === 0) return textLen(el) > 0;
  return children.every((c) => INLINE_TAGS.has(c.tagName));
}

// ───────────── 时间片 ─────────────

const yieldToMain = (): Promise<void> => {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return typeof s?.yield === 'function' ? s.yield() : new Promise((r) => setTimeout(r, 0));
};

function createSlicer(sliceMs: number) {
  let start = performance.now();
  let slices = 1;
  let maxSliceMs = 0;
  return {
    async tick(): Promise<void> {
      const now = performance.now();
      if (now - start < sliceMs) return;
      maxSliceMs = Math.max(maxSliceMs, now - start);
      await yieldToMain();
      start = performance.now();
      slices++;
    },
    finish() {
      maxSliceMs = Math.max(maxSliceMs, performance.now() - start);
      return { slices, maxSliceMs };
    },
  };
}

// ───────────── 根节点（5.6 第 1 步） ─────────────

async function findRoot(
  doc: Document,
  tick: () => Promise<void>,
): Promise<{ root: Element; method: ExtractResult['rootMethod'] }> {
  const body = doc.body ?? doc.documentElement;
  const memo = new Map<Element, boolean>();
  const semantic = [...doc.querySelectorAll('article, main, [role="main"]')]
    .filter((el) => chainVisible(el, memo))
    .map((el) => ({ el, len: textLen(el) }))
    .filter((c) => c.len > 200)
    .sort((a, b) => b.len - a.len);
  await tick();
  if (semantic[0]) return { root: semantic[0].el, method: 'semantic-tag' };

  let best: Element | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestLen = 0;
  for (const el of doc.querySelectorAll('div, section, td')) {
    await tick();
    if (!chainVisible(el, memo) || looksLikeNoise(el)) continue;
    const len = textLen(el);
    if (len < 140) continue;
    const pCount = el.querySelectorAll('p').length;
    let linkLen = 0;
    for (const a of el.querySelectorAll('a')) linkLen += rawText(a).replace(/\s+/g, '').length;
    const density = 1 - Math.min(1, linkLen / Math.max(len, 1));
    let depth = 0;
    for (let p: Element | null = el; p; p = p.parentElement) depth++;
    const score = (len * density * (1 + Math.min(pCount, 12) * 0.15)) / (1 + depth * 0.05);
    if (score > bestScore) {
      bestScore = score;
      best = el;
      bestLen = len;
    }
  }
  // 修复 1：密度最高的候选正文太少（公式小块、局部弹框），往上找第一个占比够的祖先；都不够就整页
  if (best) {
    const pageLen = textLen(body);
    let root: Element | null = best;
    let len = bestLen;
    while (root && root !== body && len < pageLen * ROOT_MIN_SHARE) {
      root = root.parentElement;
      len = root ? textLen(root) : 0;
    }
    if (root && root !== body) return { root, method: 'text-density' };
  }
  return { root: body, method: 'fallback-body' };
}

// ───────────── 分块 ─────────────

interface RawBlock {
  kind: BlockKind;
  text: string;
  level?: number;
  lang?: string;
  headingPath: string[];
  el: Element;
}

export async function extractPage(doc: Document, opts: { sliceMs?: number } = {}): Promise<ExtractResult> {
  const t0 = performance.now();
  const slicer = createSlicer(opts.sliceMs ?? SLICE_MS);
  const tick = () => slicer.tick();
  const { root, method } = await findRoot(doc, tick);

  const raw: RawBlock[] = [];
  const trail: { level: number; text: string }[] = [];
  let totalChars = 0;
  let truncated = false;
  let collapsedRead = false;

  const push = (
    kind: BlockKind,
    el: Element,
    text: string,
    extra: { level?: number; lang?: string } = {},
  ) => {
    const t = text.trim();
    if (!t || truncated) return;
    if (totalChars + t.length > MAX_TOTAL_CHARS || raw.length >= MAX_BLOCKS) {
      truncated = true;
      return;
    }
    totalChars += t.length;
    if (!collapsedRead && insideSemanticCollapsed(el)) collapsedRead = true;
    raw.push({ kind, text: t, headingPath: trail.map((h) => h.text), el, ...extra });
  };

  // 自上而下、按文档顺序遍历（显式栈，便于分片让出）
  const stack: Element[] = [root];
  while (stack.length > 0 && !truncated) {
    await tick();
    const el = stack.pop() as Element;
    // 唯一例外（A1/M6）：只读多行输入框里的代码整体读成一个代码块
    if (isReadonlyCodeInput(el)) {
      if (selfVisible(el)) push('code', el, fence(el.value));
      continue;
    }
    if (el.matches(SKIP_SELECTOR) || !selfVisible(el) || looksLikeNoise(el)) continue;
    const tag = el.tagName.toUpperCase();
    const level = headingLevel(tag);
    if (level !== undefined) {
      while (trail.length && (trail.at(-1)?.level ?? 0) >= level) trail.pop();
      const text = rawText(el).trim().replace(/\s+/g, ' ');
      push('heading', el, text, { level });
      if (text) trail.push({ level, text: text.slice(0, HEADING_PATH_CHARS) });
      continue;
    }
    if (tag === 'UL' || tag === 'OL') {
      const ordered = tag === 'OL';
      listItemsOf(el).forEach((li, i) => {
        push('listItem', li, formatListItem(li, i, ordered));
      });
    } else if (tag === 'TABLE') push('table', el, serializeTable(el));
    else if (tag === 'PRE') {
      const lang = codeLang(el);
      push('code', el, fence(rawText(el), lang), lang ? { lang } : {});
    } else if (tag === 'BLOCKQUOTE') push('quote', el, rawText(el));
    else if (isFormulaBlock(el)) push('math', el, `$$\n${formulaSource(el)}\n$$`);
    else if (tag === 'P' || tag === 'FIGCAPTION' || tag === 'DD') push('paragraph', el, rawText(el));
    else if (
      (tag === 'DIV' || tag === 'SECTION') &&
      isLeafTextBlock(el) &&
      textLen(el) > 6 &&
      textLen(el) < 3000
    )
      // 上限 3000 字：避免层层嵌套的行内结构（KaTeX 公式表）被吞成一个巨块（原型的保守取舍）
      push('paragraph', el, rawText(el));
    else {
      const children = el.children;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as Element);
    }
  }

  // 编号、切长块
  const blocks: BlockReport[] = [];
  const elements = new Map<string, Element>();
  for (const b of raw) {
    const fenced = b.kind === 'code' && /^(```|~~~~)/.test(b.text);
    const body = fenced ? b.text.replace(/^(```|~~~~)[^\n]*\n/, '').replace(/\n(```|~~~~)$/, '') : b.text;
    const pieces = splitLong(body, MAX_BLOCK_CHARS);
    for (const piece of pieces) {
      const id = `b${blocks.length + 1}`;
      const text = fenced ? fence(piece, b.lang) : piece;
      blocks.push({
        id,
        kind: b.kind,
        text,
        headingPath: b.headingPath,
        ...(b.level !== undefined ? { level: b.level } : {}),
        ...(b.lang !== undefined ? { lang: b.lang } : {}),
      });
      elements.set(id, b.el);
    }
    await tick();
  }

  const textLength = blocks.reduce((n, b) => n + [...b.text].length, 0);
  const notes: PageNote[] = [];
  const frames = doc.querySelectorAll('iframe, frame').length;
  if (frames > 0) notes.push({ kind: 'frameSkipped', detail: `${frames} 个` });
  if (method === 'fallback-body') notes.push({ kind: 'fallbackBodyText' });
  if (textLength < TOO_LITTLE_TEXT)
    notes.push({
      kind: 'tooLittleText',
      ...(textLength < NEARLY_EMPTY_TEXT ? { detail: NEARLY_EMPTY_HINT } : {}),
    });
  if (collapsedRead) notes.push({ kind: 'visibilityUncertain', detail: '含折叠区里的内容' });
  if (truncated) notes.push({ kind: 'truncated' });

  const title = (doc.title || '').trim().slice(0, 2000);
  const lang = doc.documentElement.lang?.trim().slice(0, 40);
  const report: PageDocReport = {
    contentVersion: contentVersionOf(title, blocks),
    title,
    ...(lang ? { lang } : {}),
    blocks,
    notes,
    textLength,
    extractedAt: Date.now(),
  };
  const { slices, maxSliceMs } = slicer.finish();
  return {
    report,
    elements,
    rootMethod: method,
    stats: { totalMs: performance.now() - t0, slices, maxSliceMs },
  };
}
