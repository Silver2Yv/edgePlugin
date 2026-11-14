// 延迟测量：2 接口 × 2 变体 × 20 段材料 × 3 次重复 = 240 次流式请求。
// 并发上限 3。记录：到响应头、到首个 token、到第一条完整建议可显示、到全部完成。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getEndpoint1, getEndpoint2 } from './lib/keys.mjs';
import { buildPrompt, VARIANTS } from './lib/prompt.mjs';
import { streamSuggestions, parseSuggestions } from './lib/stream-client.mjs';
import { createLimiter } from './lib/limiter.mjs';

const REPEATS = 3;
const CONCURRENCY = 3;

const materials = JSON.parse(readFileSync(new URL('../materials.json', import.meta.url), 'utf8'));

const endpoints = [
  { key: 'endpoint1', label: '公司中转站', cfg: getEndpoint1() },
  { key: 'endpoint2', label: 'DeepSeek官方', cfg: getEndpoint2('deepseek-flash') }
];

mkdirSync(new URL('../results/raw/', import.meta.url), { recursive: true });
const outPath = new URL('../results/raw/latency.jsonl', import.meta.url);

const tasks = [];
for (const ep of endpoints) {
  for (const variant of VARIANTS) {
    for (const material of materials) {
      for (let rep = 1; rep <= REPEATS; rep++) {
        tasks.push({ ep, variant, material, rep });
      }
    }
  }
}

console.log(`总任务数: ${tasks.length}`);

const limit = createLimiter(CONCURRENCY);
let done = 0;
const results = [];

await Promise.all(
  tasks.map((task) =>
    limit(async () => {
      const prompt = buildPrompt(task.material, task.variant);
      const r = await streamSuggestions(task.ep.cfg, prompt);
      const record = {
        endpoint: task.ep.key,
        endpointLabel: task.ep.label,
        variant: task.variant,
        materialId: task.material.id,
        lang: task.material.lang,
        rep: task.rep,
        ok: r.ok,
        error: r.error || null,
        tHeader: r.tHeader ?? null,
        tFirstToken: r.tFirstToken ?? null,
        tFirstSuggestion: r.tFirstSuggestion ?? null,
        tDone: r.tDone ?? null,
        suggestionCount: r.ok ? parseSuggestions(r.content).length : 0
      };
      results.push(record);
      done++;
      if (done % 10 === 0 || done === tasks.length) {
        console.log(`进度: ${done}/${tasks.length}`);
      }
      return record;
    })
  )
);

// 追加写入 jsonl
const lines = results.map((r) => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(outPath, lines, 'utf8');
console.log('完成，写入', outPath.pathname);

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`失败请求数: ${failed.length}`);
  for (const f of failed.slice(0, 5)) {
    console.log(' -', f.endpoint, f.variant, f.materialId, f.rep, f.error);
  }
}
