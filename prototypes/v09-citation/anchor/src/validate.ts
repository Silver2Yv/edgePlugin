// V-09：引用身份 / 版本绑定校验。
// 这两项校验独立于三级降级匹配算法（match.ts），属于"匹配前置检查"：
// 不通过的情况下根本不应该进入精确 / 近似 / 滚动比例的匹配流程。

import type { Anchor, Block } from './types';

/**
 * 校验模型 / 用户给出的引用块号是否属于"该次请求实际发送的块集合"。
 *
 * 架构要求"编号只在发送集合内有效"：不在集合内的编号必须直接拒绝，
 * 不能进入任何匹配 / 降级流程——哪怕这段文本凑巧能在页面别处被找到也不行，
 * 因为这种情况下编号本身就是伪造或过期的引用身份。放行的话，会把
 * "模型编造了一个编号"和"编号正确但原文后来变了"这两种性质完全不同的问题混为一谈，
 * 调用方也就没法分别给出"这是幻觉引用"和"原文可能已变化"两种不同提示。
 */
export function isCitationBlockValid(
  blockId: Block['id'],
  sentBlockIds: Iterable<Block['id']>,
): boolean {
  for (const id of sentBlockIds) {
    if (id === blockId) return true;
  }
  return false;
}

/**
 * 校验锚点保存时的 contentVersion 是否与当前文档版本一致。
 *
 * 一致：说明从锚点创建到现在，文档内容没有发生（被记录到版本号里的）变化，
 *       这时 anchor.blockId 这个提示相对更值得信任。
 * 不一致（含"快照 7 天过期"之类的场景，重新打开时版本号已经前进）：
 *       块很可能已经整体错位——同一个编号现在可能对应到完全不同的内容，
 *       所以绝不能直接拿旧 blockId 去索引当前的块数组当作权威结果，
 *       必须整体退回纯文本匹配路径（精确 -> 近似 -> 滚动比例）重新定位。
 *       在 match.ts 里，这个函数的结果只用来决定"精确匹配阶段，上下文消歧打平时，
 *       要不要再拿 blockId 作为最后的裁决信号"——版本不一致时放弃这个信号，
 *       宁可把结果判成"歧义降级"，也不用一个不确定的信号去替用户做选择。
 */
export function isAnchorVersionCurrent(anchor: Anchor, currentContentVersion: string): boolean {
  return anchor.contentVersion === currentContentVersion;
}
