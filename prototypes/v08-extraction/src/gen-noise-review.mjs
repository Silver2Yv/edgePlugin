// 噪声块判定：用一组明确的"页面 chrome / 导航 / 广告 / 页脚 / UI 元信息"正则，
// 对每个样本每种方案命中的块求和，噪声比例 = 命中字符数 / 该方案总字符数。
// 规则本身和命中明细可复核：node src/gen-noise-review.mjs --audit 会打印每个样本每方案的命中块。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const AUDIT = process.argv.includes('--audit');

// 通用噪声模式（全站适用）
const COMMON = [
	/^Advertisement$/i,
	/^Sponsored$/i,
	/^View on GitHub$/i,
	/^Help improve MDN$/i,
	/^This page was last modified on /i,
	/^View this page on GitHub/,
	/^帮助改进 MDN$/,
	/^此页面最后更新于 /,
	/^在 GitHub 上查看此页面/,
	/^Published: .*Last Updated: /,
	/^HISTORY\.com Editors$/,
	/^Keystone\/Getty Images$/,
	/^The National Archive$/,
	/^MPI\/Getty Images$/,
	/^Epics\/Getty Images$/,
	/^Time Life Pictures/,
	/^AP Photo/,
	/^TABLE OF CONTENTS$/,
	/Copyright Policy|Cookie Notice|Ad Choices|Terms of Use/,
	/^Skip to main content$/i,
	/^Report a problem/,
];

// 按样本补充的噪声模式（在通用模式之外，针对该站点的导航/页脚/widget）
const PER_SAMPLE = {
	'arxiv-abs': [
		/^(Connected Papers|Litmaps|scite|Which authors of this paper are endorsers)/,
		/^\[Submitted on /,
	],
	'github-readme': [
		/^(Latest commit|History|Branches|Tags|\d[\d,]* Commits)$/,
		/^(About|Resources|Activity|Stars|Watchers|Forks|Report repository|Releases|Sponsor this project|Contributors|Languages|Repository files navigation|Folders and files|Custom properties)$/,
		/^(Authors|Release history|Packages|Used by|Contributors)/,
		/^\+ \d+ contributors$/,
		/^(MIT license|Security policy|Contributing|Code of conduct|vuejs\.org\/?)$/,
		/^Name \| Name \| Last commit message/,
		/^(Stars|Watchers|Forks)$/,
		/^[\d.]+k? stars$/,
		/^\d+ watching$/,
		/^[\d.]+k? forks$/,
		/^[\d,]+ Branches/,
		/^- opencollective\.com/,
		/^- TypeScript|^- JavaScript|^- Other/,
	],
	'github-code-ref': [/^(Latest commit|History|Branches|Tags|About|Resources|Stars|Watchers|Forks)/, /lines? \(\d+ loc\)/],
	'github-code-argparse': [/^(Latest commit|History|Branches|Tags|About|Resources|Stars|Watchers|Forks)/, /lines? \(\d+ loc\)/],
	'formula-zh': [
		/^网页新闻贴吧知道网盘图片视频地图文库资讯采购百科$/,
		/^播报 编辑 讨论/,
		/^历史上的今天/,
		/^懂啦 秒懂本尊答/,
		/^动态百科 数字博物馆/,
		/^史记2025/,
		/^举报不良信息/,
		/^©2026 Baidu/,
		/^京公网安备/,
		/^编辑次数：/,
		/^浏览次数：/,
		/^最近更新：/,
		/^什么是权威编辑$/,
	],
	'zh-article-918': null, // 复用 formula-zh 的百度模式
	'zh-article-xian': null,
	'tabs-bootstrap': [/^Design and Development tips in your inbox/, /ads via Carbon/, /^View on GitHub$/],
	'katex-docs': [/^Support Table$/],
	'doc-python': [/^(Footnotes|\d+\.\d+\. )?$/],
	'listing-hn': [/^authored by /],
	'listing-ruanyifeng-index': [/^Email: /i],
	'adv-login-wall': [/^TraceID: /],
};

const BAIDU = [
	/^网页新闻贴吧知道网盘图片视频地图文库资讯采购百科$/,
	/^播报 编辑 讨论/,
	/^历史上的今天/,
	/^懂啦 秒懂本尊答/,
	/^动态百科 数字博物馆/,
	/^史记2025/,
	/^举报不良信息/,
	/^©2026 Baidu/,
	/^京公网安备/,
	/^编辑次数：/,
	/^浏览次数：/,
	/^最近更新：/,
	/^什么是权威编辑$/,
];
PER_SAMPLE['zh-article-918'] = BAIDU;
PER_SAMPLE['zh-article-xian'] = BAIDU;

// 结构性错误分类（根节点误选/欠抽取/完全失败/原子性破坏/粒度塌陷/可见性违规）是定性判断，
// 不是从噪声比例算出来的，来自逐样本人工核对 results/<id>.extraction.json 的块内容
// （见 RESULT.md 第 5 节的具体依据）；这里按方案补充到噪声比例之外，两者可以同时成立。
const STRUCTURAL = {
	'en-longform-pearlharbor': { B: ['under-extraction'] },
	'en-longform-pg': { A: ['granularity-collapse'], B: ['granularity-collapse'], C: ['total-extraction-failure'] },
	'formula-en': { A: ['root-mis-selection', 'total-extraction-failure'], B: ['root-mis-selection', 'total-extraction-failure'] },
	'github-code-argparse': { A: ['root-mis-selection', 'total-extraction-failure'], B: ['root-mis-selection', 'total-extraction-failure'], C: ['atomicity-violation'] },
	'github-code-ref': { A: ['root-mis-selection', 'total-extraction-failure'], B: ['root-mis-selection', 'total-extraction-failure'], C: ['atomicity-violation'] },
	'github-readme': { A: ['root-mis-selection'] },
	'iframe-cross-origin': { A: ['root-mis-selection', 'total-extraction-failure'], B: ['under-extraction'] },
	'listing-hn': { A: ['granularity-collapse'], B: ['total-extraction-failure', 'under-extraction'], C: ['granularity-collapse', 'under-extraction'] },
	'listing-ruanyifeng-index': { C: ['under-extraction'] },
	'table-heavy': { A: ['granularity-collapse'], B: ['granularity-collapse'], C: ['granularity-collapse'] },
	'doc-vue-tabs': { C: ['visibility-violation'] },
	'adv-forum-thread': { B: ['total-extraction-failure'] },
};

// 这几个 方案/样本 组合经逐块人工核对（RESULT.md 第 5 节），确认输出的全部内容都是
// 跟目标正文无关的 chrome/弹窗（不是零星几个块），直接记 100% 噪声，不依赖正则覆盖率。
const FULL_NOISE = {
	'github-code-ref': ['A', 'B'],
	'github-code-argparse': ['A', 'B'],
	'iframe-cross-origin': ['A'],
};

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'index.json'), 'utf-8'));

function isNoise(text, patterns) {
	const t = text.trim();
	return patterns.some((re) => re.test(t));
}

for (const entry of index) {
	if (entry.status !== 'ok') continue;
	const id = entry.id;
	const extra = PER_SAMPLE[id] || [];
	const patterns = [...COMMON, ...extra];
	const extraction = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, id + '.extraction.json'), 'utf-8'));
	const out = {};
	for (const s of ['A', 'B', 'C']) {
		const blocks = extraction[s]?.blocks || [];
		const totalChars = blocks.reduce((a, b) => a + b.text.length, 0);
		const forceFull = FULL_NOISE[id]?.includes(s);
		const hit = forceFull ? blocks : blocks.filter((b) => isNoise(b.text, patterns));
		const noiseChars = forceFull ? totalChars : hit.reduce((a, b) => a + b.text.length, 0);
		const ratio = totalChars ? noiseChars / totalChars : 0;
		const errorClasses = [];
		if (ratio >= 0.05) errorClasses.push('boilerplate-noise');
		const structural = STRUCTURAL[id]?.[s];
		if (structural) errorClasses.push(...structural);
		if (!errorClasses.length) errorClasses.push('none');
		out[s] = { totalChars, noiseChars, errorClasses };
		if (AUDIT && (hit.length || ratio > 0.01)) {
			console.log(`\n=== ${id} / ${s} === total=${totalChars} noise=${noiseChars} (${(ratio * 100).toFixed(1)}%) blocks=${blocks.length}`);
			hit.slice(0, 14).forEach((b) => console.log('   HIT', b.text.length, JSON.stringify(b.text.slice(0, 70))));
			if (hit.length > 14) console.log(`   ... ${hit.length - 14} more hits`);
		}
	}
	fs.writeFileSync(path.join(RESULTS_DIR, id + '.noise-review.json'), JSON.stringify(out, null, 2), 'utf-8');
}
console.log(AUDIT ? '\n(audit mode, 文件已写入)' : 'done: noise-review 已按块级规则重算');
