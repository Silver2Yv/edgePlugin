// 流式请求客户端：发起 chat.completions 流式请求，记录关键时间戳，
// 并在流过程中识别"第一条建议完整可显示"的时刻（遇到从"1. "开始、到下一个换行/"2. "之前的文本）。

/**
 * @param {object} endpoint {baseUrl, model, key}
 * @param {{system:string, user:string}} prompt
 * @param {object} opts {maxTokens, disableThinking}
 * @returns {Promise<object>} 时间戳（相对请求发出的 ms）与最终文本
 */
export async function streamSuggestions(endpoint, prompt, opts = {}) {
  const { maxTokens = 220, disableThinking = true } = opts;
  const body = {
    model: endpoint.model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user }
    ],
    stream: true,
    max_tokens: maxTokens,
    temperature: 0.7
  };
  if (disableThinking) {
    body.thinking = { type: 'disabled' };
  }

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.key}`
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { ok: false, error: `网络异常: ${e.message}`, t0 };
  }

  const tHeader = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, tHeader };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';           // SSE 行缓冲
  let content = '';       // 累积的正文内容
  let tFirstToken = null; // 首个非空 content token 到达时刻
  let tFirstSuggestion = null; // 第一条建议（"1. ..."到换行）完整可显示的时刻
  let sawFirstLineBreakAfterItem1 = false;
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop(); // 可能不完整的最后一行，留到下次
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) continue;
      if (delta.content) {
        if (tFirstToken === null) tFirstToken = Date.now() - t0;
        content += delta.content;
        if (!sawFirstLineBreakAfterItem1 && /^\s*1\./.test(content)) {
          const nl = content.indexOf('\n');
          if (nl !== -1) {
            sawFirstLineBreakAfterItem1 = true;
            tFirstSuggestion = Date.now() - t0;
          }
        }
      }
      if (json.usage) usage = json.usage;
    }
  }
  const tDone = Date.now() - t0;
  // 兜底：如果全程只有一行（没有换行符），用完成时刻作为"第一条建议可显示"时刻
  if (tFirstSuggestion === null && content.trim()) {
    tFirstSuggestion = tDone;
  }

  return {
    ok: true,
    tHeader,
    tFirstToken,
    tFirstSuggestion,
    tDone,
    content: content.trim(),
    usage
  };
}

/** 把模型输出解析成最多 3 条问题字符串数组。 */
export function parseSuggestions(rawText) {
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\d+[.、)]\s*/, '').trim())
    .filter(Boolean);
  return lines.slice(0, 3);
}
