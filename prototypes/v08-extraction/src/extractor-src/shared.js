// 三种抽取方案共用的可见性规则与分块器。
// 依据 docs/架构设计/ARCHITECTURE.md 5.6：
//   - 语义折叠容器（未展开 details / aria-expanded=false）里的内容算「读」，
//     即使同时被样式隐藏，也按语义容器判定为读（冲突时的规则）。
//   - display:none / visibility:hidden / [hidden] 的其余子树算「不读」。
//   - 代码块、表格、公式整体保留为一个上下文单元；公式优先取 LaTeX 源。
//   - 表单输入值一律不读（M6）：skip 列表直接排除 form/input/textarea/select。

export const SKIP_SELECTOR = [
	'nav', 'header', 'footer', 'form', 'script', 'style', 'noscript', 'template',
	'button', 'input', 'textarea', 'select', 'iframe',
	'[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
	'[aria-hidden="true"]',
].join(',');

const NOISE_CLASS_HINT = /(^|[\s_-])(comment|comments|advert|ads|sidebar|promo|subscribe|newsletter|related|recommend|breadcrumb|pagination|share|social|cookie|banner|masthead)([\s_-]|$)/i;

export function isInsideSemanticCollapsed(el) {
	let cur = el;
	while (cur) {
		if (cur.tagName === 'DETAILS' && !cur.open) return true;
		if (cur.getAttribute && cur.getAttribute('aria-expanded') === 'false') return true;
		cur = cur.parentElement;
	}
	return false;
}

export function isVisible(el) {
	if (!el || el.nodeType !== 1) return false;
	if (el.hasAttribute('hidden')) {
		return isInsideSemanticCollapsed(el);
	}
	let style;
	try {
		style = getComputedStyle(el);
	} catch {
		return true;
	}
	if (style.display === 'none' || style.visibility === 'hidden') {
		return isInsideSemanticCollapsed(el);
	}
	return true;
}

export function looksLikeNoiseContainer(el) {
	const cls = (el.className && typeof el.className === 'string') ? el.className : '';
	const id = el.id || '';
	return NOISE_CLASS_HINT.test(cls) || NOISE_CLASS_HINT.test(id);
}

export function textLen(el) {
	const t = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
	return t.replace(/\s+/g, '').length;
}

/** 找正文根节点：语义标签优先 -> 文本密度评分 -> body（5.6 第 1 步）。 */
export function findRootBySemanticOrDensity(doc) {
	const semanticCandidates = [
		...doc.querySelectorAll('article'),
		...doc.querySelectorAll('main'),
		...doc.querySelectorAll('[role="main"]'),
	].filter((el) => isVisible(el) && textLen(el) > 200);
	if (semanticCandidates.length > 0) {
		semanticCandidates.sort((a, b) => textLen(b) - textLen(a));
		return { root: semanticCandidates[0], method: 'semantic-tag' };
	}

	const candidates = Array.from(doc.querySelectorAll('div, section, td'));
	let best = null;
	let bestScore = -Infinity;
	for (const el of candidates) {
		if (!isVisible(el)) continue;
		if (looksLikeNoiseContainer(el)) continue;
		const len = textLen(el);
		if (len < 140) continue;
		const pCount = el.querySelectorAll(':scope p, :scope > p').length || el.querySelectorAll('p').length;
		const links = Array.from(el.querySelectorAll('a'));
		const linkLen = links.reduce((s, a) => s + ((a.innerText || a.textContent || '').replace(/\s+/g, '').length), 0);
		const density = 1 - Math.min(1, linkLen / Math.max(len, 1));
		let depth = 0;
		let p = el;
		while (p) { depth++; p = p.parentElement; }
		const score = (len * density * (1 + Math.min(pCount, 12) * 0.15)) / (1 + depth * 0.05);
		if (score > bestScore) {
			bestScore = score;
			best = el;
		}
	}
	if (best) return { root: best, method: 'text-density' };
	return { root: doc.body, method: 'fallback-body' };
}

function headingLevel(tag) {
	const m = /^H([1-6])$/.exec(tag);
	return m ? Number(m[1]) : null;
}

function isFormulaBlockEl(el) {
	if (!el.matches) return false;
	if (el.matches('.katex-display, .MathJax_Display, math[display="block"], .mwe-math-element, annotation-xml')) return true;
	// Defuddle 把公式标准化成 <math data-latex="..."> MathML；块级（非行内）的判定是
	// 它没有被包在段落/列表项/单元格里（Defuddle 的 flatten 会把独立公式提到外层）。
	if (el.tagName === 'MATH' && el.hasAttribute('data-latex') && !el.closest('p,li,td,span,dd,dt')) return true;
	return el.tagName === 'MATH' && !el.closest('p,li,td,span');
}

function extractFormulaSource(el) {
	if (el.hasAttribute && el.hasAttribute('data-latex')) return el.getAttribute('data-latex').trim();
	const tex = el.querySelector?.('annotation[encoding="application/x-tex"]');
	if (tex) return tex.textContent.trim();
	const mathTexScript = el.querySelector?.('script[type="math/tex"]');
	if (mathTexScript) return mathTexScript.textContent.trim();
	return (el.innerText || el.textContent || '').trim();
}

function serializeTable(tableEl) {
	const rows = Array.from(tableEl.querySelectorAll('tr'));
	return rows.slice(0, 200).map((tr) => {
		const cells = Array.from(tr.querySelectorAll('th,td'));
		return cells.map((c) => (c.innerText || c.textContent || '').trim().replace(/\s+/g, ' ')).join(' | ');
	}).join('\n');
}

function serializeList(listEl) {
	const items = Array.from(listEl.children).filter((c) => c.tagName === 'LI');
	return items.map((li) => '- ' + (li.innerText || li.textContent || '').trim().replace(/\s+/g, ' ')).join('\n');
}

function getPdId(el) {
	return el.getAttribute ? el.getAttribute('data-pd-id') : null;
}

function collectDescendantPdIds(el) {
	const ids = [];
	if (getPdId(el)) ids.push(getPdId(el));
	if (el.querySelectorAll) {
		el.querySelectorAll('[data-pd-id]').forEach((d) => ids.push(getPdId(d)));
	}
	return ids;
}

const INLINE_TAGS = new Set(['SPAN', 'A', 'B', 'I', 'EM', 'STRONG', 'BR', 'SUP', 'SUB', 'CODE', 'IMG', 'SMALL', 'U', 'MARK', 'ABBR', 'TIME', 'WBR']);

/**
 * 很多中文站点（百度百科、不少 CMS）不用 <p> 做段落，而是用 <div class="para"> 之类的
 * 容器包一段纯文本/行内元素。只认 <p> 会在这些站点上系统性漏正文（已实测确认：
 * 百度百科「九一八事变」词条三种方案都只抽到标题/表格/列表，正文段落全部丢失）。
 * 补一条通用、不针对具体站点的规则：子元素全是行内标签（或没有子元素）、且有实质
 * 文本的容器，也按段落处理——这和 Readability 等库内部判断「是不是一段文字」的
 * 思路是一致的，不是为了迁就某一个站点加特例。
 */
function isLeafTextBlock(el) {
	const children = Array.from(el.children);
	if (children.length === 0) return textLen(el) > 0;
	return children.every((c) => INLINE_TAGS.has(c.tagName));
}

/**
 * 在给定根节点（必须位于某个可计算样式的 document 内，供可见性判断使用）上分块。
 * 返回有序块列表，每块含编号、类型、标题层级、文本、标题链、来源 pdId 集合。
 */
export function chunk(root, doc) {
	const blocks = [];
	const headingTrail = [];
	let index = 0;

	function pushBlock(type, el, text, extra) {
		const t = (text || '').trim();
		if (!t) return;
		index += 1;
		blocks.push({
			index,
			type,
			text: t,
			headingTrail: headingTrail.slice(),
			pdIds: collectDescendantPdIds(el),
			tag: el.tagName,
			...extra,
		});
	}

	function walk(el) {
		if (!el || el.nodeType !== 1) return;
		if (el.matches && el.matches(SKIP_SELECTOR)) return;
		if (!isVisible(el)) return;
		if (looksLikeNoiseContainer(el)) return;

		const tag = el.tagName;
		const lvl = headingLevel(tag);
		if (lvl) {
			while (headingTrail.length && headingTrail[headingTrail.length - 1].level >= lvl) headingTrail.pop();
			const text = (el.innerText || el.textContent || '').trim();
			pushBlock('heading', el, text, { headingLevel: lvl });
			headingTrail.push({ level: lvl, text });
			return;
		}
		if (tag === 'UL' || tag === 'OL') {
			pushBlock('list', el, serializeList(el));
			return;
		}
		if (tag === 'TABLE') {
			pushBlock('table', el, serializeTable(el));
			return;
		}
		if (tag === 'PRE') {
			pushBlock('code', el, el.innerText || el.textContent || '');
			return;
		}
		if (tag === 'BLOCKQUOTE') {
			pushBlock('quote', el, el.innerText || el.textContent || '');
			return;
		}
		if (isFormulaBlockEl(el)) {
			pushBlock('formula', el, extractFormulaSource(el));
			return;
		}
		if (tag === 'P' || tag === 'FIGCAPTION' || tag === 'DD') {
			pushBlock('paragraph', el, el.innerText || el.textContent || '');
			return;
		}
		if ((tag === 'DIV' || tag === 'SECTION') && isLeafTextBlock(el) && textLen(el) > 6 && textLen(el) < 3000) {
			// 上限 3000 字符：避免「子元素全是行内标签」这条规则在深度嵌套的行内结构
			// （典型如 KaTeX 把整页公式表渲染成层层嵌套的 <span>）上把整页文本吞成一个
			// 巨块。超过上限的情况直接跳过、不再分块——这是已知的保守取舍，不是修复，
			// 见 RESULT.md 对该边界的说明。
			pushBlock('paragraph', el, el.innerText || el.textContent || '');
			return;
		}

		for (const child of Array.from(el.children)) walk(child);
	}

	walk(root);
	return blocks;
}

export function stampPdIds(doc) {
	let n = 0;
	doc.querySelectorAll('*').forEach((el) => {
		if (!el.hasAttribute('data-pd-id')) {
			el.setAttribute('data-pd-id', 'pd' + (n++));
		}
	});
}
