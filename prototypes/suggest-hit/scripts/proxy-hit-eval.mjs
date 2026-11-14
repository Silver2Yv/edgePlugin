// 代理命中评估：
// 1) 重新生成一组"建议"（endpoint2, 两个变体, 20 段, 各 1 次）用于比对；
// 2) 读者视角：每段材料生成 2 个"看不到建议"时最想问的问题；
// 3) 判别：逐条判断读者问题是否被某条建议命中；
// 4) 汇总代理命中率。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getEndpoint2 } from './lib/keys.mjs';
import { buildPrompt, VARIANTS } from './lib/prompt.mjs';
import { streamSuggestions, parseSuggestions } from './lib/stream-client.mjs';
import { buildReaderPrompt, buildJudgePrompt } from './lib/eval-prompt.mjs';
import { createLimiter } from './lib/limiter.mjs';

const CONCURRENCY = 3;
const materials = JSON.parse(readFileSync(new URL('../materials.json', import.meta.url), 'utf8'));
const endpoint = getEndpoint2('deepseek-flash');
mkdirSync(new URL('../results/raw/', import.meta.url), { recursive: true });

const limit = createLimiter(CONCURRENCY);

// --- 阶段 1：重新生成建议（两个变体） ---
console.log('阶段 1/3：生成建议...');
const suggestionTasks = [];
for (const variant of VARIANTS) {
  for (const material of materials) {
    suggestionTasks.push({ variant, material });
  }
}
const suggestionResults = await Promise.all(
  suggestionTasks.map((t) =>
    limit(async () => {
      const prompt = buildPrompt(t.material, t.variant);
      const r = await streamSuggestions(endpoint, prompt);
      const suggestions = r.ok ? parseSuggestions(r.content) : [];
      return { materialId: t.material.id, variant: t.variant, ok: r.ok, suggestions };
    })
  )
);
writeFileSync(
  new URL('../results/raw/eval-suggestions.json', import.meta.url),
  JSON.stringify(suggestionResults, null, 2),
  'utf8'
);
console.log(`  完成 ${suggestionResults.length} 组`);

// --- 阶段 2：读者视角问题 ---
console.log('阶段 2/3：生成读者问题...');
const readerResults = await Promise.all(
  materials.map((material) =>
    limit(async () => {
      const prompt = buildReaderPrompt(material);
      const r = await streamSuggestions(endpoint, prompt, { maxTokens: 150 });
      const questions = r.ok
        ? r.content
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => l.replace(/^\d+[.、)]\s*/, '').trim())
            .filter(Boolean)
            .slice(0, 2)
        : [];
      return { materialId: material.id, ok: r.ok, questions };
    })
  )
);
writeFileSync(
  new URL('../results/raw/reader-questions.json', import.meta.url),
  JSON.stringify(readerResults, null, 2),
  'utf8'
);
console.log(`  完成 ${readerResults.length} 段`);

// --- 阶段 3：判别命中 ---
console.log('阶段 3/3：判别命中...');
const readerByMaterial = Object.fromEntries(readerResults.map((r) => [r.materialId, r]));
const judgeTasks = [];
for (const sr of suggestionResults) {
  const reader = readerByMaterial[sr.materialId];
  if (!reader || !reader.ok || reader.questions.length < 2 || !sr.ok || sr.suggestions.length < 3) continue;
  judgeTasks.push({ materialId: sr.materialId, variant: sr.variant, readerQuestions: reader.questions, suggestions: sr.suggestions });
}
const judgeResults = await Promise.all(
  judgeTasks.map((t) =>
    limit(async () => {
      const prompt = buildJudgePrompt(t.readerQuestions, t.suggestions);
      const r = await streamSuggestions(endpoint, prompt, { maxTokens: 60 });
      let hit1 = null;
      let hit2 = null;
      if (r.ok) {
        const m1 = r.content.match(/读者问题1命中[：:]\s*(无|[123])/);
        const m2 = r.content.match(/读者问题2命中[：:]\s*(无|[123])/);
        hit1 = m1 ? m1[1] : null;
        hit2 = m2 ? m2[1] : null;
      }
      return { materialId: t.materialId, variant: t.variant, ok: r.ok, hit1, hit2, raw: r.ok ? r.content : r.error };
    })
  )
);
writeFileSync(
  new URL('../results/raw/judge-hits.json', import.meta.url),
  JSON.stringify(judgeResults, null, 2),
  'utf8'
);
console.log(`  完成 ${judgeResults.length} 组判别`);

// --- 汇总 ---
function summarize(results) {
  let totalQuestions = 0;
  let hitQuestions = 0;
  for (const r of results) {
    if (!r.ok) continue;
    for (const h of [r.hit1, r.hit2]) {
      if (h === null) continue;
      totalQuestions++;
      if (h !== '无') hitQuestions++;
    }
  }
  return { totalQuestions, hitQuestions, rate: totalQuestions ? hitQuestions / totalQuestions : null };
}

const byVariant = {};
for (const v of VARIANTS) {
  byVariant[v] = summarize(judgeResults.filter((r) => r.variant === v));
}
const overall = summarize(judgeResults);

const summary = { byVariant, overall, judgeTaskCount: judgeTasks.length };
writeFileSync(
  new URL('../results/proxy-hit-summary.json', import.meta.url),
  JSON.stringify(summary, null, 2),
  'utf8'
);
console.log('代理命中率汇总:', JSON.stringify(summary, null, 2));
