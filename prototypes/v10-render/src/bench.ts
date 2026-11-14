/**
 * 性能基准：V-10 要求的 "10k/50k 字回答的分块增量渲染 p50/p95 耗时 +
 * 一次性整体渲染耗时"。用 happy-dom 在 Node 里提供 document，不需要真实浏览器。
 *
 * 运行：npm run bench（tsx src/bench.ts）。只打印到标准输出，不产生文件。
 */
import { Window } from 'happy-dom';
import { createMarkdownIt } from './render/markdown-it-setup.js';
import { createStreamingRenderer } from './render/streaming-renderer.js';

const window = new Window();
const document = window.document as unknown as Document;

/** 生成一段混合了段落、列表、表格、代码块、公式的确定性合成正文，长度约为 targetLength。 */
function buildSyntheticResponse(targetLength: number): string {
  const paragraph =
    '这是一段用于性能基准测试的正文内容，包含中文字符与英文 mixed text，确保长度统计贴近真实回答。';
  const codeBlock = '```js\nfunction add(a, b) {\n  return a + b;\n}\n```\n';
  const table = '| 列1 | 列2 |\n| --- | --- |\n| a | b |\n| 中文 | *斜体* |\n';
  const math = '公式：$E = mc^2$，以及块级：\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\n';
  const list = '- 项目一\n  - 子项目 A\n- 项目二\n- 项目三\n';

  const unit = `${paragraph}\n\n${codeBlock}\n${table}\n${math}${list}\n`;
  let out = '';
  while (out.length < targetLength) {
    out += unit;
  }
  return out.slice(0, targetLength);
}

/** 把文本按固定大小切成 chunk，模拟模型逐 token/逐小段吐出的流式节奏。 */
function chunkBySize(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function benchIncremental(text: string, chunkSize: number): { p50: number; p95: number; total: number } {
  const md = createMarkdownIt();
  const renderer = createStreamingRenderer({ md, document });
  const chunks = chunkBySize(text, chunkSize);
  const durations: number[] = [];
  let acc = '';
  const start = performance.now();
  for (const chunk of chunks) {
    acc += chunk;
    const t0 = performance.now();
    renderer.update(acc, new Set());
    durations.push(performance.now() - t0);
  }
  renderer.finalize(acc, new Set());
  const total = performance.now() - start;
  durations.sort((a, b) => a - b);
  return { p50: percentile(durations, 50), p95: percentile(durations, 95), total };
}

function benchOneShot(text: string): number {
  const md = createMarkdownIt();
  const renderer = createStreamingRenderer({ md, document });
  const start = performance.now();
  renderer.update(text, new Set());
  renderer.finalize(text, new Set());
  return performance.now() - start;
}

function fmt(ms: number): string {
  return `${ms.toFixed(3)} ms`;
}

function run(): void {
  const sizes = [10_000, 50_000];
  const chunkSize = 20; // 近似典型模型流式分段大小

  console.log('V-10 性能基准（happy-dom，Node 环境，chunkSize=' + chunkSize + '）\n');
  for (const size of sizes) {
    const text = buildSyntheticResponse(size);
    const inc = benchIncremental(text, chunkSize);
    const oneShot = benchOneShot(text);
    console.log(`-- 文本长度 ${size} 字 --`);
    console.log(`  增量：chunk 数=${Math.ceil(size / chunkSize)}，每 chunk 渲染 p50=${fmt(inc.p50)}，p95=${fmt(inc.p95)}，全流程总耗时=${fmt(inc.total)}`);
    console.log(`  一次性整体渲染（update+finalize 各一次）：${fmt(oneShot)}`);
    console.log('');
  }
}

run();
