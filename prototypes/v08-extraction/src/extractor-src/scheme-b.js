import { Readability } from '@mozilla/readability';
import { chunk } from './shared.js';

/**
 * 方案 B（库辅助）：用 Readability 在克隆文档上识别根节点（自定义 serializer 返回 DOM 元素，
 * 不是字符串），再按节点上预先打好的 data-pd-id 把该节点映射回原始活文档，
 * 最后用和方案 A 相同的分块器在活文档上切块——分块逻辑保持一致，只替换「找根节点」这一步，
 * 这样才能单独衡量库的根节点识别质量。
 */
export function runSchemeB(liveDoc) {
	const t0 = performance.now();
	const clone = liveDoc.cloneNode(true);
	let parsed = null;
	let error = null;
	try {
		const reader = new Readability(clone, { serializer: (el) => el });
		parsed = reader.parse();
	} catch (e) {
		error = String(e && e.message || e);
	}

	if (!parsed || !parsed.content) {
		return {
			scheme: 'B',
			rootMethod: 'readability-failed',
			blocks: [],
			timingMs: performance.now() - t0,
			mappingRate: 0,
			error: error || 'Readability 未能返回内容（可能文本太短或结构不符合其阈值）',
		};
	}

	const contentEl = parsed.content; // clone 文档内的元素
	const pdIds = [];
	if (contentEl.getAttribute && contentEl.getAttribute('data-pd-id')) pdIds.push(contentEl.getAttribute('data-pd-id'));
	contentEl.querySelectorAll?.('[data-pd-id]').forEach((d) => pdIds.push(d.getAttribute('data-pd-id')));

	const liveEls = [];
	for (const id of pdIds) {
		const found = liveDoc.querySelector(`[data-pd-id="${id}"]`);
		if (found) liveEls.push(found);
	}
	const mappingRate = pdIds.length ? liveEls.length / pdIds.length : 0;

	if (liveEls.length === 0) {
		return {
			scheme: 'B',
			rootMethod: 'readability-root-unmappable',
			blocks: [],
			timingMs: performance.now() - t0,
			mappingRate: 0,
			error: 'Readability 识别出的根节点在映射回原文档时全部失败（data-pd-id 丢失或根节点为新建 wrapper）',
		};
	}

	// 找 liveEls 在活文档里的最近公共祖先，作为「根节点」。
	function pathToRoot(el) {
		const path = [];
		let cur = el;
		while (cur) { path.unshift(cur); cur = cur.parentElement; }
		return path;
	}
	let commonAncestor = liveEls[0];
	for (let i = 1; i < liveEls.length; i++) {
		const pathA = pathToRoot(commonAncestor);
		const pathB = pathToRoot(liveEls[i]);
		let j = 0;
		let last = liveDoc.body;
		while (j < pathA.length && j < pathB.length && pathA[j] === pathB[j]) {
			last = pathA[j];
			j++;
		}
		commonAncestor = last;
	}

	const blocks = chunk(commonAncestor, liveDoc);
	for (const b of blocks) b.mappedLive = true;
	const t1 = performance.now();
	return {
		scheme: 'B',
		rootMethod: 'readability-root',
		blocks,
		timingMs: t1 - t0,
		mappingRate,
		readabilityTitle: parsed.title,
	};
}
