// V-09 耗时测量脚本（非 vitest，独立运行）：
//   npx tsx anchor/src/bench.ts
//
// 构造一个中文长文档（约 4 万字），按 300~800 字切块，分别测量：
//   1. 精确匹配命中
//   2. 近似匹配命中（文本有少量改动）
//   3. 完全找不到（精确 + 近似两级都失败，走到滚动比例兜底为止）
// 每种场景跑若干次，输出平均值与 p95。只打印到控制台，不写文件。

import { matchAnchor } from './match';
import type { Anchor, Block } from './types';
import { computeBlockDigest } from './types';

const ITERATIONS = 20;
const CONTEXT_LEN = 32;

// ---------- 构造测试文档 ----------

const TEMPLATES = [
  '人工智能技术正在快速发展，越来越多的企业开始探索如何将其应用到实际业务场景当中。',
  '在这段内容里，我们讨论的是文档的组织结构，以及如何让读者更容易理解整体脉络。',
  '安全与隐私始终是产品设计中不可忽视的一环，需要在功能和风险之间找到合适的平衡点。',
  '本节简要回顾了过去一段时间内的主要进展，并对下一阶段的工作做了初步展望。',
  '用户反馈显示，界面的响应速度和交互的流畅程度，是影响整体体验的关键因素之一。',
];

function buildFullText(targetLength: number): string {
  let full = '';
  let i = 0;
  while (full.length < targetLength) {
    full += `第${i + 1}段。${TEMPLATES[i % TEMPLATES.length]}这段话用于填充篇幅，模拟真实长文档的段落密度。`;
    i++;
  }
  return full;
}

function splitIntoBlocks(fullText: string): Block[] {
  const blocks: Block[] = [];
  let cursor = 0;
  let blockIndex = 1;
  while (cursor < fullText.length) {
    // 块大小固定取中值 550（可复现），落在架构描述的 300~800 字区间内。
    const size = 550;
    const text = fullText.slice(cursor, cursor + size);
    blocks.push({
      id: blockIndex,
      text,
      headingChain: [`第${Math.ceil(blockIndex / 10)}章`],
      scrollRatio: Math.min(1, cursor / fullText.length),
    });
    cursor += size;
    blockIndex++;
  }
  return blocks;
}

function buildAnchorFromBlock(block: Block, exactText: string, extra: Partial<Anchor> = {}): Anchor {
  const offset = block.text.indexOf(exactText);
  if (offset === -1) throw new Error('bench 构造错误：exactText 不在给定块内');
  const end = offset + exactText.length;
  return {
    exactText,
    contextBefore: block.text.slice(Math.max(0, offset - CONTEXT_LEN), offset),
    contextAfter: block.text.slice(end, end + CONTEXT_LEN),
    blockDigest: computeBlockDigest(block.text),
    headingChain: block.headingChain,
    scrollRatio: block.scrollRatio,
    blockOffset: offset,
    blockId: block.id,
    contentVersion: 'v1',
    contextSnapshotId: 'snap-bench',
    ...extra,
  };
}

// ---------- 计时工具 ----------

interface TimingStats {
  mean: number;
  p95: number;
  min: number;
  max: number;
}

function timeIt(fn: () => void, iterations: number): TimingStats {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    samples.push(t1 - t0);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  return { mean, p95, min: samples[0], max: samples[samples.length - 1] };
}

function formatStats(label: string, stats: TimingStats) {
  console.log(
    `  ${label}: 平均 ${stats.mean.toFixed(3)}ms, p95 ${stats.p95.toFixed(3)}ms, 最快 ${stats.min.toFixed(3)}ms, 最慢 ${stats.max.toFixed(3)}ms`,
  );
}

// ---------- 主流程 ----------

function main() {
  const fullText = buildFullText(42000);
  const blocks = splitIntoBlocks(fullText);
  console.log(`文档总长度：${fullText.length} 字，切成 ${blocks.length} 个块（每块 550 字）。`);
  console.log(`每种场景跑 ${ITERATIONS} 次，取平均与 p95。\n`);

  // 取文档中间偏后的一个块，模拟"目标不在文档开头、全量扫描有代表性开销"的情况。
  const targetBlock = blocks[Math.floor(blocks.length * 0.6)];
  const exactSentence = '安全与隐私始终是产品设计中不可忽视的一环，需要在功能和风险之间找到合适的平衡点';

  // --- 场景 1：精确匹配命中 ---
  const exactAnchor = buildAnchorFromBlock(targetBlock, exactSentence);
  const exactStats = timeIt(() => {
    const result = matchAnchor(blocks, exactAnchor, { currentContentVersion: 'v1' });
    if (result.tier !== 'exact') throw new Error('bench 场景 1 预期应为 exact，实际：' + result.tier);
  }, ITERATIONS);

  // --- 场景 2：近似匹配命中（轻微改动：替换 2 个字） ---
  const mutatedSentence = exactSentence.replace('不可忽视', '不可忽略').replace('合适的', '恰当的');
  const mutatedBlocks = blocks.map((b) =>
    b.id === targetBlock.id ? { ...b, text: b.text.replace(exactSentence, mutatedSentence) } : b,
  );
  const approxAnchor = buildAnchorFromBlock(targetBlock, exactSentence); // 锚点仍记录改动前的原文
  const approxStats = timeIt(() => {
    const result = matchAnchor(mutatedBlocks, approxAnchor, { currentContentVersion: 'v1' });
    if (result.tier !== 'approximate') throw new Error('bench 场景 2 预期应为 approximate，实际：' + result.tier);
  }, ITERATIONS);

  // --- 场景 3：完全找不到（精确 + 近似两级都失败） ---
  const goneAnchor = buildAnchorFromBlock(targetBlock, exactSentence, {
    exactText: '这段文字在整篇文档里绝对不会出现任何一次这么长且独特的占位句子',
  });
  const notFoundStats = timeIt(() => {
    const result = matchAnchor(blocks, goneAnchor, { currentContentVersion: 'v1' });
    // 精确 + 近似都应该失败；由于 scrollRatio 仍然有效，最终会走到 scroll-fallback，
    // 这里只关心"两级文本匹配都失败所需的耗时"，和最终落在哪一级兜底无关。
    if (result.tier === 'exact' || result.tier === 'approximate') {
      throw new Error('bench 场景 3 不应该匹配成功，实际：' + result.tier);
    }
  }, ITERATIONS);

  console.log('结果：');
  formatStats('场景 1 - 精确匹配命中', exactStats);
  formatStats('场景 2 - 近似匹配命中', approxStats);
  formatStats('场景 3 - 完全找不到（两级文本匹配均失败）', notFoundStats);
}

main();
