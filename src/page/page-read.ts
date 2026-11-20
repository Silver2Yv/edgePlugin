// 阅读器的页面读取（5.6、6.1）：收到后台的 page/read 后在时间片里抽取，算出内容指纹；
// 指纹与后台已知的相同就只回 page/docUnchanged，不同就把 PageDocReport 按 JSON 字节切片（page/docPart）回传。
// 当前选区（哨兵记在小总线里的那一次）补上锚点与所在块（selection/anchored），先于正文发出：
// 同一框架的消息按顺序到达，后台拼好正文时锚点已经在了。
// 不发网络请求；块到 DOM 的对应只留在这里（最近一次抽取），不随消息传递。
import { makeAnchor } from '@/core/anchor/anchor';
import { splitByJsonBytes } from '@/core/domain/bytes';
import { JOB_LIMITS } from '@/core/domain/job';
import type { ContentToBackground } from '@/core/domain/messages';
import { type ExtractResult, extractPage } from './extract';
import { getLastSelectionRevision } from './selection-bus';
import { evaluateSelection } from './selection-policy';

type Send = (msg: ContentToBackground) => Promise<unknown>;
type Anchored = Extract<ContentToBackground, { type: 'selection/anchored' }>;

const MAX_ANCHOR_BLOCKS = 200;

function scrollRatioOf(el: Element): number {
  const h = document.documentElement.scrollHeight || 1;
  return (el.getBoundingClientRect().top + window.scrollY) / h;
}

/** 选区所在块与锚点；选区不在本文档、被选区策略拒绝（表单输入等）或不在任何块里时返回 undefined */
export function anchorSelection(r: ExtractResult, revision: number | undefined): Anchored | undefined {
  if (revision === undefined) return undefined;
  const sel = window.getSelection();
  const decision = evaluateSelection(sel);
  if (!decision.show || sel === null || sel.rangeCount === 0) return undefined;
  const ids: string[] = [];
  if (decision.readonlyInput) {
    for (const [id, el] of r.elements) if (el === decision.readonlyInput) ids.push(id);
  } else {
    const range = sel.getRangeAt(0);
    for (const [id, el] of r.elements) {
      if (range.intersectsNode(el)) ids.push(id);
      if (ids.length >= MAX_ANCHOR_BLOCKS) break;
    }
  }
  const blocks = r.report.blocks.filter((b) => ids.includes(b.id));
  // 锚点建在第一个含选区开头那行文字的块上；找不到就退到第一个块的开头
  const head = decision.text.trim().split('\n')[0]?.trim() ?? '';
  let block = blocks[0];
  let start = 0;
  for (const b of blocks) {
    const i = head ? b.text.indexOf(head) : -1;
    if (i >= 0) {
      block = b;
      start = i;
      break;
    }
  }
  if (!block) return undefined;
  const el = r.elements.get(block.id);
  const anchor = makeAnchor(block, start, start + (head.length || 1), el ? scrollRatioOf(el) : 0);
  return {
    type: 'selection/anchored',
    selectionRevision: revision,
    anchor: { ...anchor, headingPath: [...anchor.headingPath] },
    blockIds: ids,
    contentVersion: r.report.contentVersion,
  };
}

export function createPageReader(send: Send) {
  let running: Promise<ExtractResult> | undefined;

  return {
    async read(readId: string, knownContentVersion: string | undefined): Promise<void> {
      running ??= extractPage(document).finally(() => {
        running = undefined;
      });
      const r = await running;
      const anchored = anchorSelection(r, getLastSelectionRevision());
      if (anchored) await send(anchored);
      const { contentVersion } = r.report;
      if (knownContentVersion === contentVersion) {
        await send({ type: 'page/docUnchanged', readId, contentVersion });
        return;
      }
      const parts = splitByJsonBytes(JSON.stringify(r.report), JOB_LIMITS.maxFieldBytes);
      for (const [index, data] of parts.entries()) {
        await send({ type: 'page/docPart', readId, index, total: parts.length, data });
      }
    },
  };
}
