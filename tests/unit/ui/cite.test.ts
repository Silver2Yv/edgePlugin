// @vitest-environment happy-dom
// cite 块的界面部分：点回答里的引用交出编号与原文（F1）、结果说明文案（F2 降级提示、F4 回去）、
// 上次总结卡片什么时候显示（6.2：对话空着、或刚点了「总结本页」被复用）、总结时间的写法。
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContextPlan } from '@/core/context/plan';
import type { LastSummary } from '@/core/domain/messages';
import { AnswerView } from '@/ui/AnswerView';
import { summaryCardVisible, summaryTime } from '@/ui/cite/SummaryCard';
import { citeNoteText } from '@/ui/cite/useCite';
import type { MessageView } from '@/ui/float/messages';
import { T } from '@/ui/strings';

const PLAN = {
  contextSnapshotId: 'snap-1',
  model: { connectionId: 'c', model: 'm' },
  lengthTier: 'normal',
  contextTier: 'fullPage',
  thinking: 'off',
  selectionTruncated: false,
  pageRead: true,
  sentBlockIds: ['b2', 'b3'],
  coverage: { sentChars: 100, extractableChars: 300 },
  droppedHistoryTurns: 0,
  historyHasPageText: false,
  removedEarlierPageText: false,
  imageCount: 0,
  budget: { hardLimit: 32000, outputReserve: 4096, speedSoftBudget: 16000, summaryRead: 4800 },
  estimatedInputTokens: 100,
  notes: ['本次读取全文的 33%，约 100 字'],
} as unknown as RequestContextPlan;

describe('AnswerView 的引用点击', () => {
  it('点编号交出第一个编号，点逐字引用交出编号与原文；没发送的编号不可点；覆盖范围写在标题处', async () => {
    const onCitation = vi.fn();
    const root = document.createElement('div');
    document.body.append(root);
    await act(() => {
      render(
        h(AnswerView, {
          view: {
            state: 'completed',
            text: '要点【2,3】。原文【3】红光【/3】。编造【9】。',
            reasoning: '',
            plan: PLAN,
          },
          live: false,
          selectedChars: null,
          canExpand: false,
          onRetry: () => undefined,
          onExpand: () => undefined,
          onCitation,
        }),
        root,
      );
    });
    expect(root.querySelector('[data-testid="coverage-title"]')?.textContent).toBe(
      '本次读取全文的 33%，约 100 字',
    );
    (root.querySelector('sup.ra-citation') as HTMLElement).click();
    (root.querySelector('mark.ra-citation-quote') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(onCitation.mock.calls).toEqual([[{ citation: '2' }], [{ citation: '3', quote: '红光' }]]);
    expect(root.querySelector('[data-ids="9"]')).toBeNull();
    expect(root.textContent).toContain('【9】');
    render(null, root);
  });
});

describe('结果说明', () => {
  it('精确、降级、失败各有说法', () => {
    const base = { requestId: 'r', back: true, pending: false };
    expect(citeNoteText({ ...base, pending: true })).toBe(T.cite.locating);
    expect(citeNoteText({ ...base, level: 'exact' })).toBe(T.cite.exact);
    expect(citeNoteText({ ...base, level: 'fuzzy' })).toBe(T.cite.approx);
    expect(citeNoteText({ ...base, level: 'scroll' })).toBe(T.cite.approx);
    expect(citeNoteText({ ...base, level: 'none', reason: 'otherPage' })).toBe(T.cite.fail.otherPage);
  });
});

const summary = (id = 'm-sum'): LastSummary => ({
  message: {
    id,
    conversationId: 'c1',
    ordinal: 1,
    role: 'assistant',
    segments: [{ kind: 'text', text: '总结【2】' }],
    status: 'completed',
    createdAt: 1,
    updatedAt: 1,
  },
  contentVersion: 'v1-x',
  current: 'same',
});
const emptyView = { target: null, messages: [] as MessageView[], job: null, pendingAsk: null };

describe('summaryCardVisible', () => {
  it('对话空着才显示；刚点「总结本页」被复用（forced）时不论空不空都显示', () => {
    const shown = { tabId: 7, summary: summary() };
    expect(summaryCardVisible(null, false, emptyView)).toBe(false);
    expect(summaryCardVisible(shown, false, emptyView)).toBe(true);
    const busy = {
      ...emptyView,
      messages: [{ id: 'x', role: 'user', text: '问', conversationId: 'c2', ordinal: 0 } as MessageView],
    };
    expect(summaryCardVisible(shown, false, busy)).toBe(false);
    expect(summaryCardVisible(shown, true, busy)).toBe(true);
  });

  it('侧边栏换了标签页不显示旧标签页的；列表里已经有这条总结就不重复', () => {
    const shown = { tabId: 7, summary: summary('m-sum') };
    expect(summaryCardVisible(shown, false, { ...emptyView, target: 8 })).toBe(false);
    expect(summaryCardVisible(shown, false, { ...emptyView, target: 7 })).toBe(true);
    const withIt = {
      ...emptyView,
      messages: [{ id: 'm-sum', role: 'assistant', conversationId: 'c1', ordinal: 1 } as MessageView],
    };
    expect(summaryCardVisible(shown, true, withIt)).toBe(false);
  });
});

describe('summaryTime', () => {
  it('今天只写时分，别的日子写几月几日', () => {
    const now = new Date(2026, 10, 22, 18, 0).getTime();
    expect(summaryTime(new Date(2026, 10, 22, 9, 5).getTime(), now)).toBe('今天 09:05');
    expect(summaryTime(new Date(2026, 10, 20, 14, 30).getTime(), now)).toBe('11月20日 14:30');
  });
});
