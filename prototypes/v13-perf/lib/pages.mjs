// V-13 用的本地合成页面：不用真实网站内容。普通文章、大页面、多框架页面。
// 风格与 tests/e2e 里内联合成 HTML 的做法一致（见 ask-flow.spec.ts 的 ARTICLE 常量）。

export const PARAGRAPH = '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。';

/** 普通文章：几段文字，#target 是用来三击选中的那一段 */
export function articlePage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>V-13 普通文章</title></head>
<body><article>
<h1>V-13 性能基线：普通文章</h1>
<p>第一段：这是一篇用于性能测量的合成文章，内容本身无实际意义。</p>
<p id="target">${PARAGRAPH}</p>
<p>第三段：选中上面那段文字，点工具栏里的「问」。</p>
</article></body></html>`;
}

/** 按近似字数重复生成正文段落，凑出一个大页面 */
function fillerParagraphs(count) {
  const sentences = [
    '光合作用是绿色植物利用光能，把二氧化碳和水合成有机物并释放氧气的过程。',
    '细胞呼吸则是把有机物分解释放能量、供生命活动使用的过程，二者方向相反。',
    '叶绿体中的类囊体薄膜上分布着吸收光能的色素分子，主要是叶绿素与类胡萝卜素。',
    '卡尔文循环发生在叶绿体基质中，利用光反应产生的 ATP 与 NADPH 固定二氧化碳。',
    '不同波长的光被叶片吸收的效率不同，绿光大部分被反射，这也是叶片呈绿色的原因。',
  ];
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(`<p>第 ${i + 1} 段：${sentences[i % sentences.length]}（重复第 ${i} 次，用于撑大页面体积。）</p>`);
  }
  return out.join('\n');
}

/**
 * 大页面：约 paragraphCount 段正文（默认 2000 段，约 300–400 KB 文本），
 * #target 放在中间偏后，模拟真实长文里「划到文章下半部分」的情况。
 */
export function largePage(paragraphCount = 2000) {
  const half = Math.floor(paragraphCount / 2);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>V-13 大页面</title></head>
<body><article>
<h1>V-13 性能基线：大页面（约 ${paragraphCount} 段）</h1>
${fillerParagraphs(half)}
<p id="target">${PARAGRAPH}</p>
${fillerParagraphs(paragraphCount - half)}
</article></body></html>`;
}

/** 子框架里的简单正文 */
export function framePage(label) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>
<body><p id="inner">${label}：子框架正文，用于撑起多框架场景，不作为选中目标。</p></body></html>`;
}

/**
 * 多框架页面：顶层 #target 一段可选中正文，外加 N 个 iframe（同源 + 跨源混合）。
 * iframeHosts 是跨源子框架要用的 host 列表（调用方负责用 context.route 让这些 host 也能访问）。
 */
export function multiFramePage(sameOriginCount, iframeHosts) {
  const frames = [];
  for (let i = 0; i < sameOriginCount; i++) {
    frames.push(`<iframe src="/frame-same-${i}" width="400" height="150"></iframe>`);
  }
  for (const host of iframeHosts) {
    frames.push(`<iframe src="https://${host}/frame" width="400" height="150"></iframe>`);
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>V-13 多框架</title></head>
<body>
<h1>V-13 性能基线：多框架（${sameOriginCount + iframeHosts.length} 个子框架）</h1>
<p id="target">${PARAGRAPH}</p>
${frames.join('\n')}
</body></html>`;
}
