import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const RESULTS_DIR = path.join(ROOT, 'results');

function normalize(s) {
	return (s || '').replace(/\s+/g, '').toLowerCase();
}

function loadJsonIfExists(p) {
	return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}

function percentile(arr, p) {
	if (!arr.length) return null;
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

const index = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, 'index.json'), 'utf-8'));
const SCHEMES = ['A', 'B', 'C'];

const perSample = [];
const timingByScheme = { A: [], B: [], C: [] };
const mappingByScheme = { A: [], B: [], C: [] };
const recallByScheme = { A: [], B: [], C: [] };
const distantByScheme = { A: [], B: [], C: [] };
let formLeakAnyC = false;

for (const entry of index) {
	if (entry.status !== 'ok') {
		perSample.push({ id: entry.id, status: entry.status, error: entry.error });
		continue;
	}
	const extraction = loadJsonIfExists(path.join(RESULTS_DIR, entry.id + '.extraction.json'));
	const labels = loadJsonIfExists(path.join(SAMPLES_DIR, entry.id + '.labels.json'));
	const noiseReview = loadJsonIfExists(path.join(RESULTS_DIR, entry.id + '.noise-review.json'));

	const row = { id: entry.id, category: entry.category, adversarial: entry.adversarial, schemes: {} };

	for (const s of SCHEMES) {
		const r = extraction?.[s];
		if (!r) { row.schemes[s] = { missing: true }; continue; }
		const joined = normalize(r.blocks.map((b) => b.text).join('\n'));
		let evidenceFound = 0;
		let evidenceTotal = 0;
		if (labels?.keyEvidence) {
			evidenceTotal = labels.keyEvidence.length;
			for (const ev of labels.keyEvidence) {
				if (joined.includes(normalize(ev.text))) evidenceFound += 1;
			}
		}
		let distant = null;
		if (labels?.distantReference) {
			const defFound = joined.includes(normalize(labels.distantReference.definitionText));
			const refFound = joined.includes(normalize(labels.distantReference.referenceText));
			distant = defFound && refFound ? 1 : 0;
			distantByScheme[s].push(distant);
		}
		if (evidenceTotal > 0) recallByScheme[s].push(evidenceFound / evidenceTotal);
		timingByScheme[s].push(r.timingMs);
		mappingByScheme[s].push(r.mappingRate ?? null);
		if (s === 'C' && r.leakedFormValue) formLeakAnyC = true;

		const noise = noiseReview?.[s];
		row.schemes[s] = {
			blockCount: r.blocks.length,
			timingMs: Math.round(r.timingMs),
			mappingRate: r.mappingRate,
			evidenceFound,
			evidenceTotal,
			distantReferenceOk: distant,
			error: r.error || null,
			leakedFormValue: r.leakedFormValue ?? false,
			noiseRatio: noise ? noise.noiseChars / Math.max(1, noise.totalChars) : null,
			errorClasses: noise?.errorClasses || null,
		};
	}
	perSample.push(row);
}

function summarize(s) {
	const timings = timingByScheme[s].filter((x) => typeof x === 'number');
	const mappings = mappingByScheme[s].filter((x) => typeof x === 'number');
	const recalls = recallByScheme[s];
	const distants = distantByScheme[s];
	return {
		scheme: s,
		samplesWithTiming: timings.length,
		timingP50Ms: percentile(timings, 50),
		timingP95Ms: percentile(timings, 95),
		meanMappingRate: mappings.length ? mappings.reduce((a, b) => a + b, 0) / mappings.length : null,
		meanEvidenceRecall: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
		distantReferenceRecall: distants.length ? distants.reduce((a, b) => a + b, 0) / distants.length : null,
		distantReferenceSamples: distants.length,
	};
}

const summary = { A: summarize('A'), B: summarize('B'), C: summarize('C'), formLeakObservedInC: formLeakAnyC };

fs.writeFileSync(path.join(RESULTS_DIR, 'metrics-summary.json'), JSON.stringify({ summary, perSample }, null, 2), 'utf-8');
console.log(JSON.stringify(summary, null, 2));
