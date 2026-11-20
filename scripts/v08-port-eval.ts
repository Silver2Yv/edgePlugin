// V-08 移植核对：在原型的 28 个样本上，并排跑「原型方案 A」与「src/page/extract.ts 的移植版」，比较关键证据召回、
// 远距离指代召回、块数与耗时，确认移植后指标不变差（V-04/V-06/V-07 记录引用此结果）。
// 样本是整页原文（版权与隐私原因不入库），只读使用：V08_SAMPLES=<主仓库>/prototypes/v08-extraction/samples
// 用法：node scripts/v08-port-eval.ts [输出 JSON 路径]；V08_ONLY=id1,id2 只跑指定样本
// 加载方式：保存的 HTML 按原地址回放（page.route），样式表照常从网络加载，脚本一律拦截（保持保存时的 DOM），
// 两个版本在同一次加载里依次运行，相同输入、相同指标口径（normalize 去空白、小写，子串匹配，同 compute-metrics.mjs）。
// V08_LIVE=1 时改为原型当初的方式：直接打开线上地址、脚本照跑、等 1.2 秒（页面可能已改版，只作补充对照）。
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'vite';

const ROOT = resolve(import.meta.dirname, '..');
const SAMPLES = process.env.V08_SAMPLES;
if (!SAMPLES) {
  console.error('请设置 V08_SAMPLES 指向原型样本目录（prototypes/v08-extraction/samples）');
  process.exit(2);
}

interface IndexEntry {
  id: string;
  status: string;
  url?: string;
}
interface Labels {
  keyEvidence?: { text: string }[];
  distantReference?: { definitionText: string; referenceText: string } | null;
}
interface RunOut {
  texts: string[];
  ms: number;
  rootMethod: string;
  leakedInput: boolean;
  codeBlocks: number;
  maxSliceMs?: number;
  slices?: number;
}

async function bundle(dir: string): Promise<string> {
  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    [
      `import { runSchemeA } from ${JSON.stringify(join(ROOT, 'prototypes/v08-extraction/src/extractor-src/scheme-a.js'))};`,
      `import { extractPage } from ${JSON.stringify(join(ROOT, 'src/page/extract.ts'))};`,
      '(globalThis as any).__proto = runSchemeA;',
      '(globalThis as any).__port = extractPage;',
    ].join('\n'),
  );
  await build({
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: { '@': join(ROOT, 'src') } },
    build: {
      outDir: join(dir, 'out'),
      emptyOutDir: true,
      minify: false,
      lib: { entry, formats: ['iife'], name: 'v08eval', fileName: () => 'bundle.js' },
    },
  });
  return readFileSync(join(dir, 'out', 'bundle.js'), 'utf8');
}

const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'v08-eval-'));
  const code = await bundle(dir);
  const index = JSON.parse(readFileSync(join(SAMPLES as string, 'index.json'), 'utf8')) as IndexEntry[];
  const browser = await chromium.launch(
    process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {},
  );
  const rows: Record<string, unknown>[] = [];
  for (const entry of index) {
    if (entry.status !== 'ok') continue;
    if (process.env.V08_ONLY && !process.env.V08_ONLY.split(',').includes(entry.id)) continue;
    const html = readFileSync(join(SAMPLES as string, `${entry.id}.html`), 'utf8');
    const labels = JSON.parse(
      readFileSync(join(SAMPLES as string, `${entry.id}.labels.json`), 'utf8'),
    ) as Labels;
    const live = process.env.V08_LIVE === '1' && entry.url?.startsWith('http');
    const url = entry.url?.startsWith('http') ? entry.url : `https://local.fixture/${entry.id}.html`;
    if (process.env.V08_LIVE === '1' && !live) continue;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    if (!live) {
      await page.route('**/*', (route) => {
        const req = route.request();
        if (req.url() === url && req.resourceType() === 'document') {
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        }
        if (['stylesheet', 'font'].includes(req.resourceType()))
          return route.continue().catch(() => undefined);
        return route.abort().catch(() => undefined);
      });
    }
    try {
      const go = () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await go().catch(go);
      if (live) await page.waitForTimeout(1200);
      else await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      // 部分站点的 CSP 会挡新插入的 <script>，evaluate 直接求值不受影响
      await page.evaluate(code);
      const out = (await page.evaluate(async () => {
        const g = globalThis as unknown as {
          __proto: (d: Document) => { blocks: { text: string }[]; timingMs: number; rootMethod: string };
          __port: (d: Document) => Promise<{
            report: { blocks: { text: string; kind: string }[] };
            rootMethod: string;
            stats: { totalMs: number; slices: number; maxSliceMs: number };
          }>;
        };
        const inputs = [...document.querySelectorAll('input, textarea')]
          .filter((el) => {
            const ta = el as HTMLTextAreaElement;
            return !(
              el.tagName === 'TEXTAREA' &&
              (ta.readOnly || el.getAttribute('aria-readonly') === 'true')
            );
          })
          .map((el) => (el as HTMLInputElement).value.trim())
          .filter((v) => v.length >= 8);
        const a = g.__proto(document);
        const p = await g.__port(document);
        const leak = (texts: string[]) => inputs.some((v) => texts.some((t) => t.includes(v)));
        const pt = p.report.blocks.map((b) => b.text);
        return {
          proto: {
            texts: a.blocks.map((b) => b.text),
            ms: a.timingMs,
            rootMethod: a.rootMethod,
            leakedInput: leak(a.blocks.map((b) => b.text)),
            codeBlocks: 0,
          },
          port: {
            texts: pt,
            ms: p.stats.totalMs,
            rootMethod: p.rootMethod,
            leakedInput: leak(pt),
            codeBlocks: p.report.blocks.filter((b) => b.kind === 'code').length,
            maxSliceMs: p.stats.maxSliceMs,
            slices: p.stats.slices,
          },
        };
      })) as { proto: RunOut; port: RunOut };
      const score = (r: RunOut) => {
        const joined = normalize(r.texts.join('\n'));
        const ev = labels.keyEvidence ?? [];
        const found = ev.filter((e) => joined.includes(normalize(e.text))).length;
        const d = labels.distantReference;
        const distant = d
          ? Number(
              joined.includes(normalize(d.definitionText)) && joined.includes(normalize(d.referenceText)),
            )
          : null;
        return {
          evidence: `${found}/${ev.length}`,
          recall: ev.length ? found / ev.length : null,
          distant,
          blocks: r.texts.length,
          chars: r.texts.reduce((n, t) => n + t.length, 0),
          ms: Math.round(r.ms * 10) / 10,
          root: r.rootMethod,
          leakedInput: r.leakedInput,
          codeBlocks: r.codeBlocks,
          ...(r.maxSliceMs === undefined
            ? {}
            : { maxSliceMs: Math.round(r.maxSliceMs * 10) / 10, slices: r.slices }),
        };
      };
      rows.push({ id: entry.id, proto: score(out.proto), port: score(out.port) });
    } catch (e) {
      rows.push({ id: entry.id, error: String(e).slice(0, 200) });
    }
    await context.close();
  }
  await browser.close();

  const pick = (k: 'proto' | 'port') =>
    rows.flatMap((r) =>
      r[k] ? [r[k] as { recall: number | null; distant: number | null; ms: number }] : [],
    );
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };
  const summary = Object.fromEntries(
    (['proto', 'port'] as const).map((k) => {
      const xs = pick(k);
      const ms = xs.map((x) => x.ms);
      return [
        k,
        {
          samples: xs.length,
          meanEvidenceRecall: mean(xs.flatMap((x) => (x.recall === null ? [] : [x.recall]))),
          distantReferenceRecall: mean(xs.flatMap((x) => (x.distant === null ? [] : [x.distant]))),
          distantSamples: xs.filter((x) => x.distant !== null).length,
          p50Ms: pct(ms, 50),
          p95Ms: pct(ms, 95),
        },
      ];
    }),
  );
  for (const r of rows) {
    const p = r.proto as Record<string, unknown> | undefined;
    const q = r.port as Record<string, unknown> | undefined;
    if (!p || !q) {
      console.log(`${r.id}\t错误 ${String(r.error)}`);
      continue;
    }
    console.log(
      `${r.id}\t原型 ${p.evidence} 远引${p.distant ?? '-'} ${p.blocks}块 ${p.ms}ms ${p.root}` +
        `\t移植 ${q.evidence} 远引${q.distant ?? '-'} ${q.blocks}块 ${q.ms}ms ${q.root} 代码块${q.codeBlocks}` +
        ` 最长片${q.maxSliceMs}ms/${q.slices}片` +
        `${q.leakedInput ? ' 【读到了输入框的值】' : ''}`,
    );
  }
  console.log(JSON.stringify(summary, null, 2));
  const outPath = process.argv[2];
  if (outPath) writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 2));
}

await main();
