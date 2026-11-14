// 一次性连通性检查：不写入结果文件，只打印脱敏信息。
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getRvKey() {
  const out = execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Environment]::GetEnvironmentVariable('TEST_API_KEY','User')"`,
    { encoding: "utf8" },
  ).trim();
  if (!out) throw new Error("TEST_API_KEY 未设置");
  return out;
}

const cfg = JSON.parse(
  readFileSync(join(__dirname, ".secrets", "config.json"), "utf8"),
);

async function testRv() {
  const key = getRvKey();
  const res2 = await fetch(`${cfg.relay.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: cfg.relay.model,
      messages: [{ role: "user", content: "只回复“ok”两个字。" }],
      max_tokens: 10,
      stream: false,
    }),
  });
  console.log("[公司中转站] status =", res2.status);
  const text = await res2.text();
  console.log("[公司中转站] body(前200字) =", text.slice(0, 200));
}

async function testDs() {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY 未设置");
  const modelsRes = await fetch("https://api.deepseek.com/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  console.log("[DeepSeek] /models status =", modelsRes.status);
  const models = await modelsRes.json();
  console.log(
    "[DeepSeek] 模型列表 =",
    (models.data || []).map((m) => m.id),
  );

  const chatRes = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "只回复“ok”两个字。" }],
      max_tokens: 10,
      stream: false,
    }),
  });
  console.log("[DeepSeek] chat status =", chatRes.status);
  const text = await chatRes.text();
  console.log("[DeepSeek] body(前200字) =", text.slice(0, 200));
}

await testRv();
await testDs();
