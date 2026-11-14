// V-09 第一部分：裁判评估"该位置支持结论"。
//
// 裁判固定使用 DeepSeek 官方连接 + deepseek-flash 模型（与两个被测对象都不完全相同：
// 对 relay（公司中转站）连接的被测输出存在"同模型不同网络"的重叠，对 deepseek-v4-pro 被测输出
// 是完全独立的模型）。这是本原型阶段的权宜取舍，已在风险里说明，并用人工抽样复核缓解。

const JUDGE_SYSTEM = [
  "你是一个严格的事实核查员。你会看到一段“结论/回答”和一段“资料原文”。",
  "你只需要判断：资料原文是否足以支持这段结论/回答，不需要判断结论本身是否完整或优美。",
  "只用下面三个词之一开头回答，后面可以跟一句不超过20字的简短理由：",
  "支持 / 不支持 / 不确定",
].join("\n");

export function buildJudgeItemForSummary({ claimText, blockText }) {
  return [
    `结论（总结要点）：${claimText}`,
    "",
    `资料原文（被引用的块）：${blockText}`,
    "",
    "判断：这段资料原文是否支持这条结论？",
  ].join("\n");
}

export function buildJudgeItemForQuote({ question, quotedText }) {
  return [
    `问题：${question}`,
    "",
    `被引用的原文片段：${quotedText}`,
    "",
    "判断：这段原文片段是否足以支持回答上面的问题？",
  ].join("\n");
}

/** 解析裁判回复为 'support' | 'not-support' | 'uncertain' | 'unparsed'。 */
export function parseVerdict(judgeOutput) {
  const text = (judgeOutput || "").trim();
  if (text.startsWith("支持")) return "support";
  if (text.startsWith("不支持")) return "not-support";
  if (text.startsWith("不确定")) return "uncertain";
  return "unparsed";
}

export { JUDGE_SYSTEM };
