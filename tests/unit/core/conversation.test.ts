// 对话的纯逻辑（core/domain/conversation.ts）：续接规则边界（D13）、标题、从库里的消息重建历史、订阅快照分批。
import { describe, expect, it } from 'vitest';
import {
  CONTINUE_LIMITS,
  continuation,
  conversationTitle,
  snapshotBatches,
  turnsFromMessages,
} from '@/core/domain/conversation';
import { messageBytes } from '@/core/domain/messages';
import type { ConversationRecord, MessageRecord } from '@/core/domain/records';

const conv = (extra: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id: 'c-00000001',
  pageKey: 'https://a.test/x',
  title: '标题',
  model: { connectionId: 'conn-0001', model: 'm' },
  turns: 1,
  revision: 3,
  createdAt: 0,
  updatedAt: 1000,
  lastAskedAt: 1000,
  ...extra,
});

const msg = (ordinal: number, extra: Partial<MessageRecord> = {}): MessageRecord => ({
  id: `m-${String(ordinal).padStart(8, '0')}`,
  conversationId: 'c-00000001',
  ordinal,
  role: ordinal % 2 === 0 ? 'user' : 'assistant',
  segments: [{ kind: 'text', text: `内容${ordinal}` }],
  status: 'completed',
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe('续接规则（D13）', () => {
  const MIN = 60_000;
  it('距上次提问正好 30 分钟仍续接，多 1 毫秒就新建（idle）', () => {
    expect(continuation(conv(), 1000 + 30 * MIN)).toEqual({ ok: true });
    expect(continuation(conv(), 1000 + 30 * MIN + 1)).toEqual({ ok: false, reason: 'idle' });
    expect(CONTINUE_LIMITS).toEqual({ idleMs: 30 * MIN, maxTurns: 20 });
  });

  it('19 轮还能续接，满 20 轮新建（turnLimit），轮数优先于时间', () => {
    expect(continuation(conv({ turns: 19 }), 1000)).toEqual({ ok: true });
    expect(continuation(conv({ turns: 20 }), 1000)).toEqual({ ok: false, reason: 'turnLimit' });
    expect(continuation(conv({ turns: 25 }), 1000 + 60 * MIN)).toEqual({ ok: false, reason: 'turnLimit' });
  });

  it('没有 lastAskedAt 的旧记录按 updatedAt 算', () => {
    const { lastAskedAt: _x, ...old } = conv();
    expect(continuation(old, 1000 + 30 * MIN + 1)).toEqual({ ok: false, reason: 'idle' });
  });
});

describe('对话标题', () => {
  it('取问题，空问题取选中文字；单行、限 60 字', () => {
    expect(conversationTitle('  这段\n讲了什么？ ')).toBe('这段 讲了什么？');
    expect(conversationTitle('', '选中的文字')).toBe('选中的文字');
    const long = conversationTitle('字'.repeat(100));
    expect([...long]).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('从库里的消息重建历史', () => {
  it('只收完成的轮次；用户消息取实际发送全文，没有时退回问题；序号接着最大的', () => {
    const messages = [
      msg(0, {
        sentText: '<selected_text>\n选区\n</selected_text>\n\n问一',
        selection: { text: '选区', truncated: false, originalLength: 2 },
      }),
      msg(1, { segments: [{ kind: 'text', text: '答一' }] }),
      msg(2),
      msg(3, { status: 'failed' }),
      msg(4, { sentText: '问三' }),
      msg(5, { status: 'interrupted' }),
    ];
    const r = turnsFromMessages(messages);
    expect(r.turns).toEqual([
      { user: '<selected_text>\n选区\n</selected_text>\n\n问一', assistant: '答一', hasPageText: true },
    ]);
    expect(r.nextOrdinal).toBe(6);
    expect(r.lastFullPage).toBe(false);
  });

  it('最后一条带计划的回答发送了全文：lastFullPage', () => {
    const plan = { pageRead: true, contextTier: 'fullPage' } as NonNullable<MessageRecord['plan']>;
    const r = turnsFromMessages([msg(0, { sentText: '问' }), msg(1, { plan })]);
    expect(r.lastFullPage).toBe(true);
    expect(r.turns[0]?.hasPageText).toBe(true);
  });
});

describe('订阅快照分批', () => {
  it('没有对话：一批空的，done', () => {
    expect(snapshotBatches(undefined, [])).toEqual([
      { type: 'conv/snapshot', messages: [], done: true, conversationRevision: 0 },
    ]);
  });

  it('多条消息超过 64 KB：按 ordinal 升序分批，每批不超限，对话只在第一批，最后一批 done；sentText 不发给界面', () => {
    const big = '长'.repeat(5000); // 约 15 KB
    const messages = Array.from({ length: 12 }, (_, i) =>
      msg(i, { segments: [{ kind: 'text', text: big }], sentText: '内部' }),
    );
    const batches = snapshotBatches(conv(), messages);
    expect(batches.length).toBeGreaterThan(2);
    for (const b of batches) expect(messageBytes(b)).toBeLessThanOrEqual(64 * 1024);
    expect(batches.map((b) => b.done)).toEqual([...batches.slice(1).map(() => false), true]);
    expect(batches[0]?.conversation?.id).toBe('c-00000001');
    expect(batches.slice(1).every((b) => b.conversation === undefined)).toBe(true);
    expect(batches.every((b) => b.conversationRevision === 3)).toBe(true);
    const all = batches.flatMap((b) => b.messages);
    expect(all.map((m) => m.ordinal)).toEqual(messages.map((m) => m.ordinal));
    expect(all.some((m) => 'sentText' in m)).toBe(false);
  });

  it('一条消息自己就超限：切成同 id 的几片，拼起来与原文一致；选中文字放不下只给预览', () => {
    const answer = 'a"\\字'.repeat(40_000); // JSON 编码后远超 64 KB
    const reasoning = '想'.repeat(30_000);
    const huge = msg(1, { segments: [{ kind: 'text', text: answer }], reasoning });
    const user = msg(0, {
      segments: [{ kind: 'text', text: '问'.repeat(16_000) }],
      selection: { text: '选'.repeat(16_000), truncated: false, originalLength: 16_000 },
    });
    const batches = snapshotBatches(conv(), [user, huge]);
    for (const b of batches) expect(messageBytes(b)).toBeLessThanOrEqual(64 * 1024);
    const all = batches.flatMap((b) => b.messages);
    const parts = all.filter((m) => m.id === huge.id);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map((m) => m.segments.map((s) => (s.kind === 'text' ? s.text : '')).join('')).join('')).toBe(
      answer,
    );
    expect(parts.map((m) => m.reasoning ?? '').join('')).toBe(reasoning);
    const u = all.filter((m) => m.id === user.id);
    expect(u.map((m) => m.segments.map((s) => (s.kind === 'text' ? s.text : '')).join('')).join('')).toBe(
      '问'.repeat(16_000),
    );
    expect(u[0]?.selection).toMatchObject({ truncated: true, originalLength: 16_000 });
    expect([...(u[0]?.selection?.text ?? '')]).toHaveLength(2000);
    // 片按顺序紧挨着
    const ids = all.map((m) => m.id);
    expect(ids.indexOf(huge.id)).toBe(ids.lastIndexOf(user.id) + 1);
  });
});
