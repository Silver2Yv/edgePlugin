// V-09：引用身份校验（编号是否在发送集合内）与版本绑定校验的单元测试。

import { describe, expect, it } from 'vitest';
import { matchAnchor } from '../src/match';
import type { Block } from '../src/types';
import { isAnchorVersionCurrent, isCitationBlockValid } from '../src/validate';
import { buildAnchor } from './helpers';

describe('场景 7：模型输出无效块号', () => {
  it('isCitationBlockValid 直接拒绝不在发送集合内的块号', () => {
    expect(isCitationBlockValid(5, [1, 2, 3])).toBe(false);
    expect(isCitationBlockValid(2, [1, 2, 3])).toBe(true);
  });

  it('matchAnchor 在引用块号不在发送集合内时直接拒绝，不进入三级匹配流程', () => {
    const blocks: Block[] = [{ id: 1, text: '这句话本来是能够被精确命中的目标文本。', headingChain: [], scrollRatio: 0.3 }];
    const anchor = buildAnchor(blocks[0], '本来是能够被精确命中的目标文本', { blockId: 1 });

    // 如果真的跑了三级匹配流程，这段文本在 blocks 里是能精确命中的；
    // 但因为 1 不在 sentBlockIds={2,3} 里，必须在前置校验就被拒绝。
    const result = matchAnchor(blocks, anchor, { currentContentVersion: 'v1', sentBlockIds: [2, 3] });

    expect(result.tier).toBe('invalid-citation');
  });
});

describe('场景 8：编号只在发送块集合内有效', () => {
  it('发送集合是 {1,2,3}，引用了集合外（甚至文档里根本不存在）的 5 号块，直接拒绝', () => {
    const sentBlockIds = [1, 2, 3];
    expect(isCitationBlockValid(5, sentBlockIds)).toBe(false);

    const blocks: Block[] = [{ id: 1, text: '文档里只有 1 号块，没有 5 号块。', headingChain: [], scrollRatio: 0.1 }];
    const anchorSource: Block = { id: 5, text: '一段不存在于当前 blocks 里的文本。', headingChain: [], scrollRatio: 0.5 };
    const anchor = buildAnchor(anchorSource, '一段不存在于当前', { blockId: 5 });

    const result = matchAnchor(blocks, anchor, { currentContentVersion: 'v1', sentBlockIds });

    // 不需要等到匹配阶段去发现"5 号块不存在"，发送集合校验这一步就应该拒绝。
    expect(result.tier).toBe('invalid-citation');
  });
});

describe('isAnchorVersionCurrent：版本绑定校验函数本身', () => {
  it('contentVersion 相同时判定为当前有效', () => {
    const block: Block = { id: 1, text: '任意文本内容用于构造锚点。', headingChain: [], scrollRatio: 0.1 };
    const anchor = buildAnchor(block, '任意文本内容', { contentVersion: 'v1' });
    expect(isAnchorVersionCurrent(anchor, 'v1')).toBe(true);
  });

  it('contentVersion 不同（如快照过期后版本已推进）时判定为失效', () => {
    const block: Block = { id: 1, text: '任意文本内容用于构造锚点。', headingChain: [], scrollRatio: 0.1 };
    const anchor = buildAnchor(block, '任意文本内容', { contentVersion: 'v1' });
    expect(isAnchorVersionCurrent(anchor, 'v2')).toBe(false);
  });
});
