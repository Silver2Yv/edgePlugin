// 汇总延迟统计：按 接口×变体 分组计算 p50/p95；另外做整体接口对比与警示。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function statsFor(records, field) {
  const vals = records.map((r) => r[field]).filter((v) => v !== null && v !== undefined);
  return {
    n: vals.length,
    p50: percentile(vals, 50),
    p95: percentile(vals, 95),
    min: vals.length ? Math.min(...vals) : null,
    max: vals.length ? Math.max(...vals) : null
  };
}

const latency = readFileSync(new URL('../results/raw/latency.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const endpoints = [...new Set(latency.map((r) => r.endpoint))];
const variants = [...new Set(latency.map((r) => r.variant))];

const table = [];
for (const ep of endpoints) {
  for (const v of variants) {
    const subset = latency.filter((r) => r.endpoint === ep && r.variant === v && r.ok);
    table.push({
      endpoint: ep,
      endpointLabel: subset[0]?.endpointLabel,
      variant: v,
      n: subset.length,
      tHeader: statsFor(subset, 'tHeader'),
      tFirstToken: statsFor(subset, 'tFirstToken'),
      tFirstSuggestion: statsFor(subset, 'tFirstSuggestion'),
      tDone: statsFor(subset, 'tDone')
    });
  }
}

// 按语言细分（检查中英文是否有系统性差异）
const langTable = [];
for (const ep of endpoints) {
  for (const lang of ['zh', 'en']) {
    const subset = latency.filter((r) => r.endpoint === ep && r.lang === lang && r.ok);
    langTable.push({ endpoint: ep, lang, n: subset.length, tFirstSuggestion: statsFor(subset, 'tFirstSuggestion') });
  }
}

const warmup = readFileSync(new URL('../results/raw/warmup.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const warmupByEndpoint = {};
for (const ep of endpoints) {
  const subset = warmup.filter((r) => r.endpoint === ep && r.ok);
  const readyCount = subset.filter((r) => r.readyBeforeClick).length;
  warmupByEndpoint[ep] = {
    n: subset.length,
    assumedLeadMs: subset[0]?.assumedLeadMs,
    readyCount,
    readyRate: subset.length ? readyCount / subset.length : null,
    tFirstSuggestion: statsFor(subset, 'tFirstSuggestion')
  };
}

const proxyHit = JSON.parse(readFileSync(new URL('../results/proxy-hit-summary.json', import.meta.url), 'utf8'));

const summary = { latencyByEndpointVariant: table, latencyByLang: langTable, warmup: warmupByEndpoint, proxyHit };

mkdirSync(new URL('../results/', import.meta.url), { recursive: true });
writeFileSync(new URL('../results/summary.json', import.meta.url), JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify(summary, null, 2));
