// 读取密钥与配置。绝不打印、绝不写入文件。
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, '..', '..', '.secrets', 'config.json');

export function loadConfig() {
  const raw = readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

export function getKeyFromWindowsUserEnv(varName) {
  const cmd = `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('${varName}','User')"`;
  const out = execSync(cmd, { encoding: 'utf8' }).trim();
  if (!out) throw new Error(`环境变量 ${varName} 为空（Windows 用户变量未设置）`);
  return out;
}

export function getKeyFromProcessEnv(varName) {
  const v = process.env[varName];
  if (!v) throw new Error(`环境变量 ${varName} 为空（当前进程环境未设置）`);
  return v;
}

export function getEndpoint1() {
  const cfg = loadConfig();
  const key = getKeyFromWindowsUserEnv(cfg.endpoint1.keyEnv);
  return { ...cfg.endpoint1, key };
}

export function getEndpoint2(modelOverride) {
  const cfg = loadConfig();
  const key = getKeyFromProcessEnv(cfg.endpoint2.keyEnv);
  return { ...cfg.endpoint2, model: modelOverride || cfg.endpoint2.model, key };
}
