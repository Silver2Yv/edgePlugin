// 侧边栏与转接的界面纯逻辑（src/ui/float/state.ts 新增部分）：换订阅时丢弃旧标签页的推送、
// 两个界面跟随同一个任务、转接进度、开关快捷键的判断。
import { describe, expect, it } from 'vitest';
import type { BackgroundToClient } from '@/core/domain/messages';
import {
  buildAskMessage,
  type FloatAction,
  type FloatState,
  favoriteAddMessage,
  floatReducer,
  initialFloatState,
  initialPanelState,
  panelSubscribeMessage,
  shouldCloseOnToggle,
  switchConversationMessage,
} from '@/ui/float/state';

const server = (msg: BackgroundToClient): FloatAction => ({ kind: 'server', msg });
const run = (s: FloatState, ...actions: FloatAction[]) => actions.reduce(floatReducer, s);

const delta = (jobId: string, seq: number, text: string): BackgroundToClient => ({
  type: 'conv/delta',
  jobId,
  messageId: `m-${jobId}`,
  attemptId: 'a1',
  seq,
  text,
});
const quote = (text: string): BackgroundToClient => ({
  type: 'conv/quote',
  selectionRevision: 1,
  text,
  truncated: false,
  originalLength: text.length,
});
const subscribed = (tabId: number, jobId?: string, conversationId?: string): BackgroundToClient => ({
  type: 'conv/subscribed',
  tabId,
  ...(conversationId ? { conversationId } : {}),
  ...(jobId ? { job: { jobId, messageId: `m-${jobId}` } } : {}),
});

const readyPanel = () =>
  run(initialPanelState(), server({ type: 'conv/ready', role: 'sidepanel', protocolVersion: 1 }));

describe('侧边栏换订阅', () => {
  it('新标签页的 conv/subscribed 到达之前，旧标签页的推送一律丢弃', () => {
    let s = run(readyPanel(), { kind: 'retarget', tabId: 1 }, server(subscribed(1, 'j1', 'c1')));
    s = run(s, server(delta('j1', 1, '甲')));
    expect(s.job?.text).toBe('甲');
    s = run(
      s,
      { kind: 'retarget', tabId: 2 },
      server(delta('j1', 2, '乙')),
      server(quote('旧标签页的引用')),
      server(subscribed(1, 'j1', 'c1')),
    );
    expect(s.job).toBeNull();
    expect(s.quote).toBeNull();
    expect(s.targetConfirmed).toBe(false);
    s = run(s, server(subscribed(2, 'j2', 'c2')), server(quote('新引用')), server(delta('j2', 1, '丙')));
    expect(s.targetConfirmed).toBe(true);
    expect(s.conversationId).toBe('c2');
    expect(s.quote?.text).toBe('新引用');
    expect(s.job).toMatchObject({ jobId: 'j2', text: '丙' });
  });

  it('同一标签页重订（地址变化、接手转接）：同一个任务保留视图，补发的增量按 seq 去重；没带任务就清空', () => {
    let s = run(
      readyPanel(),
      { kind: 'retarget', tabId: 1 },
      server(subscribed(1, 'j1', 'c1')),
      server(delta('j1', 1, '甲')),
      server(delta('j1', 2, '乙')),
    );
    s = run(
      s,
      { kind: 'retarget', tabId: 1 },
      server(delta('j1', 3, '被丢弃')),
      server(subscribed(1, 'j1', 'c1')),
      server(delta('j1', 1, '甲')),
      server(delta('j1', 2, '乙')),
      server(delta('j1', 3, '丙')),
    );
    expect(s.job?.text).toBe('甲乙丙');
    s = run(s, { kind: 'retarget', tabId: 1 }, server(subscribed(1)));
    expect(s.job).toBeNull();
    expect(s.conversationId).toBeNull();
  });

  it('断线重连后重订（没换标签页）：后台已没有这段对话时保留已显示的回答', () => {
    let s = run(
      readyPanel(),
      { kind: 'retarget', tabId: 1 },
      server(subscribed(1, 'j1', 'c1')),
      server(delta('j1', 1, '甲')),
      { kind: 'disconnected' },
      { kind: 'wake' },
      server({ type: 'conv/ready', role: 'sidepanel', protocolVersion: 1 }),
      server(subscribed(1)),
    );
    expect(s.job?.text).toBe('甲');
    expect(s.conversationId).toBe('c1');
    // 之后同一标签页换了地址（重订）：以那次订阅为准
    s = run(s, { kind: 'retarget', tabId: 1 }, server(subscribed(1)));
    expect(s.job).toBeNull();
  });

  it('换订阅时 conv/ready、被拒、待接转接照收', () => {
    const s = run(
      readyPanel(),
      { kind: 'retarget', tabId: 1 },
      server({ type: 'handoff/pending', handoffId: 'h1', tabId: 1, conversationId: 'c1' }),
      server({ type: 'conv/rejected', reason: 'notOwner', refType: 'conv/subscribe' }),
    );
    expect(s.incomingHandoff).toEqual({ handoffId: 'h1', tabId: 1, conversationId: 'c1' });
    expect(s.actionError).toContain('没能显示这个标签页');
    expect(s.targetConfirmed).toBe(true);
  });

  it('订阅消息：指定标签页；接手转接时带上对话与编号，不带 resume', () => {
    let s = run(readyPanel(), { kind: 'retarget', tabId: 3 });
    expect(panelSubscribeMessage(s)).toEqual({ type: 'conv/subscribe', tabId: 3 });
    s = run(s, { kind: 'retarget', tabId: 3, handoff: { handoffId: 'h1', tabId: 3, conversationId: 'c1' } });
    expect(panelSubscribeMessage(s)).toEqual({
      type: 'conv/subscribe',
      tabId: 3,
      conversationId: 'c1',
      handoffId: 'h1',
    });
    expect(panelSubscribeMessage(initialPanelState())).toBeNull();
  });

  it('续问带上正在显示的对话；还没有对话（第一次发问、点了「新对话」）时不带', () => {
    const base = {
      clientRequestId: 'req-00000001',
      text: '再说说',
      quote: null,
      lengthTier: 'normal',
      thinking: 'off',
      model: { connectionId: 'conn-1', model: 'm' },
    } as const;
    expect(buildAskMessage({ ...base, conversationId: 'c1' })).toMatchObject({ conversationId: 'c1' });
    expect(buildAskMessage(base)).not.toHaveProperty('conversationId');
    expect(buildAskMessage({ ...base, conversationId: null })).not.toHaveProperty('conversationId');
  });
});

describe('两个界面跟随同一个任务（conv/current）', () => {
  it('别的界面发起了新任务：换过去，从 0 续播；同一个任务只更新对话编号', () => {
    let s = run(initialFloatState(true), server(subscribed(1, 'j1', 'c1')));
    s = run(s, server({ type: 'conv/current', conversationId: 'c1', jobId: 'j1', messageId: 'm-j1' }));
    expect(s.job?.jobId).toBe('j1');
    s = run(s, server({ type: 'conv/current', conversationId: 'c2', jobId: 'j2', messageId: 'm-j2' }));
    expect(s.job).toMatchObject({ jobId: 'j2', lastSeq: 0, text: '' });
    expect(s.conversationId).toBe('c2');
  });

  it('自己刚发的问还没接单：不被别的任务换掉', () => {
    const s = run(
      initialFloatState(true),
      { kind: 'askSent', clientRequestId: 'req-mine' },
      server({ type: 'conv/current', conversationId: 'c2', jobId: 'j2', messageId: 'm-j2' }),
    );
    expect(s.job).toBeNull();
  });

  it('小窗：conv/subscribed 没带任务时保留上一次的回答（后台重启后内存里没有对话）', () => {
    let s = run(initialFloatState(true), server(subscribed(1, 'j1', 'c1')), server(delta('j1', 1, '甲')));
    s = run(s, server(subscribed(1)));
    expect(s.job?.text).toBe('甲');
    expect(s.conversationId).toBe('c1');
  });

  it('conv/accepted 记下对话编号', () => {
    const s = run(
      initialFloatState(true),
      { kind: 'askSent', clientRequestId: 'req-mine' },
      server({
        type: 'conv/accepted',
        clientRequestId: 'req-mine',
        jobId: 'j1',
        messageId: 'm1',
        conversationId: 'c9',
      }),
    );
    expect(s.conversationId).toBe('c9');
  });
});

describe('转接（小窗这边）', () => {
  it('只认自己这次转接的 done；迟迟没接上标记为 slow', () => {
    let s = run(initialFloatState(true), { kind: 'handoffStarted' });
    expect(s.handoff).toEqual({ handoffId: null, sent: false, slow: false, done: false });
    s = run(s, { kind: 'handoffSent' }, server({ type: 'handoff/done', handoffId: 'h-other' }));
    expect(s.handoff).toEqual({ handoffId: null, sent: true, slow: false, done: false });
    s = run(s, server({ type: 'handoff/created', handoffId: 'h1' }), { kind: 'handoffSlow' });
    expect(s.handoff).toEqual({ handoffId: 'h1', sent: true, slow: true, done: false });
    s = run(s, server({ type: 'handoff/done', handoffId: 'h1' }));
    expect(s.handoff?.done).toBe(true);
    s = run(s, { kind: 'handoffSlow' });
    expect(s.handoff?.slow).toBe(true);
    expect(run(s, { kind: 'handoffClear' }).handoff).toBeNull();
  });

  it('没发起转接时收到的 created / done 不理会；转接被拒给一行提示', () => {
    let s = run(initialFloatState(true), server({ type: 'handoff/created', handoffId: 'h1' }));
    expect(s.handoff).toBeNull();
    s = run(
      s,
      { kind: 'handoffStarted' },
      server({ type: 'conv/rejected', reason: 'notOwner', refType: 'handoff/start' }),
    );
    expect(s.handoff).toBeNull();
    expect(s.actionError).toContain('没能转到侧边栏');
  });

  it('小窗握手被拒（令牌无效）：不再停在「连接中」', () => {
    const s = run(
      initialFloatState(true),
      server({ type: 'conv/rejected', reason: 'badToken', refType: 'conv/helloFloat' }),
    );
    expect(s.connPhase).toBe('expired');
  });
});

describe('开关快捷键（5.4）', () => {
  it('命令晚于面板创建：关；面板是这次命令打开的（创建晚于命令）：不关', () => {
    expect(shouldCloseOnToggle(1000, 2000)).toBe(true);
    expect(shouldCloseOnToggle(2000, 1000)).toBe(false);
    expect(shouldCloseOnToggle(1000, 1000)).toBe(false);
  });
});

describe('侧边栏顶部说明', () => {
  it('收到 conv/notice 记下；换了标签页清掉', () => {
    let s = run(
      readyPanel(),
      { kind: 'retarget', tabId: 1 },
      server(subscribed(1)),
      server({ type: 'conv/notice', kind: 'floatTransient' }),
    );
    expect(s.notice).toBe('floatTransient');
    s = run(s, { kind: 'retarget', tabId: 2 });
    expect(s.notice).toBeNull();
  });
});

describe('本页对话列表（C2）', () => {
  const snapshot = (conversationId: string, pageKey?: string): BackgroundToClient => ({
    type: 'conv/snapshot',
    conversation: {
      id: conversationId,
      ...(pageKey === undefined ? {} : { pageKey }),
      title: '对话标题',
      model: { connectionId: 'conn-1', model: 'm' },
      turns: 1,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    messages: [
      {
        id: `${conversationId}-m1`,
        conversationId,
        ordinal: 0,
        role: 'user',
        segments: [{ kind: 'text', text: '问题' }],
        status: 'completed',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    done: true,
    conversationRevision: 1,
  });

  it('切换到同一页的另一个对话：清空显示，等新订阅的快照补上', () => {
    let s = run(readyPanel(), { kind: 'retarget', tabId: 1 }, server(subscribed(1, undefined, 'c1')));
    expect(switchConversationMessage(s, 'c2')).toEqual({
      type: 'conv/subscribe',
      tabId: 1,
      conversationId: 'c2',
    });
    s = run(s, { kind: 'switchConversation', conversationId: 'c2' });
    expect(s.conversationId).toBe('c2');
    expect(s.job).toBeNull();
    expect(s.messages).toEqual([]);
    // 还没订阅过（target 为 null）时不发消息
    expect(switchConversationMessage(initialPanelState(), 'c2')).toBeNull();
  });

  it('conv/snapshot 带的 ConversationRecord.pageKey 记下来；换页、点新对话都清空', () => {
    let s = run(readyPanel(), { kind: 'retarget', tabId: 1 }, server(subscribed(1)));
    s = run(s, server(snapshot('c1', 'https://a.test/')));
    expect(s.conversationPageKey).toBe('https://a.test/');
    s = run(s, { kind: 'newConversation' });
    expect(s.conversationPageKey).toBeNull();

    let t = run(readyPanel(), { kind: 'retarget', tabId: 1 }, server(subscribed(1)));
    t = run(t, server(snapshot('c1', 'https://a.test/')));
    expect(t.conversationPageKey).toBe('https://a.test/');
    t = run(t, { kind: 'retarget', tabId: 2 });
    expect(t.conversationPageKey).toBeNull();
  });
});

describe('回答上的「存」（G3）', () => {
  it('favorite/saved 标记这条消息已收藏；重复到达不重复触发更新', () => {
    const s = run(
      initialFloatState(true),
      server({ type: 'favorite/saved', favoriteId: 'f1', messageId: 'm1' }),
    );
    expect(s.savedMessageIds.has('m1')).toBe(true);
    const again = floatReducer(s, server({ type: 'favorite/saved', favoriteId: 'f1', messageId: 'm1' }));
    expect(again).toBe(s);
  });

  it('favorite/add 被拒：顶部一次性提示', () => {
    const s = run(
      initialFloatState(true),
      server({ type: 'conv/rejected', reason: 'storageFailed', refType: 'favorite/add' }),
    );
    expect(s.actionError).toContain('操作失败');
  });

  it('favoriteAddMessage 构造正确', () => {
    expect(favoriteAddMessage('c1', 'm1')).toEqual({
      type: 'favorite/add',
      conversationId: 'c1',
      messageId: 'm1',
    });
  });
});

describe('回到某一页后显示那个对话（决策 098）', () => {
  it('retarget 带对话：订阅消息带上它；同一标签页的再订阅沿用，收到这个对话的订阅确认就清掉', () => {
    let s = run(readyPanel(), { kind: 'retarget', tabId: 1 }, server(subscribed(1, undefined, 'c-other')));
    // 点「回到那一页」：标签页已经是 1（同一标签页），对话换成 c-a
    s = run(s, { kind: 'retarget', tabId: 1, conversationId: 'c-a' });
    expect(s.subscribeConversation).toBe('c-a');
    expect(s.targetConfirmed).toBe(false);
    expect(panelSubscribeMessage(s)).toEqual({ type: 'conv/subscribe', tabId: 1, conversationId: 'c-a' });
    // 加载过程中地址变化引起的再订阅：仍然带着它
    s = run(s, { kind: 'retarget', tabId: 1 });
    expect(panelSubscribeMessage(s)).toEqual({ type: 'conv/subscribe', tabId: 1, conversationId: 'c-a' });
    // 先订阅的那次（没带对话）的确认先到：不清；后订阅的那次到了才清，并显示 c-a
    s = run(s, server(subscribed(1, undefined, 'c-latest')));
    expect(s.subscribeConversation).toBe('c-a');
    s = run(s, server(subscribed(1, undefined, 'c-a')));
    expect(s.subscribeConversation).toBeNull();
    expect(s.conversationId).toBe('c-a');
    expect(panelSubscribeMessage(s)).toEqual({ type: 'conv/subscribe', tabId: 1 });
  });

  it('换到别的标签页：带对话的新订阅（点过「新对话」也以这次为准）；之后再换标签页就不带了', () => {
    let s = run(readyPanel(), { kind: 'retarget', tabId: 1 }, server(subscribed(1)), {
      kind: 'newConversation',
    });
    expect(s.freshConversation).toBe(true);
    s = run(s, { kind: 'retarget', tabId: 2, conversationId: 'c-a' });
    expect(s.freshConversation).toBe(false);
    expect(panelSubscribeMessage(s)).toMatchObject({ tabId: 2, conversationId: 'c-a' });
    s = run(s, { kind: 'retarget', tabId: 3 });
    expect(panelSubscribeMessage(s)).toEqual({ type: 'conv/subscribe', tabId: 3 });
  });
});
