import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const id = process.argv[2];
const scheme = process.argv[3] || 'A';
const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', id + '.extraction.json'), 'utf-8'));
const blocks = r[scheme]?.blocks || [];
for (const b of blocks) {
  console.log(`[${b.index}][${b.type}]${b.headingLevel ? '(h'+b.headingLevel+')' : ''} ${b.text.replace(/\s+/g, ' ')}`);
}
