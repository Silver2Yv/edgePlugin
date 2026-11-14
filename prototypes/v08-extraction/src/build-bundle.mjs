import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
	entryPoints: [path.join(__dirname, 'extractor-src', 'main.js')],
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: 'chrome120',
	outfile: path.join(__dirname, 'extractor-bundle.js'),
	logLevel: 'info',
});
console.log('bundled -> src/extractor-bundle.js');
