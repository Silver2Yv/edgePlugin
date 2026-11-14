// 连通性测试：两个接口各发一个最小流式请求，确认返回格式正常。不打印任何密钥。
import { getEndpoint1, getEndpoint2 } from './lib/keys.mjs';

async function testEndpoint(cfg, label) {
  console.log(`\n--- 测试 ${label} (${cfg.model}) ---`);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.key}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: '用一个词回答：1+1=？' }],
        stream: true,
        max_tokens: 20
      })
    });
  } catch (e) {
    console.log('请求异常:', e.message);
    return;
  }
  console.log('状态码:', res.status, '耗时到响应头(ms):', Date.now() - t0);
  if (!res.ok) {
    const text = await res.text();
    console.log('错误体:', text.slice(0, 300));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let firstTokenMs = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
    full += decoder.decode(value, { stream: true });
  }
  console.log('首 token 耗时(ms):', firstTokenMs, '总耗时(ms):', Date.now() - t0);
  console.log('原始流片段(前300字符):', full.slice(0, 300));
}

const e1 = getEndpoint1();
const e2 = getEndpoint2('deepseek-flash');

await testEndpoint(e1, '公司中转站');
await testEndpoint(e2, 'DeepSeek 官方');
