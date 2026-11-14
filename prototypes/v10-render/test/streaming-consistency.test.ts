import { describe, it, expect } from 'vitest';
import { createMarkdownIt } from '../src/render/markdown-it-setup.js';
import { createStreamingRenderer, type RenderedBlock } from '../src/render/streaming-renderer.js';
import { assertSafeDom } from './dom-assert.js';
import { CHUNK_STRATEGIES } from './chunk-utils.js';
import * as F from './fixtures.js';

function oneShotHtml(text: string, allowedIds: ReadonlySet<string>): string[] {
  const md = createMarkdownIt();
  const renderer = createStreamingRenderer({ md, document });
  const blocks = renderer.finalize(text, allowedIds);
  return blocks.map((b) => b.node.outerHTML);
}

function streamedFinalHtml(
  text: string,
  allowedIds: ReadonlySet<string>,
  split: (t: string) => string[]
): { html: string[]; blocks: RenderedBlock[] } {
  const md = createMarkdownIt();
  const renderer = createStreamingRenderer({ md, document });
  const chunks = split(text);
  let acc = '';
  for (const chunk of chunks) {
    acc += chunk;
    renderer.update(acc, allowedIds);
  }
  const finalBlocks = renderer.finalize(acc, allowedIds);
  return { html: finalBlocks.map((b) => b.node.outerHTML), blocks: finalBlocks };
}

const FIXTURES: Array<{ name: string; text: string; allowedIds?: ReadonlySet<string> }> = [
  { name: '嵌套列表', text: F.NESTED_LIST },
  { name: '表格', text: F.TABLE_SAMPLE },
  { name: '未闭合代码围栏', text: F.UNCLOSED_CODE_FENCE },
  { name: '未闭合公式块', text: F.UNCLOSED_MATH_BLOCK },
  { name: '后置引用链接定义', text: F.TRAILING_REFERENCE_DEFINITION },
  { name: '超长代码块', text: F.LONG_CODE_BLOCK },
  { name: '巨大公式', text: F.HUGE_FORMULA },
  { name: 'KaTeX 语法错误', text: F.KATEX_SYNTAX_ERROR },
  { name: 'KaTeX 宏递归', text: F.KATEX_MACRO_RECURSION },
  { name: 'KaTeX href/url', text: F.KATEX_HREF_URL },
  { name: '综合文档', text: F.MULTI_PARAGRAPH_WITH_CODE_AND_TABLE },
  { name: '引用标记属性字符', text: F.CITATION_ATTRIBUTE_CHARS, allowedIds: F.CITATION_ALLOWED_IDS },
  { name: '原始 HTML 注入', text: F.RAW_HTML_INJECTION },
  { name: '危险协议链接', text: F.DANGEROUS_PROTOCOL_LINKS }
];

describe('V-10 流式一致性：增量结果 == 一次性完整渲染', () => {
  for (const fixture of FIXTURES) {
    for (const strategy of CHUNK_STRATEGIES) {
      it(`${fixture.name} × ${strategy.name}`, () => {
        const allowedIds = fixture.allowedIds ?? new Set<string>();
        const expected = oneShotHtml(fixture.text, allowedIds);
        const { html: actual, blocks } = streamedFinalHtml(fixture.text, allowedIds, strategy.split);
        expect(actual).toEqual(expected);
        for (const b of blocks) {
          const violations = assertSafeDom(b.node);
          expect(violations).toEqual([]);
        }
      });
    }
  }
});

describe('V-10 稳定块 key：已完成块的渲染结果在后续增量中不变', () => {
  it('综合文档逐字符流式输入时，已出现的早期块 outerHTML 在后续更新中保持一致', () => {
    const md = createMarkdownIt();
    const renderer = createStreamingRenderer({ md, document });
    const text = F.MULTI_PARAGRAPH_WITH_CODE_AND_TABLE;
    const chunks = Array.from(text);
    let acc = '';
    const seenHtmlByKey = new Map<number, string>();
    for (const chunk of chunks) {
      acc += chunk;
      const blocks = renderer.update(acc, new Set());
      // 跳过最后一块（它始终是 open，允许变化），检查其余已完成块
      for (let i = 0; i < blocks.length - 1; i++) {
        const b = blocks[i];
        const prevHtml = seenHtmlByKey.get(b.key);
        if (prevHtml !== undefined) {
          expect(b.node.outerHTML).toBe(prevHtml);
        }
        seenHtmlByKey.set(b.key, b.node.outerHTML);
      }
    }
  });
});

describe('V-10 流结束校正：后置引用链接定义修复早期块', () => {
  it('引用在定义到达前渲染为纯文本，finalize 后被纠正为安全链接', () => {
    const md = createMarkdownIt();
    const renderer = createStreamingRenderer({ md, document });
    const text = F.TRAILING_REFERENCE_DEFINITION;

    // 第一步：只喂入"引用段 + 中间段"，还没有后置定义。
    const refParagraphEnd = text.indexOf('，再看文档。') + '，再看文档。'.length;
    const midText = text.slice(0, refParagraphEnd);
    let blocks = renderer.update(midText, new Set());
    const firstKey = blocks[0].key;
    // 此时第一段应该是 open（唯一块），链接因引用未定义而退化为纯文本，不含 <a>。
    expect(blocks[0].node.querySelector('a')).toBeNull();

    // 第二步：喂入更多正文，让第一段不再是最后一块，从而被缓存为"已完成"。
    const afterMidText = text.slice(0, text.indexOf('确保参考定义块不是最后一块。') + '确保参考定义块不是最后一块。'.length);
    blocks = renderer.update(afterMidText, new Set());
    const firstBlockNow = blocks.find((b) => b.key === firstKey)!;
    expect(firstBlockNow.status).not.toBe('open');
    expect(firstBlockNow.node.querySelector('a')).toBeNull(); // 仍然是未解析的纯文本版本（来自缓存）
    const cachedHtmlBeforeDefinition = firstBlockNow.node.outerHTML;

    // 第三步：喂入完整文本（含后置定义），update() 的"已完成块直接复用缓存"
    // 机制下，第一段应仍然保持缓存里的（未解析）版本，不会自动重新渲染。
    blocks = renderer.update(text, new Set());
    const firstBlockAfterFullText = blocks.find((b) => b.key === firstKey)!;
    expect(firstBlockAfterFullText.node.outerHTML).toBe(cachedHtmlBeforeDefinition);

    // 第四步：finalize() 做完整校正，重新渲染全部块并与缓存比较，
    // 第一段的引用链接此时应该被纠正为指向后置定义地址的安全链接。
    const finalBlocks = renderer.finalize(text, new Set());
    const firstFinal = finalBlocks.find((b) => b.key === firstKey)!;
    expect(firstFinal.status).toBe('corrected');
    const anchor = firstFinal.node.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('https://example.com/resolved-later');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(assertSafeDom(firstFinal.node)).toEqual([]);
  });
});
