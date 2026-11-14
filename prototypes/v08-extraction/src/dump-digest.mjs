import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'results');

const only = process.argv[2] ? process.argv[2].split(',') : null;

const files = fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.extraction.json'));
for (const f of files) {
	const id = f.replace('.extraction.json', '');
	if (only && !only.includes(id)) continue;
	const r = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8'));
	let out = `===== ${id} =====\n`;
	for (const s of ['A', 'B', 'C']) {
		const scheme = r[s];
		out += `--- 方案 ${s} | blocks=${scheme.blocks?.length ?? 0} | timingMs=${Math.round(scheme.timingMs)} | mappingRate=${scheme.mappingRate} | error=${scheme.error || ''} ---\n`;
		(scheme.blocks || []).forEach((b) => {
			const t = b.text.replace(/\s+/g, ' ').slice(0, 100);
			out += `  [${String(b.index).padStart(3, ' ')}][${b.type}] ${t}\n`;
		});
	}
	fs.writeFileSync(path.join(RESULTS_DIR, id + '.digest.txt'), out, 'utf-8');
	console.log('wrote', id + '.digest.txt');
}
