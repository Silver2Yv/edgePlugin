/**
 * 按块增量渲染（5.10 流式规则）。
 *
 * 核心设计：
 * - 每次 update() 对“已收到的全部文本”做一次完整的 markdown-it 块级解析
 *   （块级解析是线性扫描，成本可控），切出顶层块分组。
 * - 除最后一块外，其余块一旦在某次调用里“已有后继块出现”就视为
 *   finalized：若其 key（起始字符偏移）在缓存中且内容未变，直接复用缓存
 *   的渲染结果（不重新跑 KaTeX/highlight.js/引用替换），这是“稳定块不被
 *   无故替换”与增量性能的来源。
 * - 最后一块永远视为 open（可能还在继续生长，例如未闭合代码围栏/公式），
 *   每次都重新渲染，不缓存。
 * - finalize() 在流结束时对全部块重新渲染一次并逐块比较 HTML 是否变化，
 *   只替换真正变化的块（典型触发源：后置的 Markdown 引用链接定义，
 *   因为同一个 md.parse() 调用里引用定义在全文解析阶段已经收集完毕，
 *   所以“结束时完整校正”天然能捞回所有受前向引用影响的块，不需要为
 *   引用定义单独写检测逻辑）。
 *
 * 调用方（src/ui/render/mount.ts）负责把 update()/finalize() 返回的块节点
 * 增量挂载进真实 DOM，并在挂载前做用户选区保护；本模块只产出渲染结果，
 * 不碰调用方的容器 DOM。
 *
 * 移植自 prototypes/v10-render/src/render/streaming-renderer.ts（V-10 原型已验证）。
 */
import type { MarkdownIt as MarkdownItInstance, Token } from 'markdown-it';
import { type BlockGroup, normalizeForMarkdownIt, splitTopLevelBlocks } from './block-splitter';
import { applyCitations } from './citation';
import { addCopyButtons } from './code-copy';
import { escapeHtml } from './highlight';

export const MAX_TOTAL_LENGTH = 300_000;
export const MAX_BLOCK_LENGTH = 50_000;

export type BlockStatus = 'open' | 'unchanged' | 'rendered' | 'corrected';

export interface RenderedBlock {
  key: number;
  node: Element;
  status: BlockStatus;
  truncated?: boolean;
}

interface CacheEntry {
  rawHtml: string;
  node: Element;
  truncated: boolean;
}

export interface StreamingRendererOptions {
  md: MarkdownItInstance;
  document: Document;
}

export interface StreamingRenderer {
  update(fullText: string, allowedIds: ReadonlySet<string>): RenderedBlock[];
  finalize(fullText: string, allowedIds: ReadonlySet<string>): RenderedBlock[];
  reset(): void;
  wasTruncated(): boolean;
}

function renderGroup(
  group: BlockGroup,
  tokens: Token[],
  workingText: string,
  allowedIds: ReadonlySet<string>,
  md: MarkdownItInstance,
  doc: Document,
): CacheEntry {
  const blockLength = group.charEnd - group.charStart;
  const container = doc.createElement('div');
  container.setAttribute('class', 'ra-block');
  container.setAttribute('data-key', String(group.key));

  if (blockLength > MAX_BLOCK_LENGTH) {
    const preview = workingText.slice(group.charStart, group.charStart + MAX_BLOCK_LENGTH);
    const rawHtml = `<p class="ra-truncated-block">${escapeHtml(preview)}…</p><p class="ra-truncated-notice" data-truncated="true">（该块内容超长，已截断显示）</p>`;
    container.innerHTML = rawHtml;
    return { rawHtml, node: container, truncated: true };
  }

  const tokensSlice = tokens.slice(group.tokenStart, group.tokenEnd + 1);
  const rawHtml = md.renderer.render(tokensSlice, md.options, {});
  container.innerHTML = rawHtml;
  applyCitations(container, allowedIds, doc);
  addCopyButtons(container, doc);
  return { rawHtml, node: container, truncated: false };
}

export function createStreamingRenderer(options: StreamingRendererOptions): StreamingRenderer {
  const { md, document: doc } = options;
  let cache = new Map<number, CacheEntry>();
  let truncatedTotal = false;

  function prepareWorkingText(fullText: string): string {
    const normalized = normalizeForMarkdownIt(fullText);
    if (normalized.length > MAX_TOTAL_LENGTH) {
      truncatedTotal = true;
      return normalized.slice(0, MAX_TOTAL_LENGTH);
    }
    return normalized;
  }

  function update(fullText: string, allowedIds: ReadonlySet<string>): RenderedBlock[] {
    const workingText = prepareWorkingText(fullText);
    const { tokens, groups } = splitTopLevelBlocks(md, workingText);
    const results: RenderedBlock[] = [];
    if (groups.length === 0) return results;

    const lastIdx = groups.length - 1;
    const seenKeys = new Set<number>();

    for (let i = 0; i < lastIdx; i++) {
      const group = groups[i];
      if (!group) continue;
      seenKeys.add(group.key);
      const cached = cache.get(group.key);
      if (cached) {
        results.push({ key: group.key, node: cached.node, status: 'unchanged', truncated: cached.truncated });
        continue;
      }
      const entry = renderGroup(group, tokens, workingText, allowedIds, md, doc);
      cache.set(group.key, entry);
      results.push({ key: group.key, node: entry.node, status: 'rendered', truncated: entry.truncated });
    }

    const openGroup = groups[lastIdx];
    if (!openGroup) return results;
    seenKeys.add(openGroup.key);
    const openEntry = renderGroup(openGroup, tokens, workingText, allowedIds, md, doc);
    results.push({
      key: openGroup.key,
      node: openEntry.node,
      status: 'open',
      truncated: openEntry.truncated,
    });

    for (const key of [...cache.keys()]) {
      if (!seenKeys.has(key)) cache.delete(key);
    }
    return results;
  }

  function finalize(fullText: string, allowedIds: ReadonlySet<string>): RenderedBlock[] {
    const workingText = prepareWorkingText(fullText);
    const { tokens, groups } = splitTopLevelBlocks(md, workingText);
    const results: RenderedBlock[] = [];
    const seenKeys = new Set<number>();

    for (const group of groups) {
      seenKeys.add(group.key);
      const fresh = renderGroup(group, tokens, workingText, allowedIds, md, doc);
      const cached = cache.get(group.key);
      if (cached && cached.rawHtml === fresh.rawHtml) {
        results.push({ key: group.key, node: cached.node, status: 'unchanged', truncated: cached.truncated });
        continue;
      }
      cache.set(group.key, fresh);
      results.push({
        key: group.key,
        node: fresh.node,
        status: cached ? 'corrected' : 'rendered',
        truncated: fresh.truncated,
      });
    }

    for (const key of [...cache.keys()]) {
      if (!seenKeys.has(key)) cache.delete(key);
    }
    return results;
  }

  function reset(): void {
    cache = new Map();
    truncatedTotal = false;
  }

  function wasTruncated(): boolean {
    return truncatedTotal;
  }

  return { update, finalize, reset, wasTruncated };
}
