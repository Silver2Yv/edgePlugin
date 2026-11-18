const $ = (id) => document.getElementById(id);
// 后台空闲约 30 秒会被浏览器回收，端口随之断开；发消息前按需重连（connect 会唤醒后台）
let port;
function connect() {
  const p = chrome.runtime.connect({ name: 'probe' });
  p.onMessage.addListener(onMessage);
  p.onDisconnect.addListener(() => {
    if (port === p) port = undefined;
  });
  return p;
}
function send(msg) {
  try {
    (port ??= connect()).postMessage(msg);
  } catch {
    // 断开事件还没送到时端口已失效
    port = connect();
    port.postMessage(msg);
  }
}
port = connect();

const LABEL = {
  models: 'T1 模型列表',
  missingV1: 'T2 漏写 /v1',
  nonStream: 'T3 非流式',
  stream: 'T4 流式',
  badKey: 'T6a 错误 Key',
  badPath: 'T6b 错误路径',
  unreachable: 'T6c 连不上的主机',
  long: 'T5 长任务流式',
};

// 每项的判定：返回 [是否符合预期, 说明]
function verdict(r) {
  if (r.skipped) return [null, r.skipped];
  if (r.error) return [false, `脚本异常：${r.error}`];
  const wrErr = r.webRequest?.find((e) => e.event === 'onErrorOccurred')?.error;
  const net = r.networkError ? `网络错误：${r.networkError}${wrErr ? `；webRequest 错误码 ${wrErr}` : ''}` : '';
  switch (r.name) {
    case 'models':
      return [r.status === 200 && r.modelListed, net || `共 ${r.modelCount} 个模型，${r.modelListed ? '包含' : '不包含'}所填模型`];
    case 'missingV1':
      return [null, net || `HTTP ${r.status}，${r.isHtml ? '返回的是网页（需在设置里拦截这种情况）' : `内容类型 ${r.contentType}`}`];
    case 'nonStream':
      return [r.status === 200 && !!r.replyHead, net || `回复：${r.replyHead ?? r.bodyHead}；思考 ${r.reasoningChars ?? '-'} 字；结束原因 ${r.finishReason ?? '-'}`];
    case 'stream':
    case 'long': {
      if (net || !r.sse) return [false, net || `HTTP ${r.status}，不是流式响应：${r.bodyHead ?? ''}`];
      const s = r.sse;
      const ok = r.status === 200 && s.done && r.contentChars > 0 && (r.name !== 'long' || r.tDone >= 60_000);
      return [ok, `正文 ${r.contentChars} 字，思考 ${r.reasoningChars} 字；事件 ${s.events}，网络块 ${s.chunks}，跨块事件 ${s.splitEvents}，注释行 ${s.comments}，CRLF ${s.crlf ? '是' : '否'}，[DONE] ${s.done ? '有' : '无'}，流内错误 ${s.streamErrors}`];
    }
    case 'badKey':
      return [r.status === 401 || r.status === 403, net || `HTTP ${r.status}：${r.bodyHead}`];
    case 'badPath':
      return [r.status === 404, net || `HTTP ${r.status}${r.isHtml ? '（网页）' : ''}：${r.bodyHead}`];
    case 'unreachable':
      return [!!r.networkError && !!wrErr, r.networkError ? `fetch 报错「${r.networkError}」；webRequest 错误码 ${wrErr ?? '没拿到'}` : `意外地连上了：HTTP ${r.status}`];
  }
  return [null, ''];
}
const sec = (ms) => (ms === undefined ? '-' : `${(ms / 1000).toFixed(2)} s`);
const mark = (v) => (v === true ? '符合' : v === false ? '不符合' : '记录');

function runTable(run) {
  const head = `${run.suite === 'long' ? '长任务' : '快速'}测试 · ${new Date(run.startedAt).toLocaleString()} · 状态：${run.state}${run.interruptedNote ? `（${run.interruptedNote}）` : ''}`;
  const rows = run.results.map((r) => {
    const [v, note] = verdict(r);
    return { name: LABEL[r.name] ?? r.name, v, status: r.status ?? '-', tHeader: sec(r.tHeader), tFirst: sec(r.tFirstContent), tDone: sec(r.tDone ?? r.tFail), note };
  });
  if (run.state === 'interrupted' && run.checkpoint) {
    rows.push({ name: '中断前检查点', v: false, status: '-', tHeader: '-', tFirst: '-', tDone: sec(run.checkpoint.atMs), note: `已收到正文 ${run.checkpoint.contentChars} 字` });
  }
  return { head, rows };
}

function envLine(run) {
  const m = run.meta ?? {};
  return `浏览器：${m.browser ?? '-'}；网络：${m.network || '未填'}；开发者工具：${m.devtools === 'open' ? '开着' : '没开'}；保活：${m.keepalive ? '开' : '关'}；模型：${m.model}；关闭思考：${m.disableThinking ? '是' : '否'}；地址形态：${m.baseUrlShape}`;
}

// 被回收的运行不会进入 runs，要从 current 补上
async function allRuns() {
  const { current, runs = [] } = await chrome.storage.local.get(['current', 'runs']);
  const live = current?.state === 'running' || current?.state === 'interrupted';
  return { current, list: live ? [current, ...runs.filter((r) => r.startedAt !== current.startedAt)] : runs };
}

async function render() {
  const { current, list } = await allRuns();
  $('results').innerHTML = '';
  for (const run of list) {
    const { head, rows } = runTable(run);
    const h = document.createElement('h3');
    h.textContent = head;
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = envLine(run);
    const t = document.createElement('table');
    t.innerHTML = '<tr><th>测试</th><th>结论</th><th>HTTP</th><th>到响应头</th><th>到首个正文</th><th>完成/失败</th><th>说明</th></tr>';
    for (const r of rows) {
      const tr = t.insertRow();
      for (const [i, v] of [r.name, mark(r.v), r.status, r.tHeader, r.tFirst, r.tDone, r.note].entries()) {
        const td = tr.insertCell();
        td.textContent = String(v);
        if (i === 1) td.className = r.v === true ? 'ok' : r.v === false ? 'bad' : '';
      }
    }
    $('results').append(h, p, t);
  }
  if (current?.state === 'running') $('status').textContent = `运行中…（检查点：${current.checkpoint ? `${current.checkpoint.contentChars} 字` : '无'}）`;
}

function toMarkdown(runs) {
  return runs
    .map((run) => {
      const { head, rows } = runTable(run);
      const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      return [
        `### ${head}`,
        '',
        envLine(run),
        '',
        '| 测试 | 结论 | HTTP | 到响应头 | 到首个正文 | 完成/失败 | 说明 |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map((r) => `| ${[r.name, mark(r.v), r.status, r.tHeader, r.tFirst, r.tDone, r.note].map(esc).join(' | ')} |`),
      ].join('\n');
    })
    .join('\n\n');
}

async function browserName() {
  try {
    const { fullVersionList, platform } = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platform']);
    const b = fullVersionList.find((x) => /Edge/.test(x.brand)) ?? fullVersionList.find((x) => /Chrome/.test(x.brand)) ?? fullVersionList[0];
    return `${b.brand} ${b.version}（${platform}）`;
  } catch {
    return navigator.userAgent;
  }
}

// ---------- 事件 ----------
$('save').onclick = async () => {
  const cfg = { baseUrl: $('baseUrl').value.trim(), key: $('key').value.trim(), model: $('model').value.trim(), disableThinking: $('disableThinking').checked };
  await chrome.storage.session.set({ cfg });
  $('status').textContent = '连接已保存（只在内存中）';
};
const meta = () => ({ network: $('network').value, devtools: $('devtools').value, keepalive: $('keepalive').checked, browser: $('browser').value });
$('runQuick').onclick = () => send({ type: 'run', suite: 'quick', meta: meta() });
$('runLong').onclick = () => send({ type: 'run', suite: 'long', meta: meta() });
$('copyMd').onclick = async () => {
  await navigator.clipboard.writeText(toMarkdown((await allRuns()).list));
  $('status').textContent = '已复制 Markdown';
};
$('copyJson').onclick = async () => {
  await navigator.clipboard.writeText(JSON.stringify((await allRuns()).list, null, 2));
  $('status').textContent = '已复制 JSON';
};
$('clear').onclick = async () => {
  if (!confirm('清空本机所有诊断记录？')) return;
  await chrome.storage.local.remove(['current', 'runs']);
  render();
};

function onMessage(m) {
  if (m.type === 'progress') $('status').textContent = `正在运行：${LABEL[m.name] ?? m.name}`;
  if (m.type === 'error') $('status').textContent = m.message;
  if (m.type === 'finished') $('status').textContent = '完成';
}
chrome.storage.onChanged.addListener((_, area) => area === 'local' && render());

(async () => {
  $('browser').value = await browserName();
  const { cfg } = await chrome.storage.session.get('cfg');
  if (cfg) {
    $('baseUrl').value = cfg.baseUrl;
    $('key').value = cfg.key;
    $('model').value = cfg.model;
    $('disableThinking').checked = !!cfg.disableThinking;
  }
  render();
})();
