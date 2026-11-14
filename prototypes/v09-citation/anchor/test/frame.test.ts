// V-09 场景 10：多框架引用。
// frame A 的锚点不能被拿去匹配到 frame B 里即使文字相似/相同的内容。

import { describe, expect, it } from 'vitest';
import { matchAnchor } from '../src/match';
import type { Block } from '../src/types';
import { buildAnchor } from './helpers';

describe('场景 10：多框架引用的 frame 隔离', () => {
  it('frameA 的锚点只会命中 frameA 内的文字，不会被 frameB 里相同的文字干扰', () => {
    const blockFrameA: Block = {
      id: 1,
      text: '欢迎使用。请输入用户名和密码以继续访问系统。感谢使用。',
      headingChain: [],
      scrollRatio: 0.2,
      frameId: 'frameA',
    };
    // frameB 里有完全相同的目标句子，但前后铺垫文字不同，偏移量也不同——
    // 如果 frame 隔离失效，精确匹配会在 frameA + frameB 两处各找到一次同样的文本，
    // 从而触发"重复文本"的消歧逻辑，而不是像现在这样得到唯一、确定的结果。
    const blockFrameB: Block = {
      id: 1,
      text: '错误提示占位占位占位。请输入用户名和密码以继续访问系统。结束占位。',
      headingChain: [],
      scrollRatio: 0.2,
      frameId: 'frameB',
    };
    const blocks: Block[] = [blockFrameA, blockFrameB];

    const anchor = buildAnchor(blockFrameA, '请输入用户名和密码以继续访问系统', { frameId: 'frameA' });

    const result = matchAnchor(blocks, anchor, { currentContentVersion: 'v1' });

    expect(result.tier).toBe('exact');
    if (result.tier !== 'exact') throw new Error('unreachable');
    expect(result.frameId).toBe('frameA');
    // 命中偏移必须是 frameA 里的真实偏移，而不是 frameB 里（不同铺垫文字导致）的偏移。
    expect(result.start).toBe(blockFrameA.text.indexOf('请输入用户名和密码以继续访问系统'));
    expect(result.start).not.toBe(blockFrameB.text.indexOf('请输入用户名和密码以继续访问系统'));
  });

  it('frameB 的锚点同理只命中 frameB，不会跑到 frameA', () => {
    const blockFrameA: Block = {
      id: 1,
      text: '欢迎使用。请输入用户名和密码以继续访问系统。感谢使用。',
      headingChain: [],
      scrollRatio: 0.2,
      frameId: 'frameA',
    };
    const blockFrameB: Block = {
      id: 1,
      text: '错误提示占位占位占位。请输入用户名和密码以继续访问系统。结束占位。',
      headingChain: [],
      scrollRatio: 0.2,
      frameId: 'frameB',
    };
    const blocks: Block[] = [blockFrameA, blockFrameB];

    const anchor = buildAnchor(blockFrameB, '请输入用户名和密码以继续访问系统', { frameId: 'frameB' });

    const result = matchAnchor(blocks, anchor, { currentContentVersion: 'v1' });

    expect(result.tier).toBe('exact');
    if (result.tier !== 'exact') throw new Error('unreachable');
    expect(result.frameId).toBe('frameB');
    expect(result.start).toBe(blockFrameB.text.indexOf('请输入用户名和密码以继续访问系统'));
  });
});
