// 复制自 prototypes/suggest-hit/scripts/lib/prompt.mjs，保持两边一致。
// 建议提示词：两个变体。
// A（selection_only）：只给划选内容 + 页面标题。
// B（selection_context）：划选内容 + 前后各至多 3 段上下文 + 页面标题。
//
// 输出格式：恰好 3 行，"1. "/"2. "/"3. " 开头，便于流式时判断"第一条建议完整可显示"的时刻
// （第一条之后出现换行即可判定完整）。

const SYSTEM_PROMPT = `你是一个浏览器扩展里的问题建议生成器。用户在网页上划选了一段文字，即将点击"问"按钮向 AI 提问。你的任务是在用户开口之前，推测用户最可能想问的 3 个具体问题。

要求：
1. 每个问题必须点名引用内容里具体的词语、数字、人名、代码标识符或术语，不能是空泛的问题。
2. 不要出现类似"这段话是什么意思""这是什么"这种和点击"解释"按钮重复的泛化问题。
3. 恰好输出 3 行，每行一个问题，格式为"1. 问题""2. 问题""3. 问题"，不要有编号之外的其他文字、前言、总结或 markdown 标记。
4. 问题所用语言要和用户划选内容的语言一致（划选内容是中文就用中文提问，是英文就用英文提问）。
5. 三条问题不要互相重复，尽量覆盖不同角度（是什么/为什么/后续影响等）。`;

function splitParagraphs(text) {
  return text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
}

/**
 * 从 context 中定位 selection 所在段落，取其前后各至多 maxEach 段。
 */
function extractAround(context, selection, maxEach = 3) {
  const idx = context.indexOf(selection);
  if (idx === -1) {
    // 理论上不会发生（materials.json 已校验），兜底返回全文切段
    const paras = splitParagraphs(context);
    return { before: paras.slice(0, maxEach), after: paras.slice(-maxEach) };
  }
  const before = context.slice(0, idx);
  const after = context.slice(idx + selection.length);
  const beforeParas = splitParagraphs(before).slice(-maxEach);
  const afterParas = splitParagraphs(after).slice(0, maxEach);
  return { before: beforeParas, after: afterParas };
}

export function buildPrompt(material, variant) {
  const { title, selection, context, lang } = material;
  const langLine = lang === 'en'
    ? '本页语言为英文，请务必用英文输出 3 个问题。'
    : '本页语言为中文，请务必用中文输出 3 个问题。';
  let userContent;
  if (variant === 'selection_only') {
    userContent = `页面标题：${title}\n${langLine}\n\n用户划选的内容：\n${selection}\n\n请给出 3 个问题。`;
  } else if (variant === 'selection_context') {
    const { before, after } = extractAround(context, selection, 3);
    const beforeText = before.length ? before.join('\n\n') : '（无更多前文）';
    const afterText = after.length ? after.join('\n\n') : '（无更多后文）';
    userContent =
      `页面标题：${title}\n${langLine}\n\n` +
      `用户划选内容之前的上下文：\n${beforeText}\n\n` +
      `【用户划选的内容】\n${selection}\n\n` +
      `用户划选内容之后的上下文：\n${afterText}\n\n` +
      `请给出 3 个问题。`;
  } else {
    throw new Error(`未知变体: ${variant}`);
  }
  return {
    system: SYSTEM_PROMPT,
    user: userContent
  };
}

export const VARIANTS = ['selection_only', 'selection_context'];
