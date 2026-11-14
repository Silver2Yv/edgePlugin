// 代理命中评估的两个提示词：
// 1) 读者视角：在看不到任何建议的情况下，写出自己最想问的 2 个问题。
// 2) 判别：给定读者的 2 个问题与模型的 3 条建议，判断每条读者问题是否被某条建议命中。

export function buildReaderPrompt(material) {
  const { title, context, selection, lang } = material;
  const marked = context.replace(selection, `【${selection}】`);
  const langLine = lang === 'en'
    ? '原文是英文，请用英文写出你的问题。'
    : '原文是中文，请用中文写出你的问题。';
  const system = `你将扮演一名正在阅读网页的普通读者。你刚刚读完一段正文，并用【】标出了自己划选、准备向 AI 提问的那部分内容。在看到任何 AI 给出的建议问题之前，请写出你自己真正最想问的 2 个问题。
要求：
1. 问题要反映你作为这个领域的普通读者、读到【】里的内容后真实的好奇点或困惑点，可以涉及【】前后的上下文。
2. 不要写"这段话是什么意思"这类泛化问题。
3. 恰好输出 2 行，格式为"1. 问题""2. 问题"，不要有编号之外的文字。
4. ${langLine}`;
  const user = `页面标题：${title}\n\n正文（【】标出你划选的部分）：\n${marked}\n\n请写出你自己最想问的 2 个问题。`;
  return { system, user };
}

export function buildJudgePrompt(readerQuestions, suggestions) {
  const system = `你是语义命中判别员。会给你 2 个真实读者自己想问的问题，以及 AI 系统生成的 3 条建议问题。请判断每条读者问题，是否在语义上被某一条 AI 建议命中——即两者问的是同一个具体点，即使措辞、语言或详略不同也算命中；如果读者问题问的是建议完全没有涉及的点，则算未命中。
请恰好输出 2 行，不要有其他文字：
读者问题1命中：无/1/2/3
读者问题2命中：无/1/2/3`;
  const user =
    `读者问题1：${readerQuestions[0] || ''}\n` +
    `读者问题2：${readerQuestions[1] || ''}\n\n` +
    `AI 建议：\n` +
    `1. ${suggestions[0] || ''}\n` +
    `2. ${suggestions[1] || ''}\n` +
    `3. ${suggestions[2] || ''}`;
  return { system, user };
}
