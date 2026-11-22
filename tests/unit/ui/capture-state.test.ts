// 框选截图在界面一侧的归约逻辑（capture 块）：预览出现 / 去掉 / 被取走 / 没截成，发问带 captureId，
// 用户消息里的缩略图，发送说明里的「附图 N 张」。
import { describe, expect, it } from 'vitest';
import type { RequestContextPlan } from '@/core/context/plan';
import type { BackgroundToClient } from '@/core/domain/messages';
import type { MessageRecord } from '@/core/domain/records';
import { recordToView } from '@/ui/float/messages';
import { sendSummary } from '@/ui/float/send-summary';
import {
  buildAskMessage,
  type FloatAction,
  type FloatState,
  floatReducer,
  initialFloatState,
} from '@/ui/float/state';
import { T } from '@/ui/strings';

const server = (msg: BackgroundToClient): FloatAction => ({ kind: 'server', msg });
const run = (s: FloatState, ...actions: FloatAction[]) => actions.reduce(floatReducer, s);
const ready = () =>
  run(initialFloatState(true), server({ type: 'conv/ready', role: 'float', protocolVersion: 1 }));

const THUMB = 'data:image/jpeg;base64,/9j/4AAQ';
const preview = (captureId = 'cap-00000001'): BackgroundToClient => ({
  type: 'conv/capture',
  captureId,
  thumb: THUMB,
  width: 320,
  height: 200,
});

describe('预览', () => {
  it('conv/capture 显示预览；× 去掉后同一张的补发不再显示，新的一张照常显示', () => {
    let s = run(ready(), server(preview()));
    expect(s.capture).toEqual({ captureId: 'cap-00000001', thumb: THUMB, width: 320, height: 200 });
    s = run(s, { kind: 'dismissCapture' });
    expect(s.capture).toBeNull();
    s = run(s, server(preview()));
    expect(s.capture).toBeNull();
    s = run(s, server(preview('cap-00000002')));
    expect(s.capture?.captureId).toBe('cap-00000002');
  });

  it('captureCleared 只收起同一张', () => {
    const s = run(ready(), server(preview()));
    expect(run(s, server({ type: 'conv/captureCleared', captureId: 'cap-00000009' })).capture).not.toBeNull();
    expect(run(s, server({ type: 'conv/captureCleared', captureId: 'cap-00000001' })).capture).toBeNull();
  });

  it('captureFailed 显示一行原因', () => {
    const s = run(ready(), server({ type: 'conv/captureFailed', reason: 'changed' }));
    expect(s.actionError).toBe(T.capture.failed.changed);
  });

  it('发问带上 captureId；接单后预览收起，本地的用户消息带缩略图', () => {
    let s = run(ready(), server(preview()));
    const msg = buildAskMessage({
      clientRequestId: 'req-1',
      text: '',
      quote: null,
      contextTier: 'selection',
      lengthTier: 'normal',
      thinking: 'off',
      model: { connectionId: 'conn-0001', model: 'mock-flash' },
      captureId: 'cap-00000001',
    });
    expect(msg).toMatchObject({ type: 'conv/ask', captureId: 'cap-00000001' });
    s = run(s, { kind: 'askSent', clientRequestId: 'req-1', text: '', quote: null, capture: s.capture });
    s = run(
      s,
      server({
        type: 'conv/accepted',
        clientRequestId: 'req-1',
        jobId: 'job-1',
        messageId: 'msg-1',
        conversationId: 'conv-0001',
      }),
    );
    expect(s.capture).toBeNull();
    const user = s.messages.at(-1);
    expect(user?.role).toBe('user');
    expect(user && 'images' in user ? user.images : undefined).toEqual([{ thumb: THUMB, index: 0 }]);
  });
});

describe('历史消息与发送说明', () => {
  it('库里的用户消息有图：视图里按位置留缩略图的坑（向后台取）', () => {
    const r: MessageRecord = {
      id: 'msg-00000001',
      conversationId: 'conv-0001',
      ordinal: 0,
      role: 'user',
      segments: [{ kind: 'text', text: '' }],
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
      images: [{ blobId: 'blob-0001', mime: 'image/png', width: 320, height: 200 }],
    };
    const v = recordToView(r);
    expect(v && 'images' in v ? v.images : undefined).toEqual([{ messageId: 'msg-00000001', index: 0 }]);
  });

  it('计划里 imageCount 为 1：发送说明写「附图 1 张」；为 0 不写', () => {
    const plan = (imageCount: number): RequestContextPlan => ({
      contextSnapshotId: 'snap-0001',
      model: { connectionId: 'conn-0001', model: 'mock-flash' },
      lengthTier: 'normal',
      contextTier: 'selection',
      thinking: 'off',
      selectionTruncated: false,
      pageRead: false,
      sentBlockIds: [],
      coverage: { sentChars: 0, extractableChars: 0 },
      droppedHistoryTurns: 0,
      historyHasPageText: false,
      removedEarlierPageText: false,
      imageCount,
      budget: { hardLimit: 32_000, outputReserve: 4096, speedSoftBudget: 16_000, summaryRead: 4800 },
      estimatedInputTokens: 100,
      notes: [],
    });
    expect(sendSummary(plan(1), null).parts).toContain('附图 1 张');
    expect(sendSummary(plan(0), null).parts.join('')).not.toContain('附图');
  });
});
