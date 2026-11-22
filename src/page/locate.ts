// 阅读器里的定位与高亮（5.7 引用跳回、F4 回到刚才的位置）。只在顶层框架，由 reader.ts 装配。
// 每次定位都重新抽取一次页面（5.6，几十毫秒），用这次抽取的「块 → DOM」对应找元素：块到 DOM 的对应只留在阅读器里。
// 版本相同才直接用后台给的块号；版本不同按锚点三级降级（精确 → 块内近似 → 滚动比例）重新定位，不把旧块号套到新内容上（V-06）。
// 高亮用 CSS 自定义高亮接口（CSS.highlights），不改网页 DOM；::highlight 样式由后台 scripting.insertCSS 注入。
// 不发网络请求，不持有对话内容：收到的只有锚点（引用的那一小段原文）。
import { type Anchor, matchAnchor } from '@/core/anchor/anchor';
import { type ExtractResult, extractPage } from './extract';

export type LocateLevel = 'exact' | 'fuzzy' | 'scroll' | 'none';

/** 高亮名；样式见 background/citations.ts 的 HIGHLIGHT_CSS */
export const HIGHLIGHT_NAME = 'ra-citation';

export interface LocateRequest {
  anchor: Anchor;
  highlight: boolean;
  blockId?: string;
  contentVersion?: string;
}

/** 跳转前的阅读位置：视口顶部的块与它的顶边离视口顶部多远（块内偏移） */
interface ReadingSpot {
  el: Element;
  top: number;
  scrollY: number;
}

const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * 在元素的文字里找一段文本（忽略空白差异），返回对应的 DOM 范围；找不到返回 undefined。
 * 块文本是按 innerText 抽的（换行、列表前缀与 DOM 文本节点不完全一样），所以按去掉空白后的字符对齐
 */
export function rangeOfText(el: Element, text: string): Range | undefined {
  const needle = squash(text);
  if (needle === '') return undefined;
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const map: { node: Text; offset: number }[] = [];
  let flat = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      if (/\s/.test(data[i] as string)) continue;
      map.push({ node, offset: i });
      flat += data[i];
    }
  }
  const at = flat.indexOf(needle);
  if (at < 0) return undefined;
  const start = map[at];
  const end = map[at + needle.length - 1];
  if (!start || !end) return undefined;
  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

function wholeRange(el: Element): Range {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  return range;
}

/** 视口顶部的第一个块（按文档顺序，抽取结果的块顺序就是文档顺序） */
function readingSpot(r: ExtractResult): ReadingSpot | undefined {
  for (const el of r.elements.values()) {
    const rect = el.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > 0) return { el, top: rect.top, scrollY: window.scrollY };
  }
  return undefined;
}

function scrollToElement(el: Element): void {
  const tall = el.getBoundingClientRect().height > window.innerHeight * 0.6;
  el.scrollIntoView({ block: tall ? 'start' : 'center', behavior: 'instant' });
}

/** 视口里要让开的区域（显示着的小窗），视口坐标 */
export interface AvoidRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const CLEAR_GAP = 12;

/** 滚过去之后原文若被小窗挡住：挪到小窗下方，放不下就挪到上方，都放不下就不动 */
function keepClear(r: DOMRect, a: AvoidRect | null): void {
  if (!a) return;
  const overlapX = r.left < a.left + a.width && r.right > a.left;
  const overlapY = r.top < a.top + a.height && r.bottom > a.top;
  if (!overlapX || !overlapY) return;
  const below = a.top + a.height + CLEAR_GAP;
  if (below + r.height <= window.innerHeight) {
    window.scrollBy({ top: r.top - below, behavior: 'instant' });
    return;
  }
  const above = a.top - CLEAR_GAP - r.height;
  if (above >= 0) window.scrollBy({ top: r.top - above, behavior: 'instant' });
}

/** 连续点两次引用、中间没自己滚动过：回去的还是第一次跳转前的位置，不是上一处引用 */
const STILL_PX = 4;

/** avoid：要让开的区域（阅读器给的是显示着的小窗），没有就不让 */
export function createLocator(doc: Document = document, avoid: () => AvoidRect | null = () => null) {
  let back: ReadingSpot | undefined;
  /** 上次跳转后的滚动位置 */
  let jumpedY: number | undefined;
  let clearOnPointer = false;

  const highlights = () =>
    typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
      ? CSS.highlights
      : undefined;

  function clearHighlight(): void {
    highlights()?.delete(HIGHLIGHT_NAME);
  }

  function highlight(range: Range): void {
    const reg = highlights();
    if (!reg) return;
    reg.set(HIGHLIGHT_NAME, new Highlight(range));
    // 用户在网页上点一下（接着读、选文字）就去掉高亮；只挂一次
    if (!clearOnPointer) {
      clearOnPointer = true;
      doc.addEventListener('pointerdown', (e) => e.isTrusted && clearHighlight(), {
        capture: true,
        passive: true,
      });
    }
  }

  function rememberSpot(r: ExtractResult): void {
    const stayed =
      back !== undefined && jumpedY !== undefined && Math.abs(window.scrollY - jumpedY) < STILL_PX;
    if (stayed) return;
    back = readingSpot(r) ?? { el: doc.documentElement, top: 0, scrollY: window.scrollY };
  }

  return {
    async locate(req: LocateRequest): Promise<{ level: LocateLevel; back: boolean }> {
      const r = await extractPage(doc);
      const blocks = r.report.blocks;
      let level: LocateLevel;
      let target: { el: Element; range: Range } | undefined;
      let scrollEl: Element | undefined;
      const sameVersion =
        req.blockId !== undefined &&
        req.contentVersion === r.report.contentVersion &&
        r.elements.has(req.blockId);
      const match = sameVersion ? undefined : matchAnchor(req.anchor, blocks);
      if (sameVersion || match?.level === 'exact' || match?.level === 'fuzzy') {
        const blockId = sameVersion ? (req.blockId as string) : (match as { blockId: string }).blockId;
        const el = r.elements.get(blockId);
        const block = blocks.find((b) => b.id === blockId);
        if (!el || !block) return { level: 'none', back: back !== undefined };
        // 版本相同：锚点原文在这块里的位置；近似匹配：匹配到的那一段
        let piece: string | undefined;
        if (match && (match.level === 'exact' || match.level === 'fuzzy')) {
          piece = block.text.slice(match.start, match.end);
        } else if (req.anchor.exact !== '') {
          piece = block.text.includes(req.anchor.exact) ? req.anchor.exact : undefined;
        }
        const whole = piece === undefined || squash(piece) === squash(block.text);
        target = { el, range: (whole ? undefined : rangeOfText(el, piece as string)) ?? wholeRange(el) };
        // 近似匹配（含原文重复、上下文分不出是哪一处的 score 0）都算降级，界面提示「原文可能已变化」
        level = sameVersion ? 'exact' : (match?.level as 'exact' | 'fuzzy');
      } else if (match?.level === 'scroll' && (req.blockId !== undefined || req.anchor.blockDigest !== '')) {
        // 找不到原文：滚到当前页面里编号最接近的块（块按文档顺序编号，旧编号大致对应位置）；没有块号才按滚动比例。
        // 只有原文、没有块号也没有块摘要的锚点（快照过期）给不出位置，不猜
        level = 'scroll';
        const n = Number.parseInt(req.blockId?.replace(/^\D+/, '') ?? '', 10);
        const near = Number.isFinite(n)
          ? r.elements.get(`b${Math.min(Math.max(1, n), blocks.length)}`)
          : undefined;
        if (near) scrollEl = near;
      } else {
        return { level: 'none', back: back !== undefined };
      }

      rememberSpot(r);
      clearHighlight();
      if (target) {
        const startEl =
          target.range.startContainer.nodeType === Node.ELEMENT_NODE
            ? (target.range.startContainer as Element)
            : (target.range.startContainer.parentElement ?? target.el);
        scrollToElement(target.el.contains(startEl) ? startEl : target.el);
        keepClear(target.range.getBoundingClientRect(), avoid());
        if (req.highlight) highlight(target.range);
      } else if (scrollEl) {
        scrollToElement(scrollEl);
        keepClear(scrollEl.getBoundingClientRect(), avoid());
      } else {
        const ratio = (match as { scrollRatio: number }).scrollRatio;
        const h = doc.documentElement.scrollHeight;
        window.scrollTo({ top: Math.max(0, ratio * h - window.innerHeight / 3), behavior: 'instant' });
      }
      jumpedY = window.scrollY;
      return { level, back: true };
    },

    /** 回到跳转前的阅读位置（一次性）；没有记下过返回 false */
    back(): boolean {
      const spot = back;
      back = undefined;
      jumpedY = undefined;
      clearHighlight();
      if (!spot) return false;
      if (spot.el.isConnected && spot.el !== doc.documentElement) {
        spot.el.scrollIntoView({ block: 'start', behavior: 'instant' });
        window.scrollBy({ top: spot.el.getBoundingClientRect().top - spot.top, behavior: 'instant' });
      } else {
        window.scrollTo({ top: spot.scrollY, behavior: 'instant' });
      }
      return true;
    },
  };
}

export type Locator = ReturnType<typeof createLocator>;
