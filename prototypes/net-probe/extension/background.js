// 网络诊断包后台。所有网络请求都从这里发出（与正式扩展规则 1 一致）。
// Key 只放在 storage.session（内存，不落盘）；写入 storage.local 的结果一律先脱敏。

const SW_INSTANCE = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const UNREACHABLE_HOST = 'ra-probe-unreachable.invalid';
const watched = new Set([UNREACHABLE_HOST]);
const wrLog = []; // webRequest 观察记录（只记被观察主机）

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: 'diag.html' }));

// 上一次运行若停在 running，而本实例是新起的，说明后台中途被回收
chrome.runtime.onStartup.addListener(markInterrupted);
markInterrupted();
async function markInterrupted() {
  const { current } = await chrome.storage.local.get('current');
  if (current?.state === 'running' && current.swInstance !== SW_INSTANCE) {
    current.state = 'interrupted';
    current.interruptedNote = '后台在运行中被回收或重启（新实例接管）';
    current.lastEventAt = Date.now();
    await chrome.storage.local.set({ current });
  }
}

// webRequest 监听必须在顶层同步注册，才能观察 Service Worker 自己发出的请求
for (const name of ['onBeforeRequest', 'onSendHeaders', 'onHeadersReceived', 'onResponseStarted', 'onCompleted', 'onErrorOccurred']) {
  chrome.webRequest[name].addListener(
    (d) => {
      let host;
      try {
        host = new URL(d.url).hostname;
      } catch {
        return;
      }
      if (!watched.has(host)) return;
      wrLog.push({
        event: name,
        at: d.timeStamp,
        path: new URL(d.url).pathname,
        initiator: d.initiator?.startsWith('chrome-extension://') ? 'chrome-extension://<本扩展>' : d.initiator,
        tabId: d.tabId,
        type: d.type,
        statusCode: d.statusCode,
        error: d.error,
        ip: d.ip ? '<已记录，已脱敏>' : undefined,
      });
    },
    { urls: ['<all_urls>'] },
  );
}

// ---------- 脱敏 ----------
function makeRedactor(cfg) {
  const host = safeHost(cfg.baseUrl);
  return (s) => {
    if (typeof s !== 'string') return s;
    let out = s;
    if (cfg.key) out = out.split(cfg.key).join('<key>');
    if (host) out = out.split(host).join('<relay>').replace(/<relay>:\d+/g, '<relay>:<端口>');
    return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, '<key>').replace(/Bearer\s+\S+/g, 'Bearer <key>');
  };
}
function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}
function redactDeep(v, r) {
  if (typeof v === 'string') return r(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, r));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, r)]));
  return v;
}

// ---------- 带时间线的请求 ----------
// 返回：到响应头、到首字节、到首个内容增量、完成的毫秒数，以及 SSE 形态观察
async function timedFetch(url, init, { stream = false, onContent, signal } = {}) {
  const rec = { path: new URL(url).pathname, startedAt: Date.now() };
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  let res;
  try {
    res = await fetch(url, { ...init, signal, redirect: 'manual' });
  } catch (e) {
    rec.ok = false;
    rec.networkError = String(e?.message ?? e);
    rec.tFail = ms();
    return finish(rec);
  }
  rec.tHeader = ms();
  rec.status = res.status;
  rec.type = res.type; // opaqueredirect 表示服务端要求重定向
  rec.contentType = res.headers.get('content-type') ?? '';
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  let text = '';
  let buf = '';
  const sse = { chunks: 0, events: 0, crlf: false, comments: 0, splitEvents: 0, done: false, streamErrors: 0 };
  let content = '';
  let reasoningChars = 0;
  let usage;
  while (reader) {
    const { value, done } = await reader.read();
    if (done) break;
    if (rec.tFirstByte === undefined) rec.tFirstByte = ms();
    const piece = dec.decode(value, { stream: true });
    sse.chunks++;
    if (piece.includes('\r\n')) sse.crlf = true;
    if (!stream || !rec.contentType.includes('event-stream')) {
      text += piece;
      continue;
    }
    buf += piece;
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? '';
    if (buf.length > 0) sse.splitEvents++;
    for (const evt of parts) {
      for (const line of evt.split(/\r?\n/)) {
        if (line.startsWith(':')) {
          sse.comments++;
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          sse.done = true;
          continue;
        }
        sse.events++;
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) sse.streamErrors++;
        const delta = j.choices?.[0]?.delta ?? {};
        const r = delta.reasoning_content ?? delta.reasoning ?? '';
        if (r) {
          reasoningChars += r.length;
          if (rec.tFirstReasoning === undefined) rec.tFirstReasoning = ms();
        }
        if (delta.content) {
          if (rec.tFirstContent === undefined) rec.tFirstContent = ms();
          content += delta.content;
          onContent?.(content, ms());
        }
        if (j.usage) usage = j.usage;
      }
    }
  }
  rec.tDone = ms();
  rec.ok = res.ok;
  if (stream && rec.contentType.includes('event-stream')) {
    rec.sse = sse;
    rec.contentChars = content.length;
    rec.reasoningChars = reasoningChars;
    rec.usage = usage;
    rec.content = content;
  } else {
    rec.bodyHead = text.slice(0, 200);
    rec.isHtml = /^\s*<(!doctype|html)/i.test(text);
    rec.text = text;
  }
  return finish(rec);
}
async function finish(rec) {
  rec.endedAt = Date.now();
  await new Promise((r) => setTimeout(r, 300)); // 等 onCompleted / onErrorOccurred 落进记录
  rec.webRequest = wrLog.filter((e) => e.at >= rec.startedAt - 5 && e.at <= rec.endedAt + 1000);
  return rec;
}
// ---------- 测试项 ----------
const root = (cfg) => cfg.baseUrl.replace(/\/+$/, '');
const headers = (key) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` });
function chat(cfg, prompt, extra = {}, { thinking = !cfg.disableThinking } = {}) {
  const body = { model: cfg.model, messages: [{ role: 'user', content: prompt }], ...extra };
  if (!thinking) body.thinking = { type: 'disabled' };
  return { method: 'POST', headers: headers(cfg.key), body: JSON.stringify(body) };
}
// 快模型约 170 字/秒，要撑过 60 秒需上万字
const LONG_PROMPT = '请写一篇约 15000 字的中文说明文，主题是图书馆的历史，分 20 节，每节都要有小标题，每节不少于 700 字。';

const TESTS = {
  // 模型列表
  async models(cfg) {
    const r = await timedFetch(`${root(cfg)}/models`, { headers: headers(cfg.key) });
    let ids = [];
    try {
      ids = JSON.parse(r.text).data.map((m) => m.id);
    } catch {}
    return { ...r, modelCount: ids.length, modelListed: ids.includes(cfg.model) };
  },
  // 用户漏写 /v1 时会发生什么（决策记录里观察到返回 200 + 网页）
  async missingV1(cfg) {
    const b = root(cfg);
    if (!/\/v1$/.test(b)) return { skipped: '地址不以 /v1 结尾，跳过' };
    return timedFetch(`${b.slice(0, -3)}/chat/completions`, chat(cfg, '只回复 OK', { max_tokens: 16 }));
  },
  // 非流式最小对话
  async nonStream(cfg) {
    // max_tokens 留足：开思考时思考内容也计入 max_tokens，给太小会拿到空正文
    const r = await timedFetch(`${root(cfg)}/chat/completions`, chat(cfg, '只回复 OK', { max_tokens: 512 }));
    try {
      const j = JSON.parse(r.text);
      const msg = j.choices?.[0]?.message ?? {};
      r.replyHead = String(msg.content ?? '').slice(0, 40);
      r.reasoningChars = String(msg.reasoning_content ?? '').length;
      r.finishReason = j.choices?.[0]?.finish_reason;
      r.usage = j.usage;
    } catch {}
    return r;
  },
  // 流式，保持服务端默认的思考设置，观察思考内容与正文的先后
  async stream(cfg) {
    const r = await timedFetch(
      `${root(cfg)}/chat/completions`,
      chat(cfg, '用三句话说明浏览器扩展的 Service Worker 是什么。', { stream: true, max_tokens: 1024 }, { thinking: true }),
      { stream: true },
    );
    r.replyHead = r.content?.slice(0, 40);
    return r;
  },
  // 错误分类素材
  async badKey(cfg) {
    return timedFetch(`${root(cfg)}/models`, { headers: headers('sk-invalid-probe-key-000000') });
  },
  async badPath(cfg) {
    return timedFetch(`${root(cfg)}/nonexistent-probe`, chat(cfg, 'OK', { max_tokens: 4 }));
  },
  // 请求根本到不了服务器时，webRequest 能否给出浏览器错误码
  async unreachable() {
    return timedFetch(`https://${UNREACHABLE_HOST}/v1/models`, {});
  },
  // 长时间流式：建议启动后立刻关掉诊断页，验证无界面订阅时后台能否撑完
  async long(cfg, current) {
    let last = 0;
    const r = await timedFetch(
      `${root(cfg)}/chat/completions`,
      chat(cfg, LONG_PROMPT, { stream: true, max_tokens: 32000 }),
      {
        stream: true,
        onContent: (c, t) => {
          if (t - last < 2000) return; // 每 2 秒写一次检查点
          last = t;
          current.checkpoint = { atMs: t, contentChars: c.length };
          current.lastEventAt = Date.now();
          void chrome.storage.local.set({ current });
        },
      },
    );
    return r;
  },
};
const SUITES = {
  quick: ['models', 'missingV1', 'nonStream', 'stream', 'badKey', 'badPath', 'unreachable'],
  long: ['long'],
};

// ---------- 运行与消息 ----------
const ports = new Set();
const broadcast = (msg) => {
  for (const p of ports) {
    try {
      p.postMessage(msg);
    } catch {}
  }
};
let running = false;

async function runSuite(suite, meta) {
  if (running) return broadcast({ type: 'error', message: '已有测试在运行' });
  const { cfg } = await chrome.storage.session.get('cfg');
  if (!cfg?.baseUrl || !cfg?.key || !cfg?.model) return broadcast({ type: 'error', message: '请先填写地址、Key 和模型并保存' });
  running = true;
  watched.add(safeHost(cfg.baseUrl));
  const redact = makeRedactor(cfg);
  const current = {
    state: 'running',
    suite,
    swInstance: SW_INSTANCE,
    startedAt: Date.now(),
    meta: { ...meta, model: cfg.model, baseUrlShape: redact(cfg.baseUrl), disableThinking: !!cfg.disableThinking },
    results: [],
  };
  await chrome.storage.local.set({ current });
  // 保活：每 20 秒调用一次扩展接口，重置 30 秒空闲计时（架构 5.5）
  const ka = meta.keepalive ? setInterval(() => chrome.runtime.getPlatformInfo(), 20_000) : undefined;
  try {
    for (const name of SUITES[suite]) {
      broadcast({ type: 'progress', name });
      let r;
      try {
        r = await TESTS[name](cfg, current);
      } catch (e) {
        r = { error: String(e?.message ?? e) };
      }
      delete r.text; // 不保留响应正文，只留前 200 字（bodyHead）与统计
      delete r.content;
      current.results.push(redactDeep({ name, ...r }, redact));
      current.lastEventAt = Date.now();
      await chrome.storage.local.set({ current });
      broadcast({ type: 'result', result: current.results.at(-1) });
    }
    current.state = 'done';
  } finally {
    clearInterval(ka);
    running = false;
    current.endedAt = Date.now();
    const { runs = [] } = await chrome.storage.local.get('runs');
    runs.unshift(current);
    await chrome.storage.local.set({ current, runs: runs.slice(0, 20) });
    broadcast({ type: 'finished', run: current });
  }
}

// 问题建议：流式生成，第一行完整（出现换行）即视为首条建议可显示
async function runSuggest(port, { id, system, user }) {
  const { cfg } = await chrome.storage.session.get('cfg');
  if (!cfg?.key) return port.postMessage({ type: 'fail', id, message: '请先在诊断页保存连接' });
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: true,
    max_tokens: 220,
    // 与 suggest-hit 一致：总是关思考。开思考时思考内容计入 max_tokens，220 不够用，建议会被截断
    thinking: { type: 'disabled' },
  };
  const sentAt = Date.now();
  let firstAt;
  const r = await timedFetch(
    `${root(cfg)}/chat/completions`,
    { method: 'POST', headers: headers(cfg.key), body: JSON.stringify(body) },
    {
      stream: true,
      onContent: (c) => {
        if (firstAt === undefined && /^\s*1\.[^\n]+\n/.test(c)) {
          firstAt = Date.now();
          try {
            port.postMessage({ type: 'first', id, at: firstAt });
          } catch {}
        }
      },
    },
  );
  const lines = (r.content ?? '').split('\n').map((l) => l.replace(/^\s*\d\.\s*/, '').trim()).filter(Boolean);
  try {
    port.postMessage({
      type: r.ok ? 'done' : 'fail',
      id,
      sentAt,
      firstAt: firstAt ?? (r.ok ? Date.now() : undefined),
      suggestions: lines.slice(0, 3),
      tHeader: r.tHeader,
      tFirstContent: r.tFirstContent,
      tDone: r.tDone,
      message: r.ok ? undefined : makeRedactor(cfg)(`HTTP ${r.status ?? '-'} ${r.networkError ?? r.bodyHead ?? ''}`),
    });
  } catch {}
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== chrome.runtime.id) return port.disconnect();
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((m) => {
    if (m?.type === 'run' && SUITES[m.suite]) void runSuite(m.suite, m.meta ?? {});
    if (m?.type === 'suggest') void runSuggest(port, m);
  });
});
