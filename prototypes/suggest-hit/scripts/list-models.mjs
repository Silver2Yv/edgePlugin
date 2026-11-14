// 列出 DeepSeek 官方接口的可用模型，选一个较快的非推理对话模型。
import { getEndpoint2 } from './lib/keys.mjs';

const cfg = getEndpoint2();

const res = await fetch(`${cfg.baseUrl}/models`, {
  headers: { Authorization: `Bearer ${cfg.key}` }
});
if (!res.ok) {
  console.error('请求失败:', res.status, res.statusText);
  process.exit(1);
}
const data = await res.json();
console.log('可用模型列表：');
for (const m of data.data || []) {
  console.log('-', m.id);
}
