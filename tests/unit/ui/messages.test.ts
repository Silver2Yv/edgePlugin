// 对话消息的界面模型（src/ui/float/messages.ts）与发送说明（send-summary.ts）的纯逻辑单测：
// 引用编号对齐、消息记录转视图、快照与本地消息合并、显示列表、实际发送说明、当前页信息。
import { describe, expect, it } from 'vitest';
import type { RequestContextPlan } from '@/core/context/plan';
import type { MessageRecord } from '@/core/domain/records';
import {
  archiveJob,
  citationIds,
  citationNumber,
  displayItems,
  groupTurns,
  type JobLike,
  latestPlan,
  localUserMessage,
  type MessageView,
  mergeSnapshot,
  questionForJob,
  recordToView,
  segmentsToText,
} from '@/ui/float/messages';
import { pageInfo, sendSummary } from '@/ui/float/send-summary';

function plan(patch: Partial<RequestContextPlan> = {}): RequestContextPlan {
  return {
    contextSnapshotId: 'snap-0001',
    model: { connectionId: 'conn-0001', model: 'mock-flash' },
    lengthTier: 'normal',
    contextTier: 'nearby',
    thinking: 'off',
    selectionTruncated: false,
    pageRead: true,
    sentBlockIds: ['b3', 'b4', 'b5'],
    coverage: { sentChars: 300, extractableChars: 3214 },
    droppedHistoryTurns: 0,
    historyHasPageText: false,
    removedEarlierPageText: false,
    imageCount: 0,
    budget: { hardLimit: 32_000, outputReserve: 4096, speedSoftBudget: 16_000, summaryRead: 4800 },
    estimatedInputTokens: 581,
    notes: [],
    ...patch,
  };
}

const record = (
  patch: Partial<MessageRecord> & Pick<MessageRecord, 'id' | 'ordinal' | 'role'>,
): MessageRecord => ({
  conversationId: 'conv-0001',
  segments: [{ kind: 'text', text: '' }],
  status: 'completed',
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const job = (patch: Partial<JobLike> = {}): JobLike => ({
  jobId: 'job-0001',
  messageId: 'msg-a1',
  attemptId: 'att-1',
  state: 'completed',
  text: '回答一',
  reasoning: '',
  ...patch,
});

describe('引用编号：发送的块编号 b12 对应回答里的【12】', () => {
  it('去掉前缀 b；已经是数字的照用；形状不对的没有引用编号', () => {
    expect(citationNumber('b12')).toBe('12');
    expect(citationNumber('7')).toBe('7');
    expect(citationNumber('b007')).toBe('7');
    expect(citationNumber('block-3')).toBeNull();
    expect(citationNumber('')).toBeNull();
  });

  it('citationIds：一次请求发送的块 → 允许的引用编号集合', () => {
    expect([...citationIds(['b3', 'b12', 'x'])]).toEqual(['3', '12']);
    expect(citationIds([]).size).toBe(0);
  });
});

describe('消息记录 → 视图', () => {
  it('引用分段还原成渲染管线认的写法；编号对不上的只留原文', () => {
    const ref = (blockId: string) => ({ contextSnapshotId: 's1', contentVersion: 'v1', blockId });
    expect(
      segmentsToText([
        { kind: 'text', text: '结论' },
        { kind: 'citation', ref: ref('b12') },
        { kind: 'text', text: '，原文：' },
        { kind: 'citation', ref: ref('b5'), quote: '逐字摘录' },
        { kind: 'citation', ref: ref('weird'), quote: '只留原文' },
      ]),
    ).toBe('结论【12】，原文：【5】逐字摘录【/5】只留原文');
  });

  it('用户消息带问题与引用；助手消息带状态、思考、计划、用量', () => {
    const user = recordToView(
      record({
        id: 'm0',
        ordinal: 0,
        role: 'user',
        segments: [{ kind: 'text', text: '这是什么意思' }],
        selection: { text: '选中的文字', truncated: false, originalLength: 5 },
      }),
    );
    expect(user).toMatchObject({
      role: 'user',
      text: '这是什么意思',
      ordinal: 0,
      quote: { text: '选中的文字', originalLength: 5 },
    });
    const p = plan();
    const assistant = recordToView(
      record({
        id: 'm1',
        ordinal: 1,
        role: 'assistant',
        segments: [{ kind: 'text', text: '回答' }],
        reasoning: '想了想',
        status: 'failed',
        error: { kind: 'timeout', message: '超时' },
        jobId: 'job-0001',
        plan: p,
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    );
    expect(assistant).toMatchObject({
      role: 'assistant',
      state: 'failed',
      text: '回答',
      reasoning: '想了想',
      jobId: 'job-0001',
      plan: p,
      usage: { inputTokens: 10, outputTokens: 20 },
      error: { kind: 'timeout' },
    });
  });
});

describe('快照与本地消息合并', () => {
  const local = localUserMessage(
    { text: '第一问', quote: { text: '引用', truncated: false, originalLength: 2 } },
    { messageId: 'msg-a1', conversationId: 'conv-0001' },
  );

  it('本地暂存的发问排在最后；快照带来对应的助手消息后让位给快照里的用户消息', () => {
    const before: MessageView[] = [local];
    const merged = mergeSnapshot(before, [
      record({ id: 'msg-u1', ordinal: 0, role: 'user', segments: [{ kind: 'text', text: '第一问' }] }),
      record({ id: 'msg-a1', ordinal: 1, role: 'assistant', segments: [{ kind: 'text', text: '回答一' }] }),
    ]);
    expect(merged.map((m) => m.id)).toEqual(['msg-u1', 'msg-a1']);
  });

  it('分批到达：逐批并入，按序号排；同编号的以后到的为准', () => {
    let list = mergeSnapshot([], [record({ id: 'm1', ordinal: 1, role: 'assistant' })]);
    list = mergeSnapshot(list, [
      record({ id: 'm0', ordinal: 0, role: 'user', segments: [{ kind: 'text', text: '问' }] }),
      record({ id: 'm1', ordinal: 1, role: 'assistant', segments: [{ kind: 'text', text: '新内容' }] }),
    ]);
    expect(list.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(list[1]).toMatchObject({ text: '新内容' });
  });

  it('快照是另一个对话的：旧对话的消息不留', () => {
    const merged = mergeSnapshot(
      [local],
      [record({ id: 'x0', ordinal: 0, role: 'user', conversationId: 'conv-0002' })],
    );
    expect(merged.map((m) => m.id)).toEqual(['x0']);
  });

  it('空的一批不改列表', () => {
    const before: MessageView[] = [local];
    expect(mergeSnapshot(before, [])).toBe(before);
  });

  it('archiveJob：当前任务的回答留进列表；列表里已有这条消息就原地更新、保留序号', () => {
    const appended = archiveJob([local], job({ plan: plan() }), 'conv-0001');
    expect(appended.map((m) => m.id)).toEqual([local.id, 'msg-a1']);
    expect(appended[1]).toMatchObject({
      role: 'assistant',
      text: '回答一',
      jobId: 'job-0001',
      ordinal: null,
    });

    const persisted = mergeSnapshot([], [record({ id: 'msg-a1', ordinal: 3, role: 'assistant' })]);
    const updated = archiveJob(persisted, job({ text: '最终回答' }), 'conv-0001');
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ text: '最终回答', ordinal: 3 });
    expect(archiveJob(persisted, null, 'conv-0001')).toBe(persisted);
  });
});

describe('显示列表', () => {
  const u = (id: string, text: string, quote?: string): MessageView => ({
    id,
    conversationId: 'c',
    ordinal: null,
    role: 'user',
    text,
    ...(quote === undefined
      ? {}
      : { quote: { text: quote, truncated: false, originalLength: quote.length } }),
  });
  const a = (id: string, text: string): MessageView => ({
    id,
    conversationId: 'c',
    ordinal: null,
    role: 'assistant',
    state: 'completed',
    text,
    reasoning: '',
  });

  it('当前任务还不在列表里：接在最后，带上它前面那条发问选中的字数', () => {
    const items = displayItems([u('u1', '问', '六个字的引用')], job());
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect(items[1]).toMatchObject({ kind: 'assistant', id: 'msg-a1', live: true, selectedChars: 6 });
  });

  it('列表里有当前任务的那条消息：原位换成任务视图，不重复', () => {
    const items = displayItems([u('u1', '问'), a('msg-a1', '旧内容')], job({ text: '实时内容' }));
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: 'assistant', live: true, selectedChars: null });
    expect(items[1]?.kind === 'assistant' && items[1].view.text).toBe('实时内容');
  });

  it('历史回答不是 live；没有任务时只有历史', () => {
    const items = displayItems([u('u1', '问'), a('m1', '答')], null);
    expect(items[1]).toMatchObject({ kind: 'assistant', live: false });
  });

  it('同一段引用连续追问：只有第一条用户消息显示引用摘要；换了引用再显示', () => {
    const items = displayItems(
      [
        u('u1', '问一', '同一段'),
        a('m1', '答'),
        u('u2', '问二', '同一段'),
        a('m2', '答'),
        u('u3', '问三', '另一段'),
      ],
      null,
    );
    const shown = items.flatMap((i) => (i.kind === 'user' ? [i.showQuote] : []));
    expect(shown).toEqual([true, false, true]);
  });

  it('groupTurns：每条用户消息开一组；没有用户消息的回答自成一组', () => {
    const items = displayItems(
      [u('u1', '问一'), a('m1', '答一'), a('m2', '后台发起的'), u('u2', '问二')],
      job(),
    );
    expect(groupTurns(items).map((t) => t.length)).toEqual([2, 1, 2]);
    expect(groupTurns([])).toEqual([]);
  });

  it('latestPlan：先看当前任务，再从后往前找带计划的回答', () => {
    const p1 = plan({ contextTier: 'nearby' });
    const p2 = plan({ contextTier: 'fullPage' });
    const withPlan: MessageView = { ...(a('m1', '答') as MessageView & { role: 'assistant' }), plan: p1 };
    expect(latestPlan([withPlan], null)).toBe(p1);
    expect(latestPlan([withPlan], job({ plan: p2 }))).toBe(p2);
    expect(latestPlan([withPlan], job())).toBe(p1);
    expect(latestPlan([], null)).toBeUndefined();
  });
});

describe('实际发送说明（B8）', () => {
  it('带上下文：选中多少字 · 带了几段 · 全文共多少字 · 计划里的说明原样显示', () => {
    const s = sendSummary(plan({ notes: ['命中 2 处提及'] }), 86);
    expect(s.parts).toEqual(['选中 86 字', '带上下文 3 段', '全文共 3,214 字', '命中 2 处提及']);
    expect(s.details).toContain('估算输入约 581 token');
    expect(s.details).toContain('模型 mock-flash');
  });

  it('带全文：发完了写「带全文」，没发完写明发了多少字、已截断', () => {
    const full = plan({ contextTier: 'fullPage', coverage: { sentChars: 3214, extractableChars: 3214 } });
    expect(sendSummary(full, 10).parts).toEqual(['选中 10 字', '带全文', '全文共 3,214 字']);
    const cut = plan({
      contextTier: 'fullPage',
      coverage: { sentChars: 1200, extractableChars: 30_000 },
      notes: ['全文超出预算，以选区为中心发送了 9/80 块'],
    });
    expect(sendSummary(cut, 10).parts).toEqual([
      '选中 10 字',
      '带全文的一部分（1,200 字，已截断）',
      '全文共 30,000 字',
      '全文超出预算，以选区为中心发送了 9/80 块',
    ]);
  });

  it('「不读取页面内容」的站点：只显示选中字数与「未读取页面」，原因在明细里（4.1）', () => {
    const p = plan({
      contextTier: 'selection',
      pageRead: false,
      sentBlockIds: [],
      coverage: { sentChars: 42, extractableChars: 0 },
      notes: ['此站点设置为不读取页面内容，只发送了选中文字'],
    });
    const s = sendSummary(p, null);
    expect(s.parts).toEqual(['选中 42 字', '未读取页面']);
    expect(s.details).toContain('此站点设置为不读取页面内容，只发送了选中文字');
  });

  it('用户自己选了「只看选中」：写「只发送了选中的文字」；没有选区的自由提问：写「没有带页面内容」', () => {
    const sel = plan({
      contextTier: 'selection',
      pageRead: false,
      sentBlockIds: [],
      coverage: { sentChars: 42, extractableChars: 0 },
    });
    expect(sendSummary(sel, 42).parts).toEqual(['选中 42 字', '只发送了选中的文字']);
    const free = plan({
      contextTier: 'selection',
      pageRead: false,
      sentBlockIds: [],
      coverage: { sentChars: 0, extractableChars: 0 },
    });
    expect(sendSummary(free, null).parts).toEqual(['没有带页面内容']);
  });

  it('选区过长被截断、历史被丢弃、历史里仍有原文、移除了先前的全文：都写明', () => {
    const p = plan({
      selectionTruncated: true,
      droppedHistoryTurns: 2,
      historyHasPageText: true,
      removedEarlierPageText: true,
    });
    const s = sendSummary(p, 20_000);
    expect(s.parts[0]).toBe('选中 20,000 字（选区过长已截断）');
    expect(s.details).toEqual(
      expect.arrayContaining([
        '较早的 2 轮对话超出预算，没有发送',
        '历史中仍包含之前发送的原文',
        '已移除先前发送的页面全文',
      ]),
    );
  });
});

describe('侧边栏当前页信息（C3）', () => {
  it('没有计划：没有信息', () => {
    expect(pageInfo(undefined)).toBeNull();
  });

  it('带上下文的请求：给出可读取的字数，说不上截断', () => {
    expect(pageInfo(plan())).toEqual({ readableChars: 3214, truncated: null, notRead: false });
  });

  it('带全文的请求：给出有没有截断', () => {
    const cut = plan({ contextTier: 'fullPage', coverage: { sentChars: 100, extractableChars: 3214 } });
    expect(pageInfo(cut)).toMatchObject({ readableChars: 3214, truncated: true });
    const full = plan({ contextTier: 'fullPage', coverage: { sentChars: 3214, extractableChars: 3214 } });
    expect(pageInfo(full)).toMatchObject({ truncated: false });
  });

  it('想带页面却没带上（站点不读取等）：标「未读取」', () => {
    const p = plan({ pageRead: false, notes: ['未读取页面正文，只发送了选中文字'] });
    expect(pageInfo(p)).toEqual({ readableChars: null, truncated: null, notRead: true });
    expect(pageInfo(plan({ pageRead: false }))).toMatchObject({ notRead: false });
  });
});

describe('换个模型再试要重问的内容（H12）', () => {
  it('直接发送的动作：带上原来的动作与档位，不会变成一句普通提问', () => {
    const user = recordToView(
      record({
        id: 'm0',
        ordinal: 0,
        role: 'user',
        segments: [{ kind: 'text', text: '总结本页' }],
        request: { actionId: 'summarizePage', contextTier: 'fullPage', lengthTier: 'brief', thinking: 'off' },
      }),
    );
    const failed = recordToView(record({ id: 'm1', ordinal: 1, role: 'assistant', status: 'failed' }));
    expect(questionForJob([user, failed], 'm1')).toEqual({
      text: '总结本页',
      quote: null,
      request: { actionId: 'summarizePage', contextTier: 'fullPage' },
    });
  });

  it('界面自己发的普通提问：本地暂存的消息没有动作，按「问」处理', () => {
    const local = localUserMessage(
      { text: '这是什么', quote: null },
      { messageId: 'm1', conversationId: 'conv-0001' },
    );
    expect(questionForJob([local], 'm1')).toEqual({ text: '这是什么', quote: null });
  });
});
