// V-09 第一部分：主实验运行器。
// 真实调用两个模型接口，按「写法 × 模型 × 任务类型」收集数据，计算各项比率，
// 做裁判评估 + 流式解析稳定性测试，把原始响应存到 results-raw/（已 gitignore），
// 汇总数据存到 results/（会随结果一起看）。

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CITATION_FORMATS } from "./formats.mjs";
import { SAMPLES } from "./samples.mjs";
import { chunkIntoBlocks } from "./chunk.mjs";
import { buildSummaryPrompt, buildQuotePrompt } from "./prompts.mjs";
import { callModelWithRetry, runWithConcurrency } from "./api-client.mjs";
import { replayStability } from "./stream-replay.mjs";
import { buildJudgeItemForSummary, buildJudgeItemForQuote, parseVerdict, JUDGE_SYSTEM } from "./judge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RAW_DIR = join(ROOT, "results-raw");
const RESULTS_DIR = join(ROOT, "results");
mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(RESULTS_DIR, { recursive: true });

const REPS_PER_TASK_PER_CELL = Number(process.env.V09_REPS ?? 18); // 每格每种任务次数，默认 18（+18 问答 = 36/格）
const CONCURRENCY = 3;

const CONNECTION_LABELS = {
  relay: "公司中转站（VPN）/ deepseek-flash",
  deepseek: "DeepSeek 官方 / deepseek-v4-pro",
};

function normalizeWhitespace(s) {
  return (s || "").replace(/\s+/g, "").trim();
}

function isVerbatimSubstring(quoted, blockText) {
  return normalizeWhitespace(blockText).includes(normalizeWhitespace(quoted));
}

const TRIGGER_RE = {
  "bracket-id": /\[\[/,
  "fullwidth-bracket": /【/,
  "cite-tag": /<cite/i,
  "caret-id": /\^[0-9]|[「"][\s\S]*?[」"]\s*\^/,
};

// ---------- 1. 构造任务列表 ----------

const ALL_QA = [];
for (const s of SAMPLES) for (const qa of s.qaPairs) ALL_QA.push({ sample: s, qa });

const connections = ["relay", "deepseek"];
const genTasks = [];
for (const format of CITATION_FORMATS) {
  for (const connection of connections) {
    for (let i = 0; i < REPS_PER_TASK_PER_CELL; i++) {
      const sample = SAMPLES[i % SAMPLES.length];
      const blocks = chunkIntoBlocks(sample.text);
      genTasks.push({ format, connection, taskType: "summary", sample, blocks, repIndex: i });
    }
    for (let i = 0; i < REPS_PER_TASK_PER_CELL; i++) {
      const { sample, qa } = ALL_QA[i % ALL_QA.length];
      const blocks = chunkIntoBlocks(sample.text);
      genTasks.push({ format, connection, taskType: "quote", sample, blocks, question: qa.question, expected: qa, repIndex: i });
    }
  }
}

console.log(`[生成阶段] 总任务数: ${genTasks.length}（每格 ${REPS_PER_TASK_PER_CELL * 2} 次，并发 ${CONCURRENCY}）`);

// V09_REPLAY_GEN=1：复用上一次已经落盘的 results-raw/gen-XXXX.json，不重新调用模型
// （任务列表的生成逻辑/顺序未变时，idx 与上一次一一对应）。用于只改裁判阶段逻辑后
// 重新计算汇总指标，避免重复花钱重跑生成阶段。
const REPLAY_GEN = process.env.V09_REPLAY_GEN === "1";

let genDone = 0;
const genJobs = genTasks.map((t, idx) => async () => {
  let result;
  if (REPLAY_GEN) {
    const cached = JSON.parse(readFileSync(join(RAW_DIR, `gen-${String(idx).padStart(4, "0")}.json`), "utf8"));
    result = { ok: cached.ok, content: cached.content, error: cached.error, attempts: cached.attempts, raw: { usage: cached.usage } };
  } else {
    const { system, user } = t.taskType === "summary"
      ? buildSummaryPrompt(t.format, t.blocks)
      : buildQuotePrompt(t.format, t.blocks, t.question);
    result = await callModelWithRetry(t.connection, { system, user, maxTokens: 2000 }, { retries: 2 });
  }
  genDone++;
  if (genDone % 20 === 0 || genDone === genTasks.length) {
    console.log(`[生成阶段] 进度 ${genDone}/${genTasks.length}`);
  }
  const rawRecord = {
    idx,
    formatId: t.format.id,
    connection: t.connection,
    taskType: t.taskType,
    sampleId: t.sample.id,
    question: t.question ?? null,
    blockCount: t.blocks.length,
    ok: result.ok,
    content: result.ok ? result.content : null,
    error: result.ok ? null : result.error,
    attempts: result.attempts,
    usage: result.ok ? result.raw?.usage ?? null : null,
  };
  writeFileSync(join(RAW_DIR, `gen-${String(idx).padStart(4, "0")}.json`), JSON.stringify(rawRecord, null, 2));
  return { task: t, result };
});

const genOutcomes = await runWithConcurrency(genJobs, CONCURRENCY);

// ---------- 2. 逐条计算机械指标（格式遵守 / 编造率 / 逐字准确率 / 命中人工标注块） ----------

const items = []; // 扁平化每条"引用标记"的记录，供聚合统计
const responseRecords = []; // 每次生成的响应级记录（供裁判与人工复核取样）

for (const { task: t, result } of genOutcomes) {
  const cellKey = `${t.format.id}__${t.connection}`;
  const sentBlockIds = new Set(t.blocks.map((b) => String(b.id)));
  const blockTextById = new Map(t.blocks.map((b) => [String(b.id), b.text]));

  if (!result.ok) {
    responseRecords.push({ cellKey, task: t, ok: false, citations: [] });
    continue;
  }

  const citations = t.format.extract(result.content);
  const triggerPresent = TRIGGER_RE[t.format.id].test(result.content);
  const formatFollowed = citations.length > 0;
  const attemptedButMalformed = !formatFollowed && triggerPresent;

  const citationRecords = citations.map((c) => {
    const validIds = c.blockIds.filter((id) => sentBlockIds.has(id));
    const fabricatedIds = c.blockIds.filter((id) => !sentBlockIds.has(id));
    const fabricated = fabricatedIds.length > 0 || c.blockIds.length === 0;
    // 逐字准确率只对"问答逐字引用"任务有意义：cite-tag 写法在总结任务里也会把
    // （有意改写的）要点文字包进同一个标记，这不是逐字引用，不能用同一把尺子判断。
    const isVerbatimCheckApplicable = t.taskType === "quote" && c.quotedText !== undefined;
    let verbatimOk = null;
    if (isVerbatimCheckApplicable && validIds.length > 0) {
      verbatimOk = validIds.some((id) => isVerbatimSubstring(c.quotedText, blockTextById.get(id)));
    }
    const locatable = !fabricated && (!isVerbatimCheckApplicable || verbatimOk === true);
    return { ...c, fabricated, verbatimOk, locatable, isVerbatimCheckApplicable };
  });

  for (const c of citationRecords) {
    items.push({
      cellKey,
      formatId: t.format.id,
      connection: t.connection,
      taskType: t.taskType,
      isQuoteCitation: c.isVerbatimCheckApplicable,
      fabricated: c.fabricated,
      verbatimOk: c.verbatimOk,
      locatable: c.locatable,
    });
  }

  const hitExpectedBlock = t.taskType === "quote" && t.expected
    ? citationRecords.some((c) => c.blockIds.includes(String(t.expected.expectedBlockId)))
    : null;

  responseRecords.push({
    cellKey,
    task: t,
    ok: true,
    content: result.content,
    citations: citationRecords,
    formatFollowed,
    attemptedButMalformed,
    hitExpectedBlock,
  });
}

// ---------- 3. 裁判阶段："该位置支持结论"（每条响应取第一个可定位的引用） ----------

function findClaimLine(outputText, raw) {
  const lines = outputText.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => l.includes(raw));
  if (!line) return outputText.slice(0, 200);
  return line.replace(raw, "").trim() || line;
}

const judgeTasks = [];
for (const r of responseRecords) {
  if (!r.ok || !r.formatFollowed) continue;
  const firstLocatable = r.citations.find((c) => c.locatable);
  if (!firstLocatable) continue;

  const blockTextById = new Map(r.task.blocks.map((b) => [String(b.id), b.text]));
  const primaryBlockText = blockTextById.get(firstLocatable.blockIds[0]);

  if (r.task.taskType === "summary") {
    // cite-tag 这种"整条要点都包进标记里"的写法，raw 本身就含要点正文，
    // 这时直接用 quotedText（标记内的文字）做结论文本；其它写法的标记只是
    // 挂在要点末尾的短编号，raw 里不含正文，用"整行减去 raw"还原要点文字。
    const claimText = firstLocatable.quotedText !== undefined
      ? firstLocatable.quotedText
      : findClaimLine(r.content, firstLocatable.raw);
    judgeTasks.push({
      responseRef: r,
      citation: firstLocatable,
      user: buildJudgeItemForSummary({ claimText, blockText: primaryBlockText }),
    });
  } else {
    const quotedText = firstLocatable.quotedText ?? primaryBlockText;
    judgeTasks.push({
      responseRef: r,
      citation: firstLocatable,
      user: buildJudgeItemForQuote({ question: r.task.question, quotedText }),
    });
  }
}

console.log(`[裁判阶段] 待裁判条目: ${judgeTasks.length}`);

let judgeDone = 0;
const judgeJobs = judgeTasks.map((jt, idx) => async () => {
  const result = await callModelWithRetry(
    "deepseek",
    { system: JUDGE_SYSTEM, user: jt.user, maxTokens: 600, modelOverride: "deepseek-flash" },
    { retries: 2 },
  );
  judgeDone++;
  if (judgeDone % 30 === 0 || judgeDone === judgeTasks.length) {
    console.log(`[裁判阶段] 进度 ${judgeDone}/${judgeTasks.length}`);
  }
  const verdict = result.ok ? parseVerdict(result.content) : "call-failed";
  const record = {
    idx,
    cellKey: jt.responseRef.cellKey,
    taskType: jt.responseRef.taskType,
    judgeInput: jt.user,
    judgeOutputRaw: result.ok ? result.content : result.error,
    verdict,
  };
  writeFileSync(join(RAW_DIR, `judge-${String(idx).padStart(4, "0")}.json`), JSON.stringify(record, null, 2));
  return record;
});

const judgeResults = await runWithConcurrency(judgeJobs, CONCURRENCY);

// ---------- 4. 流式解析稳定性：对每种写法，用若干条真实响应文本做随机 chunk 边界重放 ----------

const streamingResults = {};
for (const format of CITATION_FORMATS) {
  const sampleTexts = responseRecords
    .filter((r) => r.ok && r.cellKey.startsWith(format.id + "__") && r.citations.length > 0)
    .slice(0, 12)
    .map((r) => r.content);
  let totalFlips = 0;
  let allFinalMatchAlways = true;
  let trialsRun = 0;
  for (const text of sampleTexts) {
    const stability = replayStability(format, text, 6, 5);
    totalFlips += stability.totalFlips;
    if (!stability.allFinalMatch) allFinalMatchAlways = false;
    trialsRun += 6;
  }
  streamingResults[format.id] = {
    sampledResponses: sampleTexts.length,
    trialsRun,
    totalFlips,
    allFinalMatchAlways,
  };
}

// ---------- 5. 聚合统计 ----------

function aggregateCell(formatId, connection) {
  const cellKey = `${formatId}__${connection}`;
  const resp = responseRecords.filter((r) => r.cellKey === cellKey);
  const summaryResp = resp.filter((r) => r.task.taskType === "summary");
  const quoteResp = resp.filter((r) => r.task.taskType === "quote");

  const okResp = resp.filter((r) => r.ok);
  const callFailureRate = resp.length ? (resp.length - okResp.length) / resp.length : null;

  const formatFollowedRate = (list) => {
    const okList = list.filter((r) => r.ok);
    if (okList.length === 0) return null;
    return okList.filter((r) => r.formatFollowed).length / okList.length;
  };

  const cellItems = items.filter((it) => it.cellKey === cellKey);
  const fabricationRate = cellItems.length ? cellItems.filter((it) => it.fabricated).length / cellItems.length : null;

  const quoteCitationItems = cellItems.filter((it) => it.isQuoteCitation);
  const verbatimAccuracyRate = quoteCitationItems.length
    ? quoteCitationItems.filter((it) => it.verbatimOk === true).length / quoteCitationItems.length
    : null;

  const quoteRespOk = quoteResp.filter((r) => r.ok);
  const hitExpectedBlockRate = quoteRespOk.length
    ? quoteRespOk.filter((r) => r.hitExpectedBlock === true).length / quoteRespOk.length
    : null;

  const locatableRate = cellItems.length ? cellItems.filter((it) => it.locatable).length / cellItems.length : null;

  const cellJudge = judgeResults.filter((j) => j.cellKey === cellKey);
  const judgedSupportRate = cellJudge.length
    ? cellJudge.filter((j) => j.verdict === "support").length / cellJudge.filter((j) => j.verdict !== "call-failed").length
    : null;

  return {
    formatId,
    connection,
    connectionLabel: CONNECTION_LABELS[connection],
    totalResponses: resp.length,
    callFailureRate,
    summaryFormatComplianceRate: formatFollowedRate(summaryResp),
    quoteFormatComplianceRate: formatFollowedRate(quoteResp),
    fabricationRate,
    verbatimAccuracyRate,
    hitExpectedBlockRate,
    locatableRate,
    judgedSupportRate,
    judgedCount: cellJudge.length,
  };
}

const cellSummaries = [];
for (const format of CITATION_FORMATS) {
  for (const connection of connections) {
    cellSummaries.push(aggregateCell(format.id, connection));
  }
}

// ---------- 6. 人工复核抽样：从裁判结果里按 cell 均匀抽 20% ----------

function sample20Percent(list) {
  const n = Math.max(1, Math.round(list.length * 0.2));
  const shuffled = [...list].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

const humanReviewSampleByCell = {};
for (const format of CITATION_FORMATS) {
  for (const connection of connections) {
    const cellKey = `${format.id}__${connection}`;
    const cellJudge = judgeResults.filter((j) => j.cellKey === cellKey && j.verdict !== "call-failed");
    if (cellJudge.length === 0) continue;
    humanReviewSampleByCell[cellKey] = sample20Percent(cellJudge).map((j) => j.idx);
  }
}

// ---------- 7. 落盘 ----------

writeFileSync(join(RESULTS_DIR, "cell-summaries.json"), JSON.stringify(cellSummaries, null, 2));
writeFileSync(join(RESULTS_DIR, "streaming-stability.json"), JSON.stringify(streamingResults, null, 2));
writeFileSync(
  join(RESULTS_DIR, "human-review-sample.json"),
  JSON.stringify({ note: "每格抽样 20% 的裁判条目 idx，对应 results-raw/judge-XXXX.json，供人工复核", humanReviewSampleByCell }, null, 2),
);
writeFileSync(
  join(RESULTS_DIR, "run-meta.json"),
  JSON.stringify(
    {
      repsPerTaskPerCell: REPS_PER_TASK_PER_CELL,
      concurrency: CONCURRENCY,
      totalGenCalls: genTasks.length,
      totalJudgeCalls: judgeTasks.length,
      genCallFailures: genOutcomes.filter((o) => !o.result.ok).length,
      judgeCallFailures: judgeResults.filter((j) => j.verdict === "call-failed").length,
      samplesUsed: SAMPLES.length,
      qaPairsUsed: ALL_QA.length,
      timestamp: new Date().toISOString(),
    },
    null,
    2,
  ),
);

console.log("完成。汇总文件已写入 results/：cell-summaries.json, streaming-stability.json, human-review-sample.json, run-meta.json");
console.log("原始响应已写入 results-raw/（已 gitignore，不提交）。");
