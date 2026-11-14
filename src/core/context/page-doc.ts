// 页面模型（5.6）。块到 DOM 的对应只留在阅读器里（弱引用），不随消息传递。
import type { BlockId, ContentVersion, DocumentId, PageKey } from '../domain/ids';

export const BLOCK_KINDS = ['heading', 'paragraph', 'listItem', 'code', 'table', 'quote', 'math'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export interface Block {
  id: BlockId;
  kind: BlockKind;
  /** 仅 heading：1–6 */
  level?: number;
  /** 序列化文本；代码、表格、公式为 Markdown（公式优先取页面自带 LaTeX 源） */
  text: string;
  /** 所属章节标题链，从外到内 */
  headingPath: readonly string[];
  /** 来源框架：0 为顶层；取自上报该块的 sender.frameId */
  frameId: number;
  /** 代码块的语言（若页面给出） */
  lang?: string;
}

/** 判断不出可见性等情况的记录，进「实际发送说明」提示可能不完整 */
export type PageNoteKind = 'visibilityUncertain' | 'fallbackBodyText' | 'tooLittleText' | 'frameSkipped';
export interface PageNote {
  kind: PageNoteKind;
  detail?: string;
}

/**
 * 阅读器上报的页面模型（page/docPart 拼齐后的内容）。不含身份：
 * pageKey、url、documentId、块的 frameId 由后台按 sender 盖章（规则 7）。
 */
export interface PageDocReport {
  contentVersion: ContentVersion;
  title: string;
  lang?: string;
  blocks: readonly BlockReport[];
  notes: readonly PageNote[];
  /** 可提取正文总字数，用于「占可提取正文的比例」 */
  textLength: number;
  extractedAt: number;
}
export type BlockReport = Omit<Block, 'frameId'>;

/** 后台盖章后的页面模型 */
export interface PageDoc extends Omit<PageDocReport, 'blocks'> {
  /** 由 sender.url 规范化得出 */
  pageKey: PageKey;
  /** sender.documentId */
  documentId: DocumentId;
  /** sender.url */
  url: string;
  blocks: readonly Block[];
}

/**
 * 上下文单元（5.6）：「前后各 3 段」的「段」。默认一个段落块；
 * 列表项与表格行归入所属列表 / 表格；代码块整体一个单元；标题不单独计入。
 */
export interface ContextUnit {
  blockIds: readonly BlockId[];
}

/** 选区：哨兵与阅读器上报，后台按 sender 绑定文档 */
export interface SelectionInfo {
  text: string;
  /** 每次选区变化递增；在途请求不被新选区改写 */
  selectionRevision: number;
  /** 选区所在块（阅读器抽取完成后才有） */
  blockIds?: readonly BlockId[];
  /** 是否位于代码块或代码页只读输入框（决定第一个按钮是「解释代码」，A6） */
  inCode: boolean;
}
