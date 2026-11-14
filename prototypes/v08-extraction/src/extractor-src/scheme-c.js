import Defuddle from 'defuddle';
import { chunk } from './shared.js';

/**
 * 方案 C（克隆映射）：在克隆文档上运行 Defuddle（它返回的是独立 HTML 字符串，
 * 不保证是原文档的活节点），靠此前统一打好的 data-pd-id 把输出重新解析后，
 * 逐个映射回原始活文档节点；分块器与方案 A/B 相同，只是跑在这棵「已清洗、已映射」
 * 的结果子树上。映射失败的块会被标记，不强行假装映射成功。
 */
export function runSchemeC(liveDoc) {
	const t0 = performance.now();
	const clone = liveDoc.cloneNode(true);
	let result = null;
	let error = null;
	try {
		// debug:true 会让 Defuddle 保留 class/id 与全部 data-* 属性、跳过 div 展平，
		// 这是我们能把它的输出映射回原文档所依赖的前提（见 README「Debug mode」）。
		const defuddle = new Defuddle(clone, { debug: true });
		result = defuddle.parse();
	} catch (e) {
		error = String(e && e.message || e);
	}

	if (!result || !result.content) {
		return {
			scheme: 'C',
			blocks: [],
			timingMs: performance.now() - t0,
			mappingRate: 0,
			error: error || 'Defuddle 未返回内容',
		};
	}

	const parser = new DOMParser();
	const cDoc = parser.parseFromString(result.content, 'text/html');

	// 表单输入值检查（必须为否）：Defuddle 输出里不应出现 input/textarea 的值。
	const leakedFormValue = Array.from(cDoc.querySelectorAll('input[value], textarea'))
		.some((el) => (el.tagName === 'TEXTAREA' ? el.textContent.trim() : el.getAttribute('value')).length > 0);

	const blocks = chunk(cDoc.body, cDoc);

	let mappedBlocks = 0;
	let totalPdIdRefs = 0;
	let resolvedPdIdRefs = 0;
	for (const b of blocks) {
		let resolvedAny = false;
		for (const id of b.pdIds) {
			totalPdIdRefs += 1;
			if (liveDoc.querySelector(`[data-pd-id="${id}"]`)) {
				resolvedPdIdRefs += 1;
				resolvedAny = true;
			}
		}
		b.mappedLive = resolvedAny;
		if (resolvedAny) mappedBlocks += 1;
	}

	const t1 = performance.now();
	return {
		scheme: 'C',
		blocks,
		timingMs: t1 - t0,
		mappingRate: blocks.length ? mappedBlocks / blocks.length : 0,
		pdIdResolveRate: totalPdIdRefs ? resolvedPdIdRefs / totalPdIdRefs : 0,
		leakedFormValue,
		defuddleMeta: { title: result.title, wordCount: result.wordCount },
	};
}
