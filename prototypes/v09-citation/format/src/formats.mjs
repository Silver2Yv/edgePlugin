// V-09 第一部分：引用标记候选写法定义 + 解析规则（正则/状态机）+ 对应提示词片段。
//
// 背景（架构 5.7 / 5.9 / 5.10，仅落实为代码，不重新讨论设计）：
//   - 两种引用形式：逐字引用（固定标记包裹，模型逐字摘录原文）；
//     段落编号（每块开头带短编号，总结类要点附来源编号）。
//   - 页面内容要用明确分隔标记包裹并声明是资料，不是指令。
//   - 渲染时引用不做字符串拼接，只接受本次请求块集合内的编号；
//     流式时要能在 token 边界前后稳定识别（不能假设标记一次性完整到达）。
//
// 本文件只定义"写法 + 解析器"，不做网络调用。
// extract(outputText) 返回 Array<{ raw, blockIds: string[], quotedText?: string }>。

/** 解析形如 "b12" / "b12,b5" / "12" / "12,5" 的编号片段为字符串数组（去空白、去重保序）。 */
function splitIds(raw) {
  const seen = new Set();
  const result = [];
  for (const part of raw.split(/[,，、]/)) {
    const id = part.trim().replace(/^b/i, "");
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

// ---------- 写法 1：双方括号编号 [[b12]] / 双方括号包裹逐字引用 [[b12]]...[[/b12]] ----------

const bracketIdNumberRe = /\[\[b([0-9]+(?:\s*[,，、]\s*b?[0-9]+)*)\]\]/gi;
const bracketIdQuoteRe = /\[\[b([0-9]+)\]\]([\s\S]*?)\[\[\/b\1\]\]/gi;

const bracketIdFormat = {
  id: "bracket-id",
  label: "双方括号编号 [[b12]]",
  promptSpec: [
    "引用标记写法：双方括号编号。",
    "- 总结要点：每条要点末尾追加形如 [[b12]] 的标记，12 替换为该要点依据的资料块编号；",
    "  如果同时依据多个块，写成 [[b12,b5]]。",
    "- 逐字引用：把你从资料中逐字摘录的原文片段，用同一对编号包起来，写成",
    "  [[b12]]被逐字摘录的原文片段[[/b12]]，括号内必须是资料原文的连续子串，不能改写、不能省略号拼接。",
    "- 编号必须是本次提供的资料块编号之一，禁止编造资料里不存在的编号。",
  ].join("\n"),
  extract(outputText) {
    const results = [];
    const consumedRanges = [];

    for (const m of outputText.matchAll(bracketIdQuoteRe)) {
      results.push({ raw: m[0], blockIds: splitIds(m[1]), quotedText: m[2] });
      consumedRanges.push([m.index, m.index + m[0].length]);
    }
    for (const m of outputText.matchAll(bracketIdNumberRe)) {
      const start = m.index;
      const end = start + m[0].length;
      const overlapsQuote = consumedRanges.some(([s, e]) => start < e && end > s);
      if (overlapsQuote) continue; // 已被逐字引用形式消费的区间不重复计数
      results.push({ raw: m[0], blockIds: splitIds(m[1]) });
    }
    return results;
  },
};

// ---------- 写法 2：中文全角括号编号 【12】/【12】...【/12】 ----------

const fullwidthNumberRe = /【([0-9]+(?:\s*[,，、]\s*[0-9]+)*)】/g;
const fullwidthQuoteRe = /【([0-9]+)】([\s\S]*?)【\/\1】/g;

const fullwidthBracketFormat = {
  id: "fullwidth-bracket",
  label: "全角括号编号 【12】",
  promptSpec: [
    "引用标记写法：全角方括号编号。",
    "- 总结要点：每条要点末尾追加形如 【12】的标记，12 替换为该要点依据的资料块编号；",
    "  多个块写成 【12,5】。",
    "- 逐字引用：把逐字摘录的原文片段用同一编号前后包住，写成",
    "  【12】被逐字摘录的原文片段【/12】，中间内容必须是资料原文的连续子串，不能改写。",
    "- 编号必须是本次提供的资料块编号之一，禁止编造资料里不存在的编号。",
  ].join("\n"),
  extract(outputText) {
    const results = [];
    const consumedRanges = [];

    for (const m of outputText.matchAll(fullwidthQuoteRe)) {
      results.push({ raw: m[0], blockIds: splitIds(m[1]), quotedText: m[2] });
      consumedRanges.push([m.index, m.index + m[0].length]);
    }
    for (const m of outputText.matchAll(fullwidthNumberRe)) {
      const start = m.index;
      const end = start + m[0].length;
      const overlapsQuote = consumedRanges.some(([s, e]) => start < e && end > s);
      if (overlapsQuote) continue;
      results.push({ raw: m[0], blockIds: splitIds(m[1]) });
    }
    return results;
  },
};

// ---------- 写法 3：类 HTML 属性标签 <cite b="12">...</cite> ----------
// 注意：架构要求 html:false（markdown-it 不解析真实 HTML），这里的 <cite> 只是纯文本标记，
// 靠正则/自定义 inline 规则识别，不依赖浏览器把它当标签解析。
// 既可以包住整条要点文字（总结场景），也可以包住逐字引用原文（问答场景）。

const citeTagRe = /<cite\s+b="([0-9]+(?:\s*[,，、]\s*[0-9]+)*)"\s*>([\s\S]*?)<\/cite>/gi;

const citeTagFormat = {
  id: "cite-tag",
  label: '类 HTML 标签 <cite b="12">',
  promptSpec: [
    '引用标记写法：<cite b="编号">内容</cite> 纯文本标记（不是真的 HTML 标签，照字面原样输出）。',
    '- 总结要点：把整条要点文字包在 <cite b="12">要点内容</cite> 里，12 替换为依据的资料块编号；',
    '  多个块写成 <cite b="12,5">要点内容</cite>。',
    '- 逐字引用：把逐字摘录的原文片段包在 <cite b="12">被逐字摘录的原文片段</cite> 里，',
    "  标签内必须是资料原文的连续子串，不能改写。",
    "- 编号必须是本次提供的资料块编号之一，禁止编造资料里不存在的编号。",
    "- 严禁输出除 <cite ...>...</cite> 之外的其它 HTML 标签。",
  ].join("\n"),
  extract(outputText) {
    const results = [];
    for (const m of outputText.matchAll(citeTagRe)) {
      results.push({ raw: m[0], blockIds: splitIds(m[1]), quotedText: m[2] });
    }
    return results;
  },
};

// ---------- 写法 4：插入符编号 ^12（非包裹，引号包住逐字引用 + 紧跟 ^12） ----------

const caretNumberRe = /\^(?:\[)?([0-9]+(?:\s*[,，、]\s*[0-9]+)*)\]?/g;
// 逐字引用：中文直角引号「...」或英文双引号"..."紧跟 ^12
const caretQuoteRe = /[「"]([\s\S]*?)[」"]\s*\^(?:\[)?([0-9]+(?:\s*[,，、]\s*[0-9]+)*)\]?/g;

const caretIdFormat = {
  id: "caret-id",
  label: "插入符编号 ^12",
  promptSpec: [
    "引用标记写法：插入符编号。",
    "- 总结要点：每条要点末尾追加 ^12，12 替换为依据的资料块编号；多个块写成 ^12,5。",
    "- 逐字引用：先用引号「」把逐字摘录的原文片段整段引起来，引号结束后紧跟 ^12，",
    "  写成 「被逐字摘录的原文片段」^12，引号内必须是资料原文的连续子串，不能改写。",
    "- 编号必须是本次提供的资料块编号之一，禁止编造资料里不存在的编号。",
  ].join("\n"),
  extract(outputText) {
    const results = [];
    const consumedRanges = [];

    for (const m of outputText.matchAll(caretQuoteRe)) {
      results.push({ raw: m[0], blockIds: splitIds(m[2]), quotedText: m[1] });
      consumedRanges.push([m.index, m.index + m[0].length]);
    }
    for (const m of outputText.matchAll(caretNumberRe)) {
      const start = m.index;
      const end = start + m[0].length;
      const overlapsQuote = consumedRanges.some(([s, e]) => start < e && end > s);
      if (overlapsQuote) continue;
      results.push({ raw: m[0], blockIds: splitIds(m[1]) });
    }
    return results;
  },
};

export const CITATION_FORMATS = [
  bracketIdFormat,
  fullwidthBracketFormat,
  citeTagFormat,
  caretIdFormat,
];

export function getFormat(id) {
  const f = CITATION_FORMATS.find((x) => x.id === id);
  if (!f) throw new Error(`未知写法: ${id}`);
  return f;
}
