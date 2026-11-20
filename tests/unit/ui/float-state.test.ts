// 小窗纯逻辑单测：增量合并、任务状态迁移、握手/重连状态机、消息构造（src/ui/float/state.ts）。
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@/core/domain/messages';
import {
  applyDelta,
  applyJobState,
  buildAskMessage,
  createJobView,
  floatReducer,
  initialFloatState,
  isGenerating,
  type JobView,
  onPortDisconnect,
  onReady,
  onResumeRejected,
  onWake,
  parseTokenFromHash,
  restoreCommandsOnConnect,
  shouldSendOnEnter,
  subscribeMessage,
} from '@/ui/float/state';

const JOB = 'job-aaaaaaaa';
const MSG = 'msg-aaaaaaaa';
const A1 = 'attempt-one';
const A2 = 'attempt-two';

describe('applyDelta：增量合并', () => {
  const base: JobView = createJobView(JOB, MSG);

  it('首条增量：attemptId 从空补上，整段写入正文', () => {
    const v = applyDelta(base, {
      type: 'conv/delta',
      jobId: JOB,
      messageId: MSG,
      attemptId: A1,
      seq: 1,
      text: '你',
    });
    expect(v).toMatchObject({ attemptId: A1, attemptStarted: true, lastSeq: 1, text: '你', reasoning: '' });
  });

  it('同一尝试内追加，正文与思考分开累积', () => {
    let v = applyDelta(base, {
      type: 'conv/delta',
      jobId: JOB,
      messageId: MSG,
      attemptId: A1,
      seq: 1,
      text: '你',
      reasoning: '想',
    });
    v = applyDelta(v, {
      type: 'conv/delta',
      jobId: JOB,
      messageId: MSG,
      attemptId: A1,
      seq: 2,
      text: '好',
      reasoning: '一下',
    });
    expect(v.text).toBe('你好');
    expect(v.reasoning).toBe('想一下');
    expect(v.lastSeq).toBe(2);
  });

  it('丢弃 seq ≤ 已见值的增量', () => {
    const v = applyDelta(base, {
      type: 'conv/delta',
      jobId: JOB,
      messageId: MSG,
      attemptId: A1,
      seq: 5,
      text: 'x',
    });
    const dup = applyDelta(v, {
      type: 'conv/delta',
      jobId: JOB,
      messageId: MSG,
      attemptId: A1,
      seq: 5,
      text: 'y',
    });
    expect(dup).toBe(v); // 原样返回，未变化
    const stale = applyDelta(v, {
      type: 'conv/delta',
      jobId: JOB,
      messageId: MSG,
      attemptId: A1,
      seq: 3,
      text: 'y',
    });
    expect(stale).toBe(v);
  });

  it('丢弃不属于本任务的增量', () => {
    const v = applyDelta(base, {
      type: 'conv/delta',
      jobId: 'other-job',
      messageId: MSG,
      attemptId: A1,
      seq: 1,
      text: 'x',
    });
    expect(v).toBe(base);
  });

  it('新尝试的第一条增量整段替换，不与旧尝试内容拼接', () => {
    const v1 = applyDelta(base, {
      type: 'conv/delta',
      jobId: JOB,
      messageId: MSG,
      attemptId: A1,
      seq: 1,
      text: '旧答案',
    });
    const v2 = applyDelta(v1, {
      type: 'conv/delta',
      jobId: JOB,
      messageId: MSG,
      attemptId: A2,
      seq: 2,
      text: '新',
    });
    expect(v2.text).toBe('新'); // 不是「旧答案新」
    expect(v2.attemptId).toBe(A2);
  });

  it('终态不可覆盖：到达终态后的增量原样丢弃', () => {
    const done: JobView = { ...base, attemptId: A1, state: 'completed' };
    const v = applyDelta(done, {
      type: 'conv/delta',
      jobId: JOB,
      messageId: MSG,
      attemptId: A1,
      seq: 1,
      text: 'x',
    });
    expect(v).toBe(done);
  });
});

describe('applyJobState：状态迁移', () => {
  const base: JobView = createJobView(JOB, MSG);

  it('同一尝试内更新状态', () => {
    const v = applyJobState(base, { type: 'conv/jobState', jobId: JOB, state: 'streaming', attemptId: '' });
    expect(v.state).toBe('streaming');
    expect(v.attemptId).toBe('');
  });

  it('attemptId 变化（重试）：保留旧正文，attemptStarted 复位为 false', () => {
    const streaming = {
      ...base,
      attemptId: A1,
      attemptStarted: true,
      text: '旧答案',
      state: 'failed' as const,
    };
    // 失败后重试：新尝试的 jobState 先到，attemptId 变化
    const retried = applyJobState(
      { ...streaming, state: 'streaming' },
      {
        type: 'conv/jobState',
        jobId: JOB,
        state: 'accepted',
        attemptId: A2,
      },
    );
    expect(retried.attemptId).toBe(A2);
    expect(retried.attemptStarted).toBe(false);
    expect(retried.text).toBe('旧答案'); // 还没整体替换
  });

  it('重试是跳出终态的唯一例外：failed 状态下 attemptId 变化也能回到 accepted', () => {
    const failed: JobView = { ...base, attemptId: A1, attemptStarted: true, text: '旧答案', state: 'failed' };
    const retried = applyJobState(failed, {
      type: 'conv/jobState',
      jobId: JOB,
      state: 'accepted',
      attemptId: A2,
    });
    expect(retried.state).toBe('accepted');
    expect(retried.attemptId).toBe(A2);
    expect(retried.attemptStarted).toBe(false);
    expect(retried.text).toBe('旧答案'); // 还没整体替换
  });

  it('终态不可覆盖', () => {
    const done: JobView = { ...base, state: 'completed' };
    const v = applyJobState(done, { type: 'conv/jobState', jobId: JOB, state: 'failed', attemptId: '' });
    expect(v).toBe(done);
  });

  it('不属于本任务的状态消息被丢弃', () => {
    const v = applyJobState(base, {
      type: 'conv/jobState',
      jobId: 'other-job',
      state: 'streaming',
      attemptId: '',
    });
    expect(v).toBe(base);
  });

  it('error 只在消息带了的时候写入；换尝试时清掉旧 error', () => {
    const failed = applyJobState(
      { ...base, state: 'streaming' },
      {
        type: 'conv/jobState',
        jobId: JOB,
        state: 'failed',
        attemptId: '',
        error: { kind: 'network', message: '连接失败' },
      },
    );
    expect(failed.error).toEqual({ kind: 'network', message: '连接失败' });

    // 重开一次尝试：不该再带着上次的 error
    const retried = applyJobState(
      { ...failed, state: 'streaming' },
      {
        type: 'conv/jobState',
        jobId: JOB,
        state: 'accepted',
        attemptId: A1,
      },
    );
    expect('error' in retried).toBe(false);
  });
});

describe('isGenerating', () => {
  it('没有任务时不是生成中', () => {
    expect(isGenerating(null)).toBe(false);
  });
  it('终态不是生成中，非终态是', () => {
    const base = createJobView(JOB, MSG);
    expect(isGenerating(base)).toBe(true);
    expect(isGenerating({ ...base, state: 'completed' })).toBe(false);
  });
});

describe('握手与重连状态机', () => {
  it('协议版本一致才就绪', () => {
    expect(onReady(PROTOCOL_VERSION)).toBe('ready');
    expect(onReady(PROTOCOL_VERSION + 1)).toBe('versionMismatch');
  });

  it('端口断开：有未到终态的任务立即重连', () => {
    expect(onPortDisconnect('ready', true)).toBe('reconnecting');
    expect(onPortDisconnect('reconnecting', true)).toBe('reconnecting');
  });

  it('端口断开：没有未到终态的任务转入 idle，不重连', () => {
    expect(onPortDisconnect('ready', false)).toBe('idle');
    expect(onPortDisconnect('connecting', false)).toBe('idle');
  });

  it('noToken / expired 不受端口断开影响，不管有没有任务', () => {
    expect(onPortDisconnect('noToken', true)).toBe('noToken');
    expect(onPortDisconnect('noToken', false)).toBe('noToken');
    expect(onPortDisconnect('expired', true)).toBe('expired');
    expect(onPortDisconnect('expired', false)).toBe('expired');
  });

  it('只有 idle 能被唤醒重连，其余状态不受影响', () => {
    expect(onWake('idle')).toBe('reconnecting');
    expect(onWake('ready')).toBe('ready');
    expect(onWake('reconnecting')).toBe('reconnecting');
    expect(onWake('noToken')).toBe('noToken');
  });

  it('resumeFloat 被拒绝后连接失效，不再重试', () => {
    expect(onResumeRejected()).toBe('expired');
  });
});

describe('parseTokenFromHash', () => {
  const TOKEN = '0123456789abcdef0123456789abcdef';

  it('合法的 #t=<令牌> 解析出令牌', () => {
    expect(parseTokenFromHash(`#t=${TOKEN}`)).toBe(TOKEN);
  });

  it('没有片段、前缀不对、或令牌格式不对都返回 null', () => {
    expect(parseTokenFromHash('')).toBeNull();
    expect(parseTokenFromHash('#other')).toBeNull();
    expect(parseTokenFromHash('#t=too-short')).toBeNull();
    expect(parseTokenFromHash(`#t=${TOKEN}extra`)).toBeNull();
    expect(parseTokenFromHash(`#t=${TOKEN.toUpperCase()}`)).toBeNull(); // 只认小写十六进制
  });
});

describe('floatReducer：整体归约', () => {
  it('conv/ready 版本一致后转为 ready', () => {
    const s = floatReducer(initialFloatState(true), {
      kind: 'server',
      msg: { type: 'conv/ready', role: 'float', protocolVersion: PROTOCOL_VERSION },
    });
    expect(s.connPhase).toBe('ready');
  });

  it('conv/quote 更新引用条', () => {
    const s = floatReducer(initialFloatState(true), {
      kind: 'server',
      msg: {
        type: 'conv/quote',
        selectionRevision: 1,
        text: '选中的文字',
        truncated: false,
        originalLength: 5,
      },
    });
    expect(s.quote).toEqual({
      selectionRevision: 1,
      text: '选中的文字',
      truncated: false,
      originalLength: 5,
    });
  });

  it('conv/accepted 只接受对应 pendingClientRequestId 的那次发问', () => {
    const asked = floatReducer(initialFloatState(true), { kind: 'askSent', clientRequestId: 'req-1' });
    const other = floatReducer(asked, {
      kind: 'server',
      msg: {
        type: 'conv/accepted',
        clientRequestId: 'req-2',
        jobId: JOB,
        messageId: MSG,
        conversationId: 'c1',
      },
    });
    expect(other.job).toBeNull(); // 不是这次发问的回执，不建任务

    const accepted = floatReducer(asked, {
      kind: 'server',
      msg: {
        type: 'conv/accepted',
        clientRequestId: 'req-1',
        jobId: JOB,
        messageId: MSG,
        conversationId: 'c1',
      },
    });
    expect(accepted.job).toMatchObject({ jobId: JOB, messageId: MSG, state: 'accepted' });
    expect(accepted.pendingClientRequestId).toBeNull();
  });

  it('conv/delta 与 conv/jobState 落在当前任务上', () => {
    let s = floatReducer(initialFloatState(true), { kind: 'askSent', clientRequestId: 'req-1' });
    s = floatReducer(s, {
      kind: 'server',
      msg: {
        type: 'conv/accepted',
        clientRequestId: 'req-1',
        jobId: JOB,
        messageId: MSG,
        conversationId: 'c1',
      },
    });
    s = floatReducer(s, {
      kind: 'server',
      msg: { type: 'conv/delta', jobId: JOB, messageId: MSG, attemptId: A1, seq: 1, text: '你好' },
    });
    expect(s.job?.text).toBe('你好');
    s = floatReducer(s, {
      kind: 'server',
      msg: { type: 'conv/jobState', jobId: JOB, state: 'completed', attemptId: A1 },
    });
    expect(s.job?.state).toBe('completed');
  });

  it('conv/rejected：refType 为 conv/resumeFloat 时连接失效', () => {
    const s = floatReducer(initialFloatState(true), {
      kind: 'server',
      msg: { type: 'conv/rejected', reason: 'badToken', refType: 'conv/resumeFloat' },
    });
    expect(s.connPhase).toBe('expired');
  });

  it('conv/rejected：refId 对应当前发问时标为失败', () => {
    const asked = floatReducer(initialFloatState(true), { kind: 'askSent', clientRequestId: 'req-1' });
    const s = floatReducer(asked, {
      kind: 'server',
      msg: { type: 'conv/rejected', reason: 'invalid', refType: 'conv/ask', refId: 'req-1' },
    });
    expect(s.pendingClientRequestId).toBeNull();
    expect(s.actionError).toContain('消息格式不对');
  });

  it('disconnected：没有未到终态的任务转入 idle', () => {
    const s = floatReducer({ ...initialFloatState(true), connPhase: 'ready' }, { kind: 'disconnected' });
    expect(s.connPhase).toBe('idle');
  });

  it('disconnected：有未到终态的任务立即转入 reconnecting', () => {
    const withJob = { ...initialFloatState(true), connPhase: 'ready' as const, job: createJobView(JOB, MSG) };
    const s = floatReducer(withJob, { kind: 'disconnected' });
    expect(s.connPhase).toBe('reconnecting');
  });

  it('wake：只有 idle 会被唤醒重连', () => {
    const idle = { ...initialFloatState(true), connPhase: 'idle' as const };
    expect(floatReducer(idle, { kind: 'wake' }).connPhase).toBe('reconnecting');
    const ready = { ...initialFloatState(true), connPhase: 'ready' as const };
    expect(floatReducer(ready, { kind: 'wake' })).toBe(ready); // 非 idle 原样返回，不触发多余渲染
  });

  it('queueAsk：存下待发问；同一时刻只留最后一个', () => {
    const base = initialFloatState(true);
    const ask1 = {
      clientRequestId: 'req-1',
      text: '第一问',
      lengthTier: 'normal' as const,
      thinking: 'off' as const,
      model: { connectionId: 'c1', model: 'm1' },
    };
    const ask2 = { ...ask1, clientRequestId: 'req-2', text: '第二问' };
    let s = floatReducer(base, { kind: 'queueAsk', ask: ask1 });
    expect(s.queuedAsk).toEqual(ask1);
    s = floatReducer(s, { kind: 'queueAsk', ask: ask2 });
    expect(s.queuedAsk).toEqual(ask2); // 后一个覆盖前一个
  });

  it('askSent：清掉 queuedAsk，记下 pendingClientRequestId', () => {
    const ask = {
      clientRequestId: 'req-1',
      text: '问',
      lengthTier: 'normal' as const,
      thinking: 'off' as const,
      model: { connectionId: 'c1', model: 'm1' },
    };
    const queued = floatReducer(initialFloatState(true), { kind: 'queueAsk', ask });
    const sent = floatReducer(queued, { kind: 'askSent', clientRequestId: 'req-1' });
    expect(sent.queuedAsk).toBeNull();
    expect(sent.pendingClientRequestId).toBe('req-1');
  });

  it('conv/snapshot：done 为真才计一次，不动 queuedAsk（真正发出由 FloatApp 的副作用做）', () => {
    const ask = {
      clientRequestId: 'req-1',
      text: '问',
      lengthTier: 'normal' as const,
      thinking: 'off' as const,
      model: { connectionId: 'c1', model: 'm1' },
    };
    const queued = floatReducer(initialFloatState(true), { kind: 'queueAsk', ask });
    const notDone = floatReducer(queued, {
      kind: 'server',
      msg: { type: 'conv/snapshot', messages: [], done: false, conversationRevision: 0 },
    });
    expect(notDone.snapshotSeq).toBe(0);
    const done = floatReducer(queued, {
      kind: 'server',
      msg: { type: 'conv/snapshot', messages: [], done: true, conversationRevision: 0 },
    });
    expect(done.snapshotSeq).toBe(1);
    expect(done.queuedAsk).toEqual(ask); // reducer 自己不清，交给 askSent
  });
});

describe('subscribeMessage', () => {
  it('没有任务时订阅不带 resume', () => {
    expect(subscribeMessage(null)).toEqual({ type: 'conv/subscribe' });
  });

  it('任务未到终态时带 resume', () => {
    const job = { ...createJobView(JOB, MSG), lastSeq: 7 };
    expect(subscribeMessage(job)).toEqual({ type: 'conv/subscribe', resume: { jobId: JOB, lastSeq: 7 } });
  });

  it('任务已到终态时不带 resume', () => {
    const job: JobView = { ...createJobView(JOB, MSG), state: 'completed' };
    expect(subscribeMessage(job)).toEqual({ type: 'conv/subscribe' });
  });
});

describe('buildAskMessage', () => {
  it('没有引用时不带 selectionRevision', () => {
    const m = buildAskMessage({
      clientRequestId: 'req-1',
      text: '这是什么意思',
      quote: null,
      lengthTier: 'normal',
      thinking: 'off',
      model: { connectionId: 'conn-1', model: 'deepseek-flash' },
    });
    expect('selectionRevision' in m).toBe(false);
  });

  it('有引用时带上对应的 selectionRevision', () => {
    const m = buildAskMessage({
      clientRequestId: 'req-1',
      text: '这是什么意思',
      quote: { selectionRevision: 3, text: 'x', truncated: false, originalLength: 1 },
      lengthTier: 'normal',
      thinking: 'off',
      model: { connectionId: 'conn-1', model: 'deepseek-flash' },
    });
    expect(m).toMatchObject({ selectionRevision: 3, actionId: 'ask', contextTier: 'selection' });
  });
});

describe('shouldSendOnEnter', () => {
  it('Enter 发送', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false })).toBe(true);
  });
  it('Shift+Enter 换行，不发送', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true })).toBe(false);
  });
  it('输入法组合输入中的 Enter 不发送', () => {
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
  });
  it('其他按键不发送', () => {
    expect(shouldSendOnEnter({ key: 'a', shiftKey: false })).toBe(false);
  });
});

describe('restoreCommandsOnConnect：小窗私有端口连接后恢复拖动/缩放记忆（5.3）', () => {
  const current = { x: 10, y: 10, w: 380, h: 480 };

  it('没有记忆设置：不发任何指令', () => {
    expect(restoreCommandsOnConnect(current, { placement: 'nearSelection' })).toEqual([]);
  });

  it('摆放策略「出现在选区附近」：只恢复尺寸，不恢复坐标', () => {
    const cmds = restoreCommandsOnConnect(current, {
      placement: 'nearSelection',
      rect: { x: 999, y: 999, w: 500, h: 600 },
    });
    expect(cmds).toEqual([{ type: 'float/resize', w: 500, h: 600 }]);
  });

  it('摆放策略「记住位置」：恢复坐标；尺寸相同时不重复发送 resize', () => {
    const cmds = restoreCommandsOnConnect(current, {
      placement: 'remembered',
      rect: { x: 999, y: 888, w: 380, h: 480 },
    });
    expect(cmds).toEqual([{ type: 'float/reposition', x: 999, y: 888 }]);
  });

  it('摆放策略「记住位置」且尺寸也不同：先恢复尺寸，再恢复坐标', () => {
    const cmds = restoreCommandsOnConnect(current, {
      placement: 'remembered',
      rect: { x: 999, y: 888, w: 500, h: 600 },
    });
    expect(cmds).toEqual([
      { type: 'float/resize', w: 500, h: 600 },
      { type: 'float/reposition', x: 999, y: 888 },
    ]);
  });
});
