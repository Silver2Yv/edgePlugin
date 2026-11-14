// V-09 第一部分：真实模型调用客户端。
// 两个接口都走 OpenAI 兼容的 /chat/completions，非流式（stream:false）——
// 本实验只需要拿到完整文本做格式/引用统计；"流式解析是否稳定"这一项用
// stream-replay.mjs 对已拿到的完整文本做随机 chunk 边界切分重放，不依赖真实流式连接。
//
// 绝不把 Key 写进文件/日志/结果；公司中转站的真实地址只存在 .secrets/config.json
// （已被 gitignore），结果文件里一律写"公司中转站"。

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SECRETS_PATH = join(__dirname, "..", "..", ".secrets", "config.json");

let _rvKeyCache; // 进程内缓存，避免重复拉起 powershell
function getRvKey() {
  if (_rvKeyCache) return _rvKeyCache;
  const out = execSync(
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \"[Environment]::GetEnvironmentVariable('TEST_API_KEY','User')\"",
    { encoding: "utf8" },
  ).trim();
  if (!out) throw new Error("TEST_API_KEY 未设置（Windows 用户环境变量）");
  _rvKeyCache = out;
  return out;
}

function loadRvConfig() {
  return JSON.parse(readFileSync(SECRETS_PATH, "utf8")).relay;
}

/** 脱敏：Authorization 头只在日志里出现 "Bearer ***"，绝不打印真实 Key。 */
function redactedHeaderLog() {
  return { Authorization: "Bearer ***" };
}

/**
 * 两个连接的统一描述。label 用于结果文件/日志里标注，不包含真实地址。
 */
export const CONNECTIONS = {
  relay: {
    key: "relay",
    label: "公司中转站（VPN）",
    model: null, // 运行时从 .secrets/config.json 读取
  },
  deepseek: {
    key: "deepseek",
    label: "DeepSeek 官方",
    model: "deepseek-v4-pro",
  },
};

/**
 * 发起一次非流式 chat completion。
 * @param {"relay"|"deepseek"} connectionKey
 * @param {{system:string, user:string, maxTokens?:number, modelOverride?:string}} opts
 * @returns {Promise<{ ok: true, content: string, raw: any } | { ok: false, error: string, status?: number }>}
 */
export async function callModel(connectionKey, { system, user, maxTokens = 1200, modelOverride }) {
  let baseURL, model, key;
  if (connectionKey === "relay") {
    const cfg = loadRvConfig();
    baseURL = cfg.baseURL;
    model = modelOverride ?? cfg.model;
    key = getRvKey();
  } else if (connectionKey === "deepseek") {
    baseURL = "https://api.deepseek.com";
    model = modelOverride ?? CONNECTIONS.deepseek.model;
    key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error("DEEPSEEK_API_KEY 未设置");
  } else {
    throw new Error(`未知连接: ${connectionKey}`);
  }

  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        stream: false,
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}`, status: res.status };
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content ?? "";
    return { ok: true, content, raw: json };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * 带重试的调用：失败（网络错误或非 2xx）重试，最多 retries 次，指数退避。
 * 记录每次尝试的脱敏结果（不含 Key），供失败分析使用。
 */
export async function callModelWithRetry(connectionKey, opts, { retries = 2 } = {}) {
  const attempts = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await callModel(connectionKey, opts);
    attempts.push({
      attempt,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
      status: result.ok ? undefined : result.status,
      requestHeadersRedacted: redactedHeaderLog(),
    });
    if (result.ok) return { ...result, attempts };
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  return { ok: false, error: attempts[attempts.length - 1]?.error ?? "未知错误", attempts };
}

/**
 * 简单并发限制器：最多同时跑 `limit` 个任务。
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
 */
export async function runWithConcurrency(tasks, limit = 3) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
