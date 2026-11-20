// 回答渲染模块的公开入口（5.10）。FloatApp.tsx 只从这里导入，不直接碰内部文件。
// innerHTML 只允许出现在本目录里（markdown-it html:false 的渲染输出）；
// 其余 ui 代码一律只用文本节点，见 CLAUDE.md 与 ARCHITECTURE 5.10。
import './styles.css';

export type { CitationMatch } from './citation';
export { applyCitations, findCitationMatches } from './citation';
export { addCopyButtons } from './code-copy';
export { CODE_HIGHLIGHT_MAX_CHARS, highlightCode, isLanguageAllowed } from './highlight';
export { KATEX_MAX_EXPAND, KATEX_MAX_SIZE, renderMath } from './katex-render';
export { createMarkdownIt } from './markdown-it-setup';
export type { AnswerRenderer, AnswerRendererOptions } from './mount';
export { createAnswerRenderer } from './mount';
export { extractScheme, isAllowedLinkProtocol } from './protocol';
export { createUpdateScheduler, LONG_TEXT_THRESHOLD, MIN_INTERVAL_MS } from './scheduler';
export type { SelectionGuard, SelectionGuardOptions } from './selection-guard';
export { createSelectionGuard, selectionIntersectsNode } from './selection-guard';
export type { BlockStatus, RenderedBlock, StreamingRenderer } from './streaming-renderer';
export { createStreamingRenderer, MAX_BLOCK_LENGTH, MAX_TOTAL_LENGTH } from './streaming-renderer';
