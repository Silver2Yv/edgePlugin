// 实体回指（D5、5.6）：候选实体识别（年份、带单位数字、书名号/引号术语、英文专名、代码标识符、中文低频词）
// 与「在全页里找其他出现位置」的合并/去重/预算行为。都是启发式规则，断言看证据块能不能召回，不是命中数量（AR-13）：
// 中文分词是字典切词，不是命名实体识别，测试只验证机制本身（低频词被选中、高频词被排除），不苛求切出完整的专有名词。
import { describe, expect, it } from 'vitest';
import { extractEntityCandidates, findEntityBackReferences } from '@/core/context/entities';
import type { Block } from '@/core/context/page-doc';

const block = (n: number, text: string, kind: Block['kind'] = 'paragraph', path: string[] = []): Block => ({
  id: `b${n}`,
  kind,
  text,
  headingPath: path,
  frameId: 0,
});

describe('extractEntityCandidates：启发式识别', () => {
  it('年份、带单位数字、书名号/引号术语、英文专名、代码标识符各识别一种', () => {
    const text =
      '1927年发生的事情，涉及约3.5亿元资金，史称《某某事变》，又称“某某事件”，' +
      'Alan Turing 提出了理论，代码里用 fetchUserData 函数和 is_ready 变量。';
    const found = extractEntityCandidates(text, new Map());
    const byKind = (k: string) => found.filter((e) => e.kind === k).map((e) => e.text);
    expect(byKind('year')).toContain('1927');
    expect(byKind('numberUnit').some((t) => t.includes('3.5亿'))).toBe(true);
    expect(byKind('quotedTerm')).toContain('某某事变');
    expect(byKind('quotedTerm')).toContain('某某事件');
    expect(byKind('properNounEn')).toContain('Alan Turing');
    expect(byKind('codeIdentifier')).toContain('fetchUserData');
    expect(byKind('codeIdentifier')).toContain('is_ready');
  });

  it('中文按页内词频筛候选：低频词留下，高频虚词排除（分词是字典切词，不是专名识别）', () => {
    // Intl.Segmenter 把「西安事变」切成「西安」「事变」两个词，不是一个整体——这里只验证频率筛选本身
    const freq = new Map([
      ['的', 500],
      ['西安', 2],
      ['事变', 2],
    ]);
    const found = extractEntityCandidates('西安事变是一件大事，影响很大的', freq);
    const zh = found.filter((e) => e.kind === 'properNounZh').map((e) => e.text);
    expect(zh).toContain('西安');
    expect(zh).toContain('事变');
    expect(zh).not.toContain('的');
  });

  it('同一段文字里重复出现的实体只保留一次', () => {
    const found = extractEntityCandidates('1927年与1927年相隔多年', new Map());
    expect(found.filter((e) => e.text === '1927')).toHaveLength(1);
  });

  it('空字符串没有候选', () => {
    expect(extractEntityCandidates('', new Map())).toEqual([]);
  });
});

describe('findEntityBackReferences：到全页里找其他出现位置', () => {
  it('选区所在块之外的同实体出现位置被找到，按文档顺序排列，不重复已在 nearby 里的块', () => {
    const page: Block[] = [
      block(1, '标题', 'heading'),
      block(2, '选区所在段：1927 年发生的事。'),
      block(3, 'Unrelated filler paragraph three.'),
      block(4, 'Unrelated filler paragraph four.'),
      block(5, '另一段提到 1927 年的后续。'),
    ];
    const r = findEntityBackReferences('1927 年发生的事', page, new Set(['b2']));
    expect(r.extraBlockIds).toEqual(['b5']);
    expect(r.extraBlockIds).not.toContain('b3');
    expect(r.extraBlockIds).not.toContain('b4');
  });

  it('全页只在选区处出现过一次的实体被标记为 singleMention，不并入 extraBlockIds', () => {
    const page: Block[] = [
      block(1, '选区所在段：《孤本文献》只提到这一次。'),
      block(2, 'Unrelated filler paragraph two.'),
      block(3, 'Unrelated filler paragraph three.'),
    ];
    const r = findEntityBackReferences('《孤本文献》只提到这一次', page, new Set(['b1']));
    expect(r.extraBlockIds).toEqual([]);
    expect(r.singleMention).toContain('孤本文献');
  });

  it('最多并入 maxLocations 处，按文档顺序排列（不是随意顺序）', () => {
    const manyHits: Block[] = [
      block(1, '选区：2010 年的事。'),
      ...Array.from({ length: 10 }, (_, i) => block(i + 2, `Entry number ${i}: 2010 年再次提到。`)),
    ];
    const r = findEntityBackReferences('2010 年的事', manyHits, new Set(['b1']), 3);
    expect(r.extraBlockIds).toEqual(['b2', 'b3', 'b4']);
  });

  it('空选区或没有候选实体时不报错，返回空结果', () => {
    const page: Block[] = [block(1, '随便的一段内容。')];
    expect(findEntityBackReferences('', page, new Set())).toEqual({ extraBlockIds: [], singleMention: [] });
    expect(findEntityBackReferences('   ', page, new Set())).toEqual({
      extraBlockIds: [],
      singleMention: [],
    });
  });
});
