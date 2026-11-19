/**
 * 引用标记解析与挂载（5.10 + V-09 结论）。
 *
 * 写法（V-09 结论，全角括号编号）：
 * - 逐字引用：【12】原文【/12】
 * - 要点编号：【12】或【12,5】
 *
 * 安全要点：
 * - 不做字符串拼接 HTML。本模块只操作真实 DOM 文本节点，用
 *   createElement + setAttribute + textContent 生成引用节点；
 *   属性值和文本内容分别赋值，浏览器负责转义，不存在“属性里的引号
 *   提前闭合标签”这类注入路径。
 * - 编号正则只接受纯数字（[0-9]+），“【12" onclick=x】” 这种夹带属性
 *   字符的写法本身就不会被正则匹配为引用标记，天然落入“按普通文本
 *   显示”的分支，不需要额外转义逻辑。
 * - 只接受 allowedIds 集合内的编号；【12,99】只要有一个编号不在集合内，
 *   整条标记整体按普通文本显示（不展示“半个引用”）。allowedIds 取自
 *   conv/plan 消息里 RequestContextPlan.sentBlockIds（本轮实际发送的块）。
 *
 * 移植自 prototypes/v10-render/src/render/citation.ts（V-10 原型已验证）。
 */

// 与 prototypes/v09-citation/RESULT.md “推荐解析正则” 一致
const QUOTE_RE = /【([0-9]+)】([\s\S]*?)【\/\1】/g;
const NUMBER_RE = /【([0-9]+(?:\s*[,，、]\s*[0-9]+)*)】/g;

export interface CitationMatch {
  start: number;
  end: number;
  kind: 'quote' | 'number';
  ids: string[];
  quotedText?: string;
  raw: string;
}

function splitIds(idsRaw: string): string[] {
  return idsRaw
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 在一段纯文本里找出所有引用标记区间（已按 V-09 顺序去重叠）。 */
export function findCitationMatches(text: string): CitationMatch[] {
  const quoteRanges: CitationMatch[] = [];
  QUOTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null = QUOTE_RE.exec(text);
  while (m !== null) {
    quoteRanges.push({
      start: m.index,
      end: m.index + m[0].length,
      kind: 'quote',
      ids: [m[1] ?? ''],
      quotedText: m[2] ?? '',
      raw: m[0],
    });
    m = QUOTE_RE.exec(text);
  }

  const numberRanges: CitationMatch[] = [];
  NUMBER_RE.lastIndex = 0;
  m = NUMBER_RE.exec(text);
  while (m !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    const overlaps = quoteRanges.some((q) => start < q.end && end > q.start);
    if (!overlaps) numberRanges.push({ start, end, kind: 'number', ids: splitIds(m[1] ?? ''), raw: m[0] });
    m = NUMBER_RE.exec(text);
  }

  return [...quoteRanges, ...numberRanges].sort((a, b) => a.start - b.start);
}

function allIdsAllowed(ids: string[], allowedIds: ReadonlySet<string>): boolean {
  return ids.every((id) => allowedIds.has(id) || allowedIds.has(String(parseInt(id, 10))));
}

function buildCitationElement(doc: Document, match: CitationMatch): HTMLElement {
  if (match.kind === 'quote') {
    const el = doc.createElement('mark');
    el.setAttribute('class', 'ra-citation-quote');
    el.setAttribute('data-id', match.ids[0] ?? '');
    el.textContent = match.quotedText ?? '';
    return el;
  }
  const el = doc.createElement('sup');
  el.setAttribute('class', 'ra-citation');
  el.setAttribute('data-ids', match.ids.join(','));
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.textContent = `[${match.ids.join(',')}]`;
  return el;
}

const SKIP_TAGS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE']);
const SKIP_CLASS_SUBSTR = ['ra-math', 'ra-math-error'];

function shouldSkipSubtree(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  const cls = el.getAttribute('class') ?? '';
  return SKIP_CLASS_SUBSTR.some((c) => cls.includes(c));
}

function collectTextNodes(root: Node, _doc: Document): Text[] {
  const out: Text[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 1 /* ELEMENT_NODE */) {
      const el = node as Element;
      if (shouldSkipSubtree(el)) return;
    }
    if (node.nodeType === 3 /* TEXT_NODE */) {
      out.push(node as Text);
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(root);
  return out;
}

/**
 * 在容器内就地替换引用标记。只在真实 DOM 节点上操作：
 * 命中且 ids 全在 allowedIds 内 → 替换为引用元素；
 * 其余（不命中正则 / ids 不在允许集合内）→ 保持原样文本。
 */
export function applyCitations(
  root: Element,
  allowedIds: ReadonlySet<string>,
  doc: Document = root.ownerDocument as Document,
): void {
  const textNodes = collectTextNodes(root, doc);
  for (const textNode of textNodes) {
    const text = textNode.data;
    const matches = findCitationMatches(text).filter((m) => allIdsAllowed(m.ids, allowedIds));
    if (matches.length === 0) continue;

    const parent = textNode.parentNode;
    if (!parent) continue;

    let cursor = 0;
    const fragment = doc.createDocumentFragment();
    for (const match of matches) {
      if (match.start > cursor) {
        fragment.appendChild(doc.createTextNode(text.slice(cursor, match.start)));
      }
      fragment.appendChild(buildCitationElement(doc, match));
      cursor = match.end;
    }
    if (cursor < text.length) {
      fragment.appendChild(doc.createTextNode(text.slice(cursor)));
    }
    parent.replaceChild(fragment, textNode);
  }
}
