// 预热场景：模拟"工具栏出现即预热"——在用户点击"问"之前就发出请求，
// 相当于比用户点击早约 0.5–1.5 秒。这里用固定提前量 1 秒模拟：
// 先记录"工具栏出现"时刻 T0，立即发起请求；在 T0+1000ms 视为"用户点击问"，
// 计算此时建议是否已经可显示（即 tFirstSuggestion 是否 < 1000ms）。
//
// 2 接口 × 20 段材料 × 2 次重复，只用 selection_context 变体（更贴近真实上下文）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getEndpoint1, getEndpoint2 } from './lib/keys.mjs';
import { buildPrompt } from './lib/prompt.mjs';
import { streamSuggestions, parseSuggestions } from './lib/stream-client.mjs';
import { createLimiter } from './lib/limiter.mjs';

const REPEATS = 2;
const CONCURRENCY = 3;
const ASSUMED_LEAD_MS = 1000; // 预热提前量，落在 0.5-1.5 秒区间中段

const materials = JSON.parse(readFileSync(new URL('../materials.json', import.meta.url), 'utf8'));

const endpoints = [
  { key: 'endpoint1', label: '公司中转站', cfg: getEndpoint1() },
  { key: 'endpoint2', label: 'DeepSeek官方', cfg: getEndpoint2('deepseek-flash') }
];

mkdirSync(new URL('../results/raw/', import.meta.url), { recursive: true });
const outPath = new URL('../results/raw/warmup.jsonl', import.meta.url);

const tasks = [];
for (const ep of endpoints) {
  for (const material of materials) {
    for (let rep = 1; rep <= REPEATS; rep++) {
      tasks.push({ ep, material, rep });
    }
  }
}

console.log(`预热场景总任务数: ${tasks.length}`);

const limit = createLimiter(CONCURRENCY);
let done = 0;
const results = [];

await Promise.all(
  tasks.map((task) =>
    limit(async () => {
      const prompt = buildPrompt(task.material, 'selection_context');
      const r = await streamSuggestions(task.ep.cfg, prompt);
      const readyBeforeClick = r.ok && r.tFirstSuggestion !== null && r.tFirstSuggestion < ASSUMED_LEAD_MS;
      const record = {
        endpoint: task.ep.key,
        endpointLabel: task.ep.label,
        materialId: task.material.id,
        lang: task.material.lang,
        rep: task.rep,
        ok: r.ok,
        error: r.error || null,
        tHeader: r.tHeader ?? null,
        tFirstToken: r.tFirstToken ?? null,
        tFirstSuggestion: r.tFirstSuggestion ?? null,
        tDone: r.tDone ?? null,
        assumedLeadMs: ASSUMED_LEAD_MS,
        readyBeforeClick
      };
      results.push(record);
      done++;
      if (done % 10 === 0 || done === tasks.length) console.log(`进度: ${done}/${tasks.length}`);
      return record;
    })
  )
);

writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
console.log('完成，写入', outPath.pathname);

const okResults = results.filter((r) => r.ok);
const readyCount = okResults.filter((r) => r.readyBeforeClick).length;
console.log(`在假设提前量 ${ASSUMED_LEAD_MS}ms 下，${readyCount}/${okResults.length} 次建议已在用户点击前可显示`);
