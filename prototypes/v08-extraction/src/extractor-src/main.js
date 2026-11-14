import { stampPdIds } from './shared.js';
import { runSchemeA } from './scheme-a.js';
import { runSchemeB } from './scheme-b.js';
import { runSchemeC } from './scheme-c.js';

function runAll() {
	stampPdIds(document);
	const a = runSchemeA(document);
	const b = runSchemeB(document);
	const c = runSchemeC(document);
	return { A: a, B: b, C: c };
}

window.__v08__ = { runAll };
