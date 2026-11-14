// V-09 第一部分：流式解析稳定性测试（按随机 chunk 边界切分已完成的模型输出，重放解析）。
//
// 做法：把一段已经拿到的完整模型输出文本，按若干随机位置切成片段，模拟 SSE 增量到达；
// 每收到一片就把它拼进缓冲区，对缓冲区重新跑一次 extract()（对应架构里"结束时做一次
// 完整校正，只替换受影响的块"这种思路的简化版）。
// 关键风险点：某个引用标记在文本里的起始位置（offset）一旦被识别出一次编号，
// 如果后续更大的缓冲区在同一个 offset 识别出了不同的编号——这是"中间态被纠正"，
// 即用户可能已经看到一个错误编号短暂高亮又变化，这是我们要量化的"翻转"（flip）现象。
// 对于"包裹型"写法（标记有明确的闭合符号，比如 ]]、】、</cite>），
// 理论上闭合符号出现前不会产生匹配，所以不该有翻转；
// 对于"插入符编号"这种不需要闭合符号的写法，多位数编号在流中可能被提前读成前缀数字
// （比如 ^12 在 "^1" 阶段就已经能匹配成编号 1），这正是我们要用实验数据验证的风险点。

/**
 * @param {{extract: (text:string)=>Array<{raw:string, blockIds:string[]}>}} format
 * @param {string} fullText
 * @param {number} numSplits 随机切成多少段（越多越能暴露边界问题）
 * @returns {{ flips: number, finalMatchesDirect: boolean, events: Array<{offset:number, from:string, to:string}> }}
 */
export function replayOnce(format, fullText, numSplits) {
  // 生成 numSplits-1 个 1..len-1 之间的随机切点，排序去重。
  const len = fullText.length;
  const cutSet = new Set();
  const wantCuts = Math.max(0, Math.min(numSplits - 1, len - 1));
  while (cutSet.size < wantCuts) {
    cutSet.add(1 + Math.floor(Math.random() * (len - 1)));
  }
  const cuts = [...cutSet].sort((a, b) => a - b);
  const boundaries = [0, ...cuts, len];

  const lastSeenAtOffset = new Map(); // offset -> blockIds.join(',')
  const events = [];
  let buffer = "";

  for (let i = 1; i < boundaries.length; i++) {
    buffer = fullText.slice(0, boundaries[i]);
    const found = format.extract(buffer);
    for (const c of found) {
      // c.raw 在 buffer 里的起始位置：重新定位（matchAll 的 index 在 extract 内部未透出，
      // 这里用 indexOf 近似定位——对测试样本足够，不追求处理多个完全相同 raw 的极端情况）。
      const offset = buffer.indexOf(c.raw);
      const idsKey = c.blockIds.join(",");
      const prev = lastSeenAtOffset.get(offset);
      if (prev !== undefined && prev !== idsKey) {
        events.push({ offset, from: prev, to: idsKey });
      }
      lastSeenAtOffset.set(offset, idsKey);
    }
  }

  const direct = format.extract(fullText);
  const directKey = JSON.stringify(direct.map((c) => [c.raw, c.blockIds.join(",")]).sort());
  const finalFound = format.extract(buffer);
  const finalKey = JSON.stringify(finalFound.map((c) => [c.raw, c.blockIds.join(",")]).sort());

  return {
    flips: events.length,
    finalMatchesDirect: directKey === finalKey,
    events,
  };
}

/** 对同一段文本跑多次随机切分重放，汇总翻转次数与是否每次都和直接解析一致。 */
export function replayStability(format, fullText, trials = 8, splitsPerTrial = 6) {
  const runs = [];
  for (let t = 0; t < trials; t++) {
    runs.push(replayOnce(format, fullText, splitsPerTrial));
  }
  const totalFlips = runs.reduce((s, r) => s + r.flips, 0);
  const allFinalMatch = runs.every((r) => r.finalMatchesDirect);
  return { totalFlips, allFinalMatch, runs };
}
