// V-09 锚点匹配核心测试：精确匹配、近似匹配、彻底找不到、
// 响应前插入/删除段落、重复同一句的消歧、contentVersion 变化后的处理。

import { describe, expect, it } from 'vitest';
import { matchAnchor } from '../src/match';
import type { Block } from '../src/types';
import { buildAnchor } from './helpers';

describe('场景 1：精确定位成功', () => {
  it('能精确命中未发生任何变化的原文，并返回正确的块与偏移', () => {
    const blocks: Block[] = [
      { id: 1, text: '第一段内容，介绍背景信息，没有特别之处，用来填充篇幅。', headingChain: ['第一章'], scrollRatio: 0.1 },
      {
        id: 2,
        text: '这里有一句关键引用：人工智能正在改变世界的运作方式。后面还有更多说明文字用来填充长度。',
        headingChain: ['第一章', '1.1 节'],
        scrollRatio: 0.3,
      },
    ];
    const anchor = buildAnchor(blocks[1], '人工智能正在改变世界的运作方式');

    const result = matchAnchor(blocks, anchor, { currentContentVersion: 'v1' });

    expect(result.tier).toBe('exact');
    if (result.tier !== 'exact') throw new Error('unreachable');
    expect(result.blockId).toBe(2);
    expect(result.text).toBe('人工智能正在改变世界的运作方式');
    expect(blocks[1].text.slice(result.start, result.end)).toBe('人工智能正在改变世界的运作方式');
  });
});

describe('场景 2：近似定位成功', () => {
  it('原文被轻微改动（插入一个逗号、改了一个字）时仍能近似命中', () => {
    const originalBlocks: Block[] = [
      { id: 2, text: '这里有一句关键引用：人工智能正在改变世界的运作方式。后面还有更多说明文字。', headingChain: [], scrollRatio: 0.3 },
    ];
    const anchor = buildAnchor(originalBlocks[0], '人工智能正在改变世界的运作方式');

    // 当前文档：同一个块 id，但句子被轻微改动——插入一个逗号 + 一个字替换。
    const currentBlocks: Block[] = [
      { id: 2, text: '这里有一句关键引用：人工智能，正在改变世界的运转方式。后面还有更多说明文字。', headingChain: [], scrollRatio: 0.3 },
    ];

    const result = matchAnchor(currentBlocks, anchor, { currentContentVersion: 'v1' });

    expect(result.tier).toBe('approximate');
    if (result.tier !== 'approximate') throw new Error('unreachable');
    expect(result.blockId).toBe(2);
    expect(result.reason).toBe('text-changed');
    // "人工智能正在改变世界的运作方式" -> "人工智能，正在改变世界的运转方式"：
    // 插入一个"，" + "作"->"转" 一处替换，编辑距离应为 2。
    expect(result.errors).toBe(2);
    expect(result.text).toBe('人工智能，正在改变世界的运转方式');
  });
});

describe('场景 3：彻底找不到', () => {
  it('目标 frame 在当前文档里不存在时返回 unresolved，调用方应判定为不可点击', () => {
    const blocks: Block[] = [{ id: 1, text: '当前文档的内容，和锚点完全无关。', headingChain: [], scrollRatio: 0.2 }];
    const anchorSourceBlock: Block = { id: 1, text: '一段完全不同的原始文本，用来生成锚点。', headingChain: [], scrollRatio: 0.5, frameId: 'frame-removed' };
    const anchor = buildAnchor(anchorSourceBlock, '一段完全不同的原始文本');

    // 当前文档里压根没有 frame-removed 这个 frame 的任何块（比如 iframe 被整体移除），
    // 这正是架构原文举的"完全没有任何候选"的例子，应该直接 unresolved，
    // 而不是退化成 scroll-fallback（因为 scrollRatio 本身在一个不存在的 frame 里没有意义）。
    const result = matchAnchor(blocks, anchor, { currentContentVersion: 'v1' });

    expect(result.tier).toBe('unresolved');
    // unresolved 就是"调用方应判定为不可点击"的信号；没有 start/end/scrollRatio 之类的字段可用。
    expect('start' in result).toBe(false);
    expect('scrollRatio' in result).toBe(false);
  });
});

describe('场景 4：响应前插入段落', () => {
  it('前面插入新块导致旧 blockId 指向错误内容时，仍能靠文本精确定位到正确的块', () => {
    const v1Blocks: Block[] = [
      { id: 1, text: '引言部分，介绍文档目的。', headingChain: [], scrollRatio: 0.1 },
      { id: 2, text: '核心结论：每日喝八杯水有助于维持身体水分平衡。', headingChain: [], scrollRatio: 0.5 },
      { id: 3, text: '附录与参考资料列表。', headingChain: [], scrollRatio: 0.9 },
    ];
    const anchor = buildAnchor(v1Blocks[1], '每日喝八杯水有助于维持身体水分平衡', { contentVersion: 'v1' });

    // v2：在最前面插入一个新块，后面的块整体重新编号（1..4）。
    // 旧 anchor.blockId = 2，但 v2 里 id=2 现在对应的是"引言部分"，不再是原来的目标内容。
    const v2Blocks: Block[] = [
      { id: 1, text: '新增的版本说明，这是后来插入的段落。', headingChain: [], scrollRatio: 0.1 },
      { id: 2, text: '引言部分，介绍文档目的。', headingChain: [], scrollRatio: 0.3 },
      { id: 3, text: '核心结论：每日喝八杯水有助于维持身体水分平衡。', headingChain: [], scrollRatio: 0.6 },
      { id: 4, text: '附录与参考资料列表。', headingChain: [], scrollRatio: 0.9 },
    ];

    const result = matchAnchor(v2Blocks, anchor, { currentContentVersion: 'v2' });

    expect(result.tier).toBe('exact');
    if (result.tier !== 'exact') throw new Error('unreachable');
    // 必须是新文档里文本真正所在的块（id=3），而不是按旧编号错误地定位到 id=2（引言部分）。
    expect(result.blockId).toBe(3);
    expect(result.blockId).not.toBe(anchor.blockId);
    expect(result.text).toBe('每日喝八杯水有助于维持身体水分平衡');
  });
});

describe('场景 5：响应前删除段落', () => {
  it('目标块被整体删除、原文确实不存在了时，退化为滚动比例兜底，而不是误判成功匹配到无关内容', () => {
    const v1Blocks: Block[] = [
      { id: 1, text: '引言部分，介绍文档目的。', headingChain: [], scrollRatio: 0.1 },
      { id: 2, text: '核心结论：每日喝八杯水有助于维持身体水分平衡。', headingChain: [], scrollRatio: 0.5 },
      { id: 3, text: '附录与参考资料列表。', headingChain: [], scrollRatio: 0.9 },
    ];
    const anchor = buildAnchor(v1Blocks[1], '每日喝八杯水有助于维持身体水分平衡', { contentVersion: 'v1' });

    // v2：目标段落被整体删除，剩下的块和"每日喝八杯水..."这句话毫不相关，
    // 编辑距离会远超近似匹配的门槛，近似匹配也必然失败。
    const v2Blocks: Block[] = [
      { id: 1, text: '引言部分，介绍文档目的。', headingChain: [], scrollRatio: 0.2 },
      { id: 2, text: '附录与参考资料列表。', headingChain: [], scrollRatio: 0.8 },
    ];

    const result = matchAnchor(v2Blocks, anchor, { currentContentVersion: 'v2' });

    // 这里按本实现的取舍选择 scroll-fallback 而不是 unresolved：
    // 架构原文把"滚动比例兜底"明确列为三级降级里的第三级，专门用来处理
    // "前两级都失败、但 frame 仍然存在、scrollRatio 仍然有意义"的情况——
    // 段落被删除但文档本身还在，正是这个第三级要覆盖的典型场景。
    // unresolved 应该保留给"连滚动比例也没有意义"的彻底失败场景（见场景 3）。
    // 关键断言是：结果既不能是 'exact'，也不能是伪装成功的 'approximate'
    // （编辑距离在门槛内但其实指向无关内容）——这两者都没有发生。
    expect(result.tier).toBe('scroll-fallback');
    if (result.tier !== 'scroll-fallback') throw new Error('unreachable');
    expect(result.scrollRatio).toBe(0.5); // 取自锚点保存时记录的原滚动位置
    expect('text' in result).toBe(false); // 没有任何具体文字可以高亮
  });
});

describe('场景 6：重复同一句，用上下文消歧', () => {
  it('同一句话出现在两个不同块时，靠上下文选中正确的那处，而不是机械地选第一次出现', () => {
    const blockA: Block = {
      id: 'a',
      text: '行政通知区域的铺垫文字。重要通知：请大家准时参加会议。这是第一次出现，上下文是行政通知相关内容。',
      headingChain: ['行政通知'],
      scrollRatio: 0.1,
    };
    const blockB: Block = {
      id: 'b',
      text: '项目进展区域的铺垫文字。重要通知：请大家准时参加会议。这是第二次出现，上下文是项目进展相关内容，也是原始引用所在位置。',
      headingChain: ['项目进展'],
      scrollRatio: 0.6,
    };
    // blockA 排在数组第一位（文档顺序上的"第一次出现"），blockB 排第二位，
    // 但锚点实际是从 blockB 的上下文创建的——专门验证不会机械选中排在前面的 blockA。
    const blocks: Block[] = [blockA, blockB];
    const anchor = buildAnchor(blockB, '重要通知：请大家准时参加会议');

    const result = matchAnchor(blocks, anchor, { currentContentVersion: 'v1' });

    expect(result.tier).toBe('exact');
    if (result.tier !== 'exact') throw new Error('unreachable');
    expect(result.blockId).toBe('b');
    expect(result.blockId).not.toBe('a'); // 明确断言：没有选中数组里第一次出现的那个
  });
});

describe('场景 9：contentVersion 变化后旧锚点不套用', () => {
  it('版本一致时，上下文打平的歧义可以靠 blockId 命中裁决', () => {
    // 两个块内容完全相同（含前后文），制造"上下文也无法区分"的真正歧义。
    const blockA: Block = { id: 'a', text: '占位填充文字。重要通知：请大家准时参加会议。后续说明文字。', headingChain: [], scrollRatio: 0.1 };
    const blockB: Block = { id: 'b', text: '占位填充文字。重要通知：请大家准时参加会议。后续说明文字。', headingChain: [], scrollRatio: 0.6 };
    const blocks: Block[] = [blockA, blockB];
    const anchor = buildAnchor(blockB, '重要通知：请大家准时参加会议', { contentVersion: 'v1', blockId: 'b' });

    const result = matchAnchor(blocks, anchor, { currentContentVersion: 'v1' });

    expect(result.tier).toBe('exact');
    if (result.tier !== 'exact') throw new Error('unreachable');
    expect(result.blockId).toBe('b');
  });

  it('版本不一致时，即使上下文打平，也不会盲目信任旧 blockId，而是降级为歧义提示', () => {
    const blockA: Block = { id: 'a', text: '占位填充文字。重要通知：请大家准时参加会议。后续说明文字。', headingChain: [], scrollRatio: 0.1 };
    const blockB: Block = { id: 'b', text: '占位填充文字。重要通知：请大家准时参加会议。后续说明文字。', headingChain: [], scrollRatio: 0.6 };
    const blocks: Block[] = [blockA, blockB];
    const anchor = buildAnchor(blockB, '重要通知：请大家准时参加会议', { contentVersion: 'v1', blockId: 'b' });

    // 当前文档版本号变了（比如快照过期 / 内容发生过编辑），即使文字和上下文都完全没变，
    // 也不应该再用 anchor.blockId 当裁决信号去武断地选中 'b'。
    const result = matchAnchor(blocks, anchor, { currentContentVersion: 'v2' });

    expect(result.tier).toBe('approximate');
    if (result.tier !== 'approximate') throw new Error('unreachable');
    expect(result.reason).toBe('ambiguous-duplicate');
    expect(result.errors).toBe(0);
    expect(result.confidence).toBe('low');
  });

  it('版本不一致 + 原文确实已经不存在时，不会凑合匹配，走滚动兜底或 unresolved', () => {
    const v1Block: Block = { id: 1, text: '核心结论：每日喝八杯水有助于维持身体水分平衡。', headingChain: [], scrollRatio: 0.5 };
    const anchor = buildAnchor(v1Block, '每日喝八杯水有助于维持身体水分平衡', { contentVersion: 'v1' });

    // 当前文档：内容已经被完全改写，既没有原文，也没有能近似对上的内容；版本号也变了。
    const v2Blocks: Block[] = [
      { id: 1, text: '完全不相关的内容：今天的天气晴朗，适合户外运动。', headingChain: [], scrollRatio: 0.2 },
    ];

    const result = matchAnchor(v2Blocks, anchor, { currentContentVersion: 'v2' });

    // 不能是 exact，也不能是看起来"命中"但其实指向无关内容的 approximate。
    expect(result.tier === 'scroll-fallback' || result.tier === 'unresolved').toBe(true);
    if (result.tier === 'approximate' || result.tier === 'exact') {
      throw new Error('不应该在原文已经不存在的情况下报告匹配成功');
    }
  });
});
