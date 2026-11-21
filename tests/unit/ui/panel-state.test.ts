// 侧边栏与转接的界面纯逻辑（src/ui/float/state.ts 新增部分）：换订阅时丢弃旧标签页的推送、
// 两个界面跟随同一个任务、转接进度、开关快捷键的判断。
import { describe, expect, it } from 'vitest';
import type { BackgroundToClient } from '@/core/domain/messages';
import {
  buildAskMessage,
  type FloatAction,
  type FloatState,
  floatReducer,
  initialFloatState,
  initialPanelState,
  panelSubscribeMessage,
  shouldCloseOnToggle,
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

  it('侧边栏续问带上正在显示的对话；小窗不带（每次是新对话）', () => {
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
    s = run(s, server({ type: 'handoff/done', handoffId: 'h-other' }));
    expect(s.handoff).toEqual({ handoffId: null, slow: false, done: false });
    s = run(s, server({ type: 'handoff/created', handoffId: 'h1' }), { kind: 'handoffSlow' });
    expect(s.handoff).toEqual({ handoffId: 'h1', slow: true, done: false });
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
