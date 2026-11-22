// 回答里的引用标记（5.7、V-09）与「引用 → 锚点」。纯逻辑：界面渲染（ui/render/citation.ts）与后台跳回（background/citations.ts）
// 用同一套解析，两边认的引用写法一致。
//
// 写法（V-09 结论，全角括号编号）：逐字引用【12】原文【/12】；要点编号【12】或【12,5】。
// 编号只接受纯数字：夹带属性字符的写法（【12" onclick=x】）根本不会被识别为引用。
import { truncateByJsonBytes } from '../domain/bytes';
import type { BlockId } from '../domain/ids';
import { type Anchor, makeAnchor } from './anchor';

// 与 prototypes/v09-citation/RESULT.md「推荐解析正则」一致
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

/** 在一段纯文本里找出所有引用标记区间（已按 V-09 顺序去重叠：逐字引用优先，编号不与之重叠） */
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

/** 引用编号规范成不带前导零的十进制（【012】与【12】是同一个） */
export const normalizeCitationNumber = (n: string): string => String(Number.parseInt(n, 10));

const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * 回答原文里有没有引用这个编号；有逐字引用且与界面报来的原文一致（忽略空白）时给出原文。
 * 界面报来的原文只在这里核对过才用来建锚点（快照过期时它是唯一的定位依据）
 */
export function citationInText(
  text: string,
  citation: string,
  quote: string | undefined,
): { cited: boolean; quote?: string } {
  const want = normalizeCitationNumber(citation);
  let cited = false;
  for (const m of findCitationMatches(text)) {
    if (!m.ids.some((id) => normalizeCitationNumber(id) === want)) continue;
    cited = true;
    if (quote !== undefined && m.kind === 'quote' && squash(m.quotedText ?? '') === squash(quote)) {
      return { cited, quote: m.quotedText ?? '' };
    }
  }
  return { cited };
}

/**
 * 在块文本里找逐字引用的原文（忽略空白差异：模型摘录时常改动换行与空格）。
 * 找到返回块文本里的 [start, end)；多处出现取第一处（同一块内重复的句子位置差别不大）
 */
export function findQuoteInBlock(
  blockText: string,
  quote: string,
): { start: number; end: number } | undefined {
  const needle = squash(quote);
  if (needle === '') return undefined;
  const exact = blockText.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  // 去空白后的下标 → 原文下标
  const map: number[] = [];
  let flat = '';
  for (let i = 0; i < blockText.length; i++) {
    const ch = blockText[i] as string;
    if (/\s/.test(ch)) continue;
    map.push(i);
    flat += ch;
  }
  const at = flat.indexOf(needle);
  if (at < 0) return undefined;
  const start = map[at] as number;
  const end = (map[at + needle.length - 1] as number) + 1;
  return { start, end };
}

/** 逐字引用原文最多取这么多字建锚点（锚点 exact 上限 12 KB，定位只需要开头一段） */
const QUOTE_ANCHOR_MAX_BYTES = 12 * 1024;

/**
 * 引用 → 锚点（5.7）。有快照里的块文本时在块上建（逐字引用定位到原文，要点编号定位到整块）；
 * 快照过期（7 天）后只能按引用原文定位：只用原文本身，没有上下文与摘要。都没有返回 undefined
 */
export function citationAnchor(input: {
  block?: { id: BlockId; text: string };
  quote?: string;
  scrollRatio: number;
}): Anchor | undefined {
  const { block, quote, scrollRatio } = input;
  if (block) {
    const hit = quote === undefined ? undefined : findQuoteInBlock(block.text, quote);
    const range = hit ?? { start: 0, end: block.text.length };
    return makeAnchor({ text: block.text, headingPath: [] }, range.start, range.end, scrollRatio);
  }
  if (quote === undefined || squash(quote) === '') return undefined;
  return {
    exact: truncateByJsonBytes(quote.trim(), QUOTE_ANCHOR_MAX_BYTES).text,
    prefix: '',
    suffix: '',
    blockDigest: '',
    headingPath: [],
    scrollRatio: Number.isFinite(scrollRatio) ? Math.min(1, Math.max(0, scrollRatio)) : 0,
    offsetInBlock: 0,
  };
}
