// 产物体积检查（ARCHITECTURE 5.1、5.15）。哨兵 gzip ≤ 10 KB 为硬门槛；阅读器 50 KB 为初值，只提示。
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const OUT = resolve(import.meta.dirname, '..', '.output', 'chrome-mv3');
const BUDGETS = [
  { file: 'content-scripts/sentinel.js', limitKb: 10, hard: true },
  { file: 'content-scripts/reader.js', limitKb: 50, hard: false },
];

let failed = false;
for (const { file, limitKb, hard } of BUDGETS) {
  const path = join(OUT, file);
  if (!existsSync(path)) {
    console.error(`找不到 ${file}，请先运行 pnpm build`);
    failed = true;
    continue;
  }
  const kb = gzipSync(readFileSync(path), { level: 9 }).length / 1024;
  const over = kb > limitKb;
  const mark = over ? (hard ? '超限' : '超出初值') : '通过';
  console.log(`${file}：gzip ${kb.toFixed(2)} KB / 上限 ${limitKb} KB —— ${mark}`);
  if (over && hard) failed = true;
}
if (failed) process.exit(1);
