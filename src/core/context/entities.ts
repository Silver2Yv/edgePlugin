// 实体回指（D5、5.6）：从选中文字里挑出候选实体——年份、带单位的数字、书名号/引号里的术语、
// 英文专名、代码标识符，中文另外用 Intl.Segmenter 切词后按「页内低频」筛可能的专名——
// 到全页正文里找这些实体的其他出现位置，连同所在块一起并入 nearby 档的发送内容（5.6「实体回指」）。
// 全是启发式规则：验收标准看证据块召回，不看命中数量（AR-13），所以没有追求覆盖所有实体类型的穷尽正则。
import type { BlockId } from '../domain/ids';
import type { Block } from './page-doc';

export type EntityKind =
  | 'year'
  | 'numberUnit'
  | 'quotedTerm'
  | 'properNounEn'
  | 'codeIdentifier'
  | 'properNounZh';

export interface EntityMatch {
  text: string;
  kind: EntityKind;
}

const YEAR_RE = /(?<![0-9])(1[0-9]{3}|20[0-9]{2})(?![0-9])/g;
// 结尾不用 \b：中文单位（亿、万、元……）不是 \w，\b 在它们后面测不出边界，恒不匹配
const NUMBER_UNIT_RE =
  /\d+(?:\.\d+)?\s?(?:%|℃|km|kg|ms|GB|MB|KB|cm|mm|m²|m|亿|万|千|百|元|美元|欧元|公里|千米|米|厘米|毫米|公斤|千克|克|吨|倍|次|个|度|年|月|日|小时|分钟|秒)(?![a-zA-Z0-9])/g;
const QUOTED_RE = /[《〈]([^《》〈〉]{1,30})[》〉]|[“「]([^”」]{1,30})[”」]|"([^"]{1,30})"/g;
const PROPER_NOUN_EN_RE = /\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}\b/g;
/** 反引号内联代码，或 camelCase / snake_case 形式的裸标识符 */
const CODE_IDENTIFIER_RE =
  /`([^`]{1,60})`|\b[a-zA-Z_][a-zA-Z0-9]*(?:[A-Z][a-z0-9]*)+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/g;

/** 页内词频超过这个次数就不算候选专名（启发式阈值，不是精确定义） */
const MAX_ZH_PAGE_FREQ = 3;
/** 中文分词最短长度：单字大多是虚词，不值得当专名候选 */
const MIN_ZH_TERM_LEN = 2;
/** 全页分词的字符上限（性能兜底，不是正确性要求）：超出部分不参与词频统计 */
const MAX_FREQ_CHARS = 200_000;

function extractRegex(
  text: string,
  re: RegExp,
  kind: EntityKind,
  pick: (m: RegExpMatchArray) => string | undefined,
): EntityMatch[] {
  const out: EntityMatch[] = [];
  for (const m of text.matchAll(re)) {
    const t = pick(m)?.trim();
    if (t) out.push({ text: t, kind });
  }
  return out;
}

type SegmenterCtor = new (
  locale: string,
  opts: { granularity: string },
) => { segment: (s: string) => Iterable<{ segment: string; isWordLike?: boolean }> };

/** Intl.Segmenter 不可用的环境（如旧测试运行时）直接跳过中文分词，不报错 */
function segmentZhWords(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (!Seg) return [];
  const seg = new Seg('zh', { granularity: 'word' });
  const out: string[] = [];
  for (const { segment, isWordLike } of seg.segment(text)) {
    if (isWordLike && [...segment].length >= MIN_ZH_TERM_LEN) out.push(segment);
  }
  return out;
}

/** 全页词频：中文分词统计各词出现次数，用于筛「页内低频」的专名候选 */
function pageWordFreq(blocks: readonly Block[]): Map<string, number> {
  const freq = new Map<string, number>();
  let chars = 0;
  for (const b of blocks) {
    if (chars >= MAX_FREQ_CHARS) break;
    chars += b.text.length;
    for (const w of segmentZhWords(b.text)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return freq;
}

/** 从选中文字里识别候选实体，按原文去重（同样的文字只留第一次命中的类别） */
export function extractEntityCandidates(selectionText: string, pageFreq: Map<string, number>): EntityMatch[] {
  const found: EntityMatch[] = [
    ...extractRegex(selectionText, YEAR_RE, 'year', (m) => m[0]),
    ...extractRegex(selectionText, NUMBER_UNIT_RE, 'numberUnit', (m) => m[0]),
    ...extractRegex(selectionText, QUOTED_RE, 'quotedTerm', (m) => m[1] ?? m[2] ?? m[3]),
    ...extractRegex(selectionText, PROPER_NOUN_EN_RE, 'properNounEn', (m) => m[0]),
    ...extractRegex(selectionText, CODE_IDENTIFIER_RE, 'codeIdentifier', (m) => m[1] ?? m[0]),
  ];
  for (const w of segmentZhWords(selectionText)) {
    if ((pageFreq.get(w) ?? 0) <= MAX_ZH_PAGE_FREQ) found.push({ text: w, kind: 'properNounZh' });
  }
  const seen = new Set<string>();
  return found.filter((e) => {
    if (seen.has(e.text)) return false;
    seen.add(e.text);
    return true;
  });
}

export interface EntityBackReferenceReport {
  /** 并入 nearby 的块号，已与原有 nearby 去重、按文档顺序 */
  extraBlockIds: BlockId[];
  /** 识别出但全页只出现这一处（即选区所在块本身，别处再没提到）的实体原文 */
  singleMention: string[];
}

/**
 * 在全页块里找候选实体的其他出现位置。excludeIds 是已经在 nearby 发送范围内的块号（去重用）；
 * maxLocations 限制并入的块数上限（5.6：最多 5 处）
 */
export function findEntityBackReferences(
  selectionText: string,
  blocks: readonly Block[],
  excludeIds: ReadonlySet<BlockId>,
  maxLocations = 5,
): EntityBackReferenceReport {
  if (!selectionText.trim()) return { extraBlockIds: [], singleMention: [] };
  const pageFreq = pageWordFreq(blocks);
  const candidates = extractEntityCandidates(selectionText, pageFreq);
  const indexOf = new Map(blocks.map((b, i) => [b.id, i]));
  const extra = new Map<BlockId, number>();
  const singleMention: string[] = [];
  for (const { text: needle } of candidates) {
    if (extra.size >= maxLocations) break;
    const hitBlocks = blocks.filter((b) => b.text.includes(needle));
    const otherHits = hitBlocks.filter((b) => !excludeIds.has(b.id));
    if (hitBlocks.length <= 1 && otherHits.length === 0) {
      singleMention.push(needle);
      continue;
    }
    for (const b of otherHits) {
      if (extra.size >= maxLocations) break;
      if (!extra.has(b.id)) extra.set(b.id, indexOf.get(b.id) ?? 0);
    }
  }
  const extraBlockIds = [...extra.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  return { extraBlockIds, singleMention };
}
