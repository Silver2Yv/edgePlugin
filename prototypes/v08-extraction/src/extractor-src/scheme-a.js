import { findRootBySemanticOrDensity, chunk } from './shared.js';

/** 方案 A（自研）：语义标签 -> 文本密度评分 -> body；直接在活文档上分块。 */
export function runSchemeA(doc) {
	const t0 = performance.now();
	const { root, method } = findRootBySemanticOrDensity(doc);
	const blocks = chunk(root, doc);
	const t1 = performance.now();
	// A 直接操作活文档，映射恒成功（见 shared.js 顶部说明）。
	for (const b of blocks) b.mappedLive = true;
	return {
		scheme: 'A',
		rootMethod: method,
		blocks,
		timingMs: t1 - t0,
		mappingRate: blocks.length ? 1 : 0,
	};
}
