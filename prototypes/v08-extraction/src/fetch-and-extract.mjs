import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLES } from './sample-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const RESULTS_DIR = path.join(ROOT, 'results');
const BUNDLE_PATH = path.join(__dirname, 'extractor-bundle.js');

fs.mkdirSync(SAMPLES_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const bundleCode = fs.readFileSync(BUNDLE_PATH, 'utf-8');

const ONLY = process.env.V08_ONLY ? process.env.V08_ONLY.split(',') : null;

function nowIso() {
	return new Date().toISOString();
}

async function resolveAndLoad(page, sample) {
	if (sample.localFixture) {
		const fixturePath = path.join(__dirname, 'fixtures', 'readonly-textarea.html');
		const url = 'file://' + fixturePath.replace(/\\/g, '/');
		await page.goto(url, { waitUntil: 'load', timeout: 20000 });
		return { usedUrl: url, note: '本地构造 fixture，非公开网络页面' };
	}

	if (sample.discover) {
		await page.goto(sample.discover.indexUrl, { waitUntil: 'load', timeout: 30000 });
		const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a')).map((a) => a.href));
		const match = hrefs.find((h) => sample.discover.linkPattern.test(h));
		if (!match) throw new Error('discover: 没有在索引页找到匹配链接');
		await page.goto(match, { waitUntil: 'load', timeout: 30000 });
		return { usedUrl: match, note: '从索引页 ' + sample.discover.indexUrl + ' 发现' };
	}

	let lastErr = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		for (const url of sample.candidates) {
			try {
					// 用 domcontentloaded 而不是 load：实测 react.dev / developer.mozilla.org /
					// ocw.mit.edu 等站点在 load 事件上会卡住（某个子资源在本沙箱网络里一直不返回），
					// 但 domcontentloaded 能在 1 秒内完成，后面本来就有 1200ms 的额外等待给 JS 渲染。
				const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
				if (!resp || !resp.ok()) {
					lastErr = new Error('HTTP ' + (resp ? resp.status() : 'no-response'));
					continue;
				}
				if (sample.requireCrossOriginFrame) {
					await page.waitForTimeout(2000);
					const frames = page.frames();
					const mainOrigin = new URL(page.url()).origin;
					const hasCrossOrigin = frames.some((f) => {
						try { return new URL(f.url()).origin !== mainOrigin && f.url() !== 'about:blank'; } catch { return false; }
					});
					if (!hasCrossOrigin) {
						lastErr = new Error('页面没有检测到跨源 iframe');
						continue;
					}
				}
				return { usedUrl: page.url(), note: null };
			} catch (e) {
				lastErr = e;
			}
		}
		if (attempt === 0) await page.waitForTimeout(3000); // 网络抖动重试一次
	}
	throw lastErr || new Error('所有候选 URL 均失败');
}

async function run() {
	const browser = await chromium.launch();
	const index = [];

	for (const sample of SAMPLES) {
		if (ONLY && !ONLY.includes(sample.id)) continue;
		console.log('=== ' + sample.id + ' ===');
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await context.newPage();
		const entry = {
			id: sample.id,
			category: sample.category,
			label: sample.label,
			adversarial: !!sample.adversarial,
			fetchedAt: nowIso(),
			status: 'pending',
		};
		try {
			const { usedUrl, note } = await resolveAndLoad(page, sample);
			entry.url = usedUrl;
			entry.discoverNote = note;
			await page.waitForTimeout(1200);

			const html = await page.content();
			fs.writeFileSync(path.join(SAMPLES_DIR, sample.id + '.html'), html, 'utf-8');
			await page.screenshot({ path: path.join(SAMPLES_DIR, sample.id + '.png'), fullPage: false });

			await page.addScriptTag({ content: bundleCode }).catch(async () => {
				// 部分站点（MDN、GitHub 等）的 CSP 会挡掉新插入的 <script> 标签；
				// 改用 CDP 直接求值（不经过页面的 <script> 加载流程，不受 script-src 限制）。
				await page.evaluate(bundleCode);
			});
			const result = await page.evaluate(() => window.__v08__.runAll());
			fs.writeFileSync(path.join(RESULTS_DIR, sample.id + '.extraction.json'), JSON.stringify(result, null, 2), 'utf-8');

			entry.status = 'ok';
			entry.blockCounts = {
				A: result.A.blocks.length,
				B: result.B.blocks.length,
				C: result.C.blocks.length,
			};
			entry.timingMs = {
				A: Math.round(result.A.timingMs),
				B: Math.round(result.B.timingMs),
				C: Math.round(result.C.timingMs),
			};
			console.log('  OK url=' + usedUrl + ' blocks A/B/C=' + entry.blockCounts.A + '/' + entry.blockCounts.B + '/' + entry.blockCounts.C);
		} catch (e) {
			entry.status = 'failed';
			entry.error = String(e && e.message || e);
			console.log('  FAILED: ' + entry.error);
		}
		index.push(entry);
		await context.close();
	}

	const indexPath = path.join(SAMPLES_DIR, 'index.json');
	let existing = [];
	if (fs.existsSync(indexPath) && ONLY) {
		existing = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
		existing = existing.filter((e) => !index.some((n) => n.id === e.id));
	}
	const merged = [...existing, ...index].sort((a, b) => a.id.localeCompare(b.id));
	fs.writeFileSync(indexPath, JSON.stringify(merged, null, 2), 'utf-8');
	console.log('写入 ' + indexPath);

	await browser.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
