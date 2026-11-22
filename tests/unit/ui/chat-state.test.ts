// 对话界面的归约逻辑（src/ui/float/state.ts 核心功能阶段新增部分）：消息列表（C1）、取消引用（D11）、
// 临时切换档位与思考强度（D3、H4）、新对话、发送计划与用量。握手 / 重连 / 订阅 / 转接见 float-state、panel-state。
import { describe, expect, it } from 'vitest';
import type { RequestContextPlan } from '@/core/context/plan';
import type { BackgroundToClient } from '@/core/domain/messages';
import type { MessageRecord } from '@/core/domain/records';
import { displayItems } from '@/ui/float/messages';
import {
  applyJobState,
  applyPlan,
  buildAskMessage,
  createJobView,
  type FloatAction,
  type FloatState,
  floatReducer,
  initialFloatState,
  initialPanelState,
} from '@/ui/float/state';

const server = (msg: BackgroundToClient): FloatAction => ({ kind: 'server', msg });
const run = (s: FloatState, ...actions: FloatAction[]) => actions.reduce(floatReducer, s);

const ready = (panel = false) =>
  run(
    panel ? initialPanelState() : initialFloatState(true),
    server({ type: 'conv/ready', role: panel ? 'sidepanel' : 'float', protocolVersion: 1 }),
  );

const quoteMsg = (selectionRevision: number, text: string): BackgroundToClient => ({
  type: 'conv/quote',
  selectionRevision,
  text,
  truncated: false,
  originalLength: text.length,
});
const accepted = (n: number, conversationId = 'conv-0001'): BackgroundToClient => ({
  type: 'conv/accepted',
  clientRequestId: `req-${n}`,
  jobId: `job-${n}`,
  messageId: `msg-${n}`,
  conversationId,
});
const delta = (n: number, seq: number, text: string): BackgroundToClient => ({
  type: 'conv/delta',
  jobId: `job-${n}`,
  messageId: `msg-${n}`,
  attemptId: 'a1',
  seq,
  text,
});
const done = (n: number): BackgroundToClient => ({
  type: 'conv/jobState',
  jobId: `job-${n}`,
  state: 'completed',
  attemptId: 'a1',
});
const snapshot = (messages: MessageRecord[], isDone = true): BackgroundToClient => ({
  type: 'conv/snapshot',
  messages,
  done: isDone,
  conversationRevision: messages.length,
});
const record = (
  id: string,
  ordinal: number,
  role: 'user' | 'assistant',
  text: string,
  conversationId = 'conv-0001',
): MessageRecord => ({
  id,
  conversationId,
  ordinal,
  role,
  segments: [{ kind: 'text', text }],
  status: 'completed',
  createdAt: 1,
  updatedAt: 1,
});

const PLAN: RequestContextPlan = {
  contextSnapshotId: 'snap-0001',
  model: { connectionId: 'conn-0001', model: 'mock-flash' },
  lengthTier: 'brief',
  contextTier: 'nearby',
  thinking: 'off',
  selectionTruncated: false,
  pageRead: true,
  sentBlockIds: ['b3', 'b4'],
  coverage: { sentChars: 100, extractableChars: 900 },
  droppedHistoryTurns: 0,
  historyHasPageText: false,
  removedEarlierPageText: false,
  imageCount: 0,
  budget: { hardLimit: 32_000, outputReserve: 4096, speedSoftBudget: 16_000, summaryRead: 4800 },
  estimatedInputTokens: 300,
  notes: [],
};

/** 发一问并答完：askSent → accepted → 增量 → completed */
const askAndAnswer = (
  s: FloatState,
  n: number,
  question: string,
  answer: string,
  conversationId = 'conv-0001',
) =>
  run(
    s,
    { kind: 'askSent', clientRequestId: `req-${n}`, text: question, quote: s.quote },
    server(accepted(n, conversationId)),
    server(delta(n, 1, answer)),
    server(done(n)),
  );

/** 列表的可读摘要：u:问题 / a:回答（* 表示正在显示的任务） */
const outline = (s: FloatState) =>
  displayItems(s.messages, s.job).map((i) =>
    i.kind === 'user' ? `u:${i.message.text}` : `a${i.live ? '*' : ''}:${i.view.text}`,
  );

describe('消息列表（C1）', () => {
  it('发问接单后：问题与引用成为一条用户消息，后面跟着正在生成的回答', () => {
    let s = run(ready(), server(quoteMsg(3, '选中的一段')));
    s = run(s, { kind: 'askSent', clientRequestId: 'req-1', text: '这是什么意思', quote: s.quote });
    expect(s.messages).toEqual([]);
    expect(s.pendingAsk).toMatchObject({ text: '这是什么意思', quote: { text: '选中的一段' } });
    s = run(s, server(accepted(1)), server(delta(1, 1, '回答')));
    expect(s.pendingAsk).toBeNull();
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({
      role: 'user',
      text: '这是什么意思',
      conversationId: 'conv-0001',
      pairedMessageId: 'msg-1',
      quote: { text: '选中的一段', originalLength: 5 },
    });
    expect(outline(s)).toEqual(['u:这是什么意思', 'a*:回答']);
  });

  it('同一对话接着问：上一条回答（连同发送计划）留在列表里，新的一轮接在后面', () => {
    let s = askAndAnswer(ready(), 1, '第一问', '回答一');
    s = run(s, server({ type: 'conv/plan', jobId: 'job-1', contextSnapshotId: 'snap-0001', plan: PLAN }));
    s = askAndAnswer(s, 2, '第二问', '回答二');
    expect(outline(s)).toEqual(['u:第一问', 'a:回答一', 'u:第二问', 'a*:回答二']);
    expect(s.messages[1]).toMatchObject({ role: 'assistant', id: 'msg-1', plan: PLAN, state: 'completed' });
    expect(s.conversationId).toBe('conv-0001');
    expect(s.convHint).toBeNull();
  });

  it('想接着问、后台却另开了对话（续接规则 D13）：列表从头开始，并提示「已开启新对话」', () => {
    let s = askAndAnswer(ready(), 1, '第一问', '回答一');
    s = askAndAnswer(s, 2, '第二问', '回答二', 'conv-0002');
    expect(outline(s)).toEqual(['u:第二问', 'a*:回答二']);
    expect(s.conversationId).toBe('conv-0002');
    expect(s.convHint).toBe('newConversation');
    // 在新对话里接着问：提示消失
    s = askAndAnswer(s, 3, '第三问', '回答三', 'conv-0002');
    expect(s.convHint).toBeNull();
    expect(outline(s)).toEqual(['u:第二问', 'a:回答二', 'u:第三问', 'a*:回答三']);
  });

  it('第一次发问不提示新对话', () => {
    expect(askAndAnswer(ready(), 1, '第一问', '回答一').convHint).toBeNull();
  });

  it('发问被拒（回答进行中）：列表不变，暂存的发问丢掉', () => {
    let s = askAndAnswer(ready(), 1, '第一问', '回答一');
    s = run(
      s,
      { kind: 'askSent', clientRequestId: 'req-2', text: '第二问' },
      server({ type: 'conv/rejected', reason: 'busy', refType: 'conv/ask', refId: 'req-2' }),
    );
    expect(s.pendingAsk).toBeNull();
    expect(outline(s)).toEqual(['u:第一问', 'a*:回答一']);
    expect(s.actionError).toContain('回答进行中');
  });

  it('别的界面在同一对话发了问（conv/current）：上一条回答留在列表里；换了对话则从头显示', () => {
    let s = askAndAnswer(ready(), 1, '第一问', '回答一');
    s = run(
      s,
      server({ type: 'conv/current', conversationId: 'conv-0001', jobId: 'job-9', messageId: 'msg-9' }),
    );
    expect(outline(s)).toEqual(['u:第一问', 'a:回答一', 'a*:']);
    s = run(
      s,
      server({ type: 'conv/current', conversationId: 'conv-0002', jobId: 'job-8', messageId: 'msg-8' }),
    );
    expect(outline(s)).toEqual(['a*:']);
    expect(s.conversationId).toBe('conv-0002');
  });

  it('快照（conv/snapshot）：对话已有的消息并进列表；空快照不动已显示的内容', () => {
    let s = askAndAnswer(ready(), 1, '第一问', '回答一');
    const before = s.messages;
    s = run(s, server(snapshot([])));
    expect(s.messages).toBe(before);
    expect(s.snapshotSeq).toBe(1);
    // 持久化接入后：快照带来这段对话的全部消息，本地暂存的发问让位，当前任务原位显示
    s = run(
      s,
      server(
        snapshot([
          record('msg-u0', 0, 'user', '更早的问题'),
          record('msg-a0', 1, 'assistant', '更早的回答'),
          record('msg-u1', 2, 'user', '第一问'),
          record('msg-1', 3, 'assistant', '回答一'),
        ]),
      ),
    );
    expect(outline(s)).toEqual(['u:更早的问题', 'a:更早的回答', 'u:第一问', 'a*:回答一']);
    expect(s.snapshotSeq).toBe(2);
  });

  it('快照分批到达：逐批并入，最后一批才算初始推送完成', () => {
    let s = run(ready(), server({ type: 'conv/subscribed', tabId: 1, conversationId: 'conv-0001' }));
    s = run(s, server(snapshot([record('m0', 0, 'user', '问')], false)));
    expect(s.snapshotSeq).toBe(0);
    expect(outline(s)).toEqual(['u:问']);
    s = run(s, server(snapshot([record('m1', 1, 'assistant', '答')])));
    expect(s.snapshotSeq).toBe(1);
    expect(outline(s)).toEqual(['u:问', 'a:答']);
  });

  it('还没有对话时，快照说是哪个对话就接着哪个对话问；别的对话的快照不收', () => {
    let s = run(ready(), server(snapshot([record('m0', 0, 'user', '问', 'conv-0007')])));
    expect(s.conversationId).toBe('conv-0007');
    expect(buildAskMessage({ ...ASK, conversationId: s.conversationId })).toMatchObject({
      conversationId: 'conv-0007',
    });
    s = run(s, server(snapshot([record('x0', 0, 'user', '别的对话', 'conv-0009')])));
    expect(outline(s)).toEqual(['u:问']);
    expect(s.conversationId).toBe('conv-0007');
  });

  it('小窗断线重连后的订阅：同一对话的列表留着；接上的任务换了，上一条回答归进列表', () => {
    let s = askAndAnswer(ready(), 1, '第一问', '回答一');
    s = run(s, server({ type: 'conv/subscribed', tabId: 1, conversationId: 'conv-0001' }));
    expect(outline(s)).toEqual(['u:第一问', 'a*:回答一']);
    s = run(
      s,
      server({
        type: 'conv/subscribed',
        tabId: 1,
        conversationId: 'conv-0001',
        job: { jobId: 'job-5', messageId: 'msg-5' },
      }),
    );
    expect(outline(s)).toEqual(['u:第一问', 'a:回答一', 'a*:']);
  });

  it('侧边栏换到别的标签页：列表清空；回到同一标签页重订且还是同一对话：列表留着', () => {
    let s = run(ready(true), { kind: 'retarget', tabId: 1 }, server({ type: 'conv/subscribed', tabId: 1 }));
    s = askAndAnswer(s, 1, '第一问', '回答一');
    // 同一标签页重订（地址片段变了等），后台说还是这个对话
    s = run(
      s,
      { kind: 'retarget', tabId: 1 },
      server({
        type: 'conv/subscribed',
        tabId: 1,
        conversationId: 'conv-0001',
        job: { jobId: 'job-1', messageId: 'msg-1' },
      }),
    );
    expect(outline(s)).toEqual(['u:第一问', 'a*:回答一']);
    // 换页了（后台说这个标签页没有对话）
    s = run(s, { kind: 'retarget', tabId: 1 }, server({ type: 'conv/subscribed', tabId: 1 }));
    expect(outline(s)).toEqual([]);
    // 换标签页：立刻清空
    s = askAndAnswer(s, 2, '第二问', '回答二');
    s = run(s, { kind: 'retarget', tabId: 2 });
    expect(s.messages).toEqual([]);
    expect(s.job).toBeNull();
  });
});

const ASK = {
  clientRequestId: 'req-1',
  text: '问',
  quote: null,
  lengthTier: 'normal',
  thinking: 'off',
  model: { connectionId: 'conn-0001', model: 'mock-flash' },
} as const;

describe('取消引用（D11）', () => {
  it('点 × 后引用清空，之后的发问不带 selectionRevision', () => {
    let s = run(ready(), server(quoteMsg(3, '选中的一段')));
    expect(buildAskMessage({ ...ASK, quote: s.quote })).toMatchObject({ selectionRevision: 3 });
    s = run(s, { kind: 'dismissQuote' });
    expect(s.quote).toBeNull();
    expect(buildAskMessage({ ...ASK, quote: s.quote })).not.toHaveProperty('selectionRevision');
  });

  it('重连后后台重推同一次选区：不再显示；新的选区（修订号或文字不同）立即显示', () => {
    let s = run(ready(), server(quoteMsg(3, '选中的一段')), { kind: 'dismissQuote' });
    s = run(s, server(quoteMsg(3, '选中的一段')));
    expect(s.quote).toBeNull();
    // 换页后修订号从头数，可能撞上同一个号：文字不同就是新的选区
    s = run(s, server(quoteMsg(3, '另一段文字')));
    expect(s.quote).toMatchObject({ selectionRevision: 3, text: '另一段文字' });
    s = run(s, { kind: 'dismissQuote' }, server(quoteMsg(4, '另一段文字')));
    expect(s.quote).toMatchObject({ selectionRevision: 4 });
    // 新选区到达后，旧的取消记录作废
    expect(s.dismissedQuote).toBeNull();
  });

  it('没有引用时点 × 是空操作；侧边栏换标签页后取消记录不带过去', () => {
    const s0 = ready(true);
    expect(run(s0, { kind: 'dismissQuote' })).toBe(s0);
    let s = run(s0, { kind: 'retarget', tabId: 1 }, server({ type: 'conv/subscribed', tabId: 1 }));
    s = run(s, server(quoteMsg(1, '甲页的选区')), { kind: 'dismissQuote' });
    s = run(s, { kind: 'retarget', tabId: 2 }, server({ type: 'conv/subscribed', tabId: 2 }));
    s = run(s, server(quoteMsg(1, '甲页的选区')));
    expect(s.quote).toMatchObject({ text: '甲页的选区' });
  });
});

describe('临时切换档位与思考强度（D3、H4）', () => {
  it('切换后记在状态里，同一对话接着问仍然保持', () => {
    let s = run(
      ready(),
      { kind: 'setTier', contextTier: 'fullPage' },
      { kind: 'setThinking', thinking: 'high' },
    );
    expect(s).toMatchObject({ tierOverride: 'fullPage', thinkingOverride: 'high' });
    s = askAndAnswer(s, 1, '第一问', '回答一');
    s = askAndAnswer(s, 2, '第二问', '回答二');
    expect(s).toMatchObject({ tierOverride: 'fullPage', thinkingOverride: 'high' });
    s = run(s, { kind: 'setTier', contextTier: null });
    expect(s.tierOverride).toBeNull();
    expect(s.thinkingOverride).toBe('high');
  });

  it('只影响当前对话：点「新对话」、侧边栏换标签页后回到设置里的默认值', () => {
    let s = run(
      ready(),
      { kind: 'setTier', contextTier: 'selection' },
      { kind: 'setThinking', thinking: 'low' },
    );
    s = run(askAndAnswer(s, 1, '问', '答'), { kind: 'newConversation' });
    expect(s).toMatchObject({ tierOverride: null, thinkingOverride: null });

    let p = run(ready(true), { kind: 'retarget', tabId: 1 }, server({ type: 'conv/subscribed', tabId: 1 }));
    p = run(p, { kind: 'setTier', contextTier: 'fullPage' });
    // 同一标签页重订不动
    p = run(p, { kind: 'retarget', tabId: 1 });
    expect(p.tierOverride).toBe('fullPage');
    p = run(p, { kind: 'retarget', tabId: 2 });
    expect(p.tierOverride).toBeNull();
  });
});

describe('临时切换模型（H4、contract-v1.5 增量）', () => {
  const MODEL_B = { connectionId: 'conn-0002', model: 'mock-pro' } as const;

  it('切换后记在状态里，点「新对话」回到默认；buildAskMessage 带上切换的模型', () => {
    let s = run(ready(), { kind: 'setModel', model: MODEL_B });
    expect(s.modelOverride).toEqual(MODEL_B);
    expect(buildAskMessage({ ...ASK, model: s.modelOverride ?? ASK.model })).toMatchObject({
      model: MODEL_B,
    });
    s = run(askAndAnswer(s, 1, '问', '答'), { kind: 'newConversation' });
    expect(s.modelOverride).toBeNull();
  });

  it('换了标签页（侧边栏）回到默认', () => {
    let p = run(ready(true), { kind: 'retarget', tabId: 1 }, server({ type: 'conv/subscribed', tabId: 1 }));
    p = run(p, { kind: 'setModel', model: MODEL_B });
    expect(p.modelOverride).toEqual(MODEL_B);
    p = run(p, { kind: 'retarget', tabId: 2 });
    expect(p.modelOverride).toBeNull();
  });

  it('modelGone：切换的模型所在连接已不存在，后台拒绝后界面切回默认模型', () => {
    let s = run(ready(), { kind: 'setModel', model: MODEL_B });
    s = run(
      s,
      { kind: 'askSent', clientRequestId: 'req-9', text: '问一下' },
      server({ type: 'conv/rejected', reason: 'modelGone', refType: 'conv/ask', refId: 'req-9' }),
    );
    expect(s.modelOverride).toBeNull();
    expect(s.actionError).toContain('已改回默认模型');
  });
});

describe('新对话', () => {
  it('清空显示，下一次发问不带 conversationId；回答生成中不动', () => {
    let s = askAndAnswer(ready(), 1, '第一问', '回答一');
    s = run(s, { kind: 'newConversation' });
    expect(s).toMatchObject({ conversationId: null, job: null, messages: [], freshConversation: true });
    const fresh = buildAskMessage({ ...ASK, conversationId: s.conversationId, fresh: s.freshConversation });
    expect(fresh).not.toHaveProperty('conversationId');
    // 明确新建：否则后台按续接规则（D13）会接上同页近期的对话
    expect(fresh).toMatchObject({ fresh: true });
    expect(buildAskMessage({ ...ASK, conversationId: 'conv-0001', fresh: true })).not.toHaveProperty('fresh');

    const generating = run(
      ready(),
      { kind: 'askSent', clientRequestId: 'req-1', text: '问' },
      server(accepted(1)),
      server(delta(1, 1, '答到一半')),
    );
    expect(run(generating, { kind: 'newConversation' })).toBe(generating);
  });

  it('点了「新对话」之后重连：订阅补发的旧对话、旧快照不再接回来；发问接单后恢复正常', () => {
    let s = run(askAndAnswer(ready(), 1, '第一问', '回答一'), { kind: 'newConversation' });
    s = run(
      s,
      server({
        type: 'conv/subscribed',
        tabId: 1,
        conversationId: 'conv-0001',
        job: { jobId: 'job-1', messageId: 'msg-1' },
      }),
      server(snapshot([record('m0', 0, 'user', '第一问')])),
    );
    expect(s).toMatchObject({ conversationId: null, job: null, messages: [] });
    s = askAndAnswer(s, 2, '新的问题', '新的回答', 'conv-0002');
    expect(s.freshConversation).toBe(false);
    // 用户自己开的新对话，不提示「已开启新对话」
    expect(s.convHint).toBeNull();
    expect(outline(s)).toEqual(['u:新的问题', 'a*:新的回答']);
  });
});

describe('写库失败', () => {
  it('conv/saveFailed：当前任务的终态没写进库时提示一行，别的任务的不管', () => {
    const s = askAndAnswer(ready(), 1, '问', '答');
    expect(
      run(s, server({ type: 'conv/saveFailed', jobId: 'job-9', messageId: 'msg-9' })).actionError,
    ).toBeNull();
    expect(
      run(s, server({ type: 'conv/saveFailed', jobId: 'job-1', messageId: 'msg-1' })).actionError,
    ).toContain('没能保存到历史');
  });
});

describe('发送计划与用量', () => {
  it('applyPlan：整份计划留在任务视图上（发送说明用），sentBlockIds 照旧', () => {
    const v = applyPlan(createJobView('job-1', 'msg-1'), {
      type: 'conv/plan',
      jobId: 'job-1',
      contextSnapshotId: 'snap-0001',
      plan: PLAN,
    });
    expect(v.plan).toBe(PLAN);
    expect(v.sentBlockIds).toEqual(['b3', 'b4']);
  });

  it('applyJobState：状态消息带了用量就记下，没带就没有', () => {
    const base = createJobView('job-1', 'msg-1');
    const plain = applyJobState(base, {
      type: 'conv/jobState',
      jobId: 'job-1',
      state: 'completed',
      attemptId: 'a1',
    });
    expect(plain.usage).toBeUndefined();
    const withUsage = applyJobState(base, {
      type: 'conv/jobState',
      jobId: 'job-1',
      state: 'completed',
      attemptId: 'a1',
      usage: { inputTokens: 120, outputTokens: 45 },
    } as BackgroundToClient & { type: 'conv/jobState' });
    expect(withUsage.usage).toEqual({ inputTokens: 120, outputTokens: 45 });
  });
});
