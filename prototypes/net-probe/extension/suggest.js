import { buildPrompt } from './prompt.js';

const $ = (id) => document.getElementById(id);
// 后台空闲约 30 秒会被浏览器回收，端口随之断开；发消息前按需重连（connect 会唤醒后台）
let port;
function connect() {
  const p = chrome.runtime.connect({ name: 'suggest' });
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
const materials = await (await fetch('materials.json')).json();

let idx = 0;
let cur; // 当前材料的时间线与结果

// 材料一显示就发请求（预热），与正式设计一致：划词后、点「问」前就开始生成
function show() {
  const m = materials[idx];
  $('progress').textContent = `第 ${idx + 1} / ${materials.length} 篇 · ${m.category} · ${m.lang}`;
  $('title').textContent = m.title;
  const art = $('article');
  art.textContent = '';
  const at = m.context.indexOf(m.selection);
  const mk = document.createElement('mark');
  mk.textContent = m.selection;
  art.append(m.context.slice(0, at), mk, m.context.slice(at + m.selection.length));
  requestAnimationFrame(() => mk.scrollIntoView({ block: 'center' }));
  $('askBox').hidden = true;
  $('reveal').hidden = true;
  $('ask').hidden = false;
  $('q').value = '';
  $('remark').value = '';
  $('ready').textContent = '建议生成中…';
  $('ready').className = '';
  cur = { id: m.id, title: m.title, tShow: Date.now() };
  const { system, user } = buildPrompt(m, 'selection_context');
  send({ type: 'suggest', id: m.id, system, user });
}

function onMessage(msg) {
  if (!cur || msg.id !== cur.id) return;
  if (msg.type === 'first' || (msg.type === 'done' && cur.tReady === undefined)) {
    cur.tReady = msg.type === 'first' ? msg.at : msg.firstAt;
    $('ready').textContent = '建议已就绪（提交后显示）';
    $('ready').className = 'on';
  }
  if (msg.type === 'done') cur.suggestions = msg.suggestions;
  if (msg.type === 'fail') {
    cur.failed = msg.message;
    $('ready').textContent = `建议生成失败：${msg.message}`;
  }
}

$('ask').onclick = () => {
  cur.tAsk = Date.now();
  $('ask').hidden = true;
  $('askBox').hidden = false;
  $('q').focus();
};
// 中文输入法先触发 compositionstart，部分输入方式只有 input 事件，三者取最早
for (const ev of ['keydown', 'compositionstart', 'input']) {
  $('q').addEventListener(ev, () => {
    if (cur.tFirstKey === undefined) cur.tFirstKey = Date.now();
  });
}
$('submit').onclick = () => {
  if (!$('q').value.trim()) return;
  cur.question = $('q').value.trim();
  cur.tSubmit = Date.now();
  $('sugs').textContent = '';
  for (const s of cur.suggestions ?? ['（建议还没生成完或失败了）']) {
    const li = document.createElement('li');
    li.textContent = s;
    $('sugs').append(li);
  }
  $('askBox').hidden = true;
  $('reveal').hidden = false;
};
for (const b of document.querySelectorAll('[data-hit]')) {
  b.onclick = async () => {
    cur.hit = Number(b.dataset.hit);
    cur.remark = $('remark').value.trim();
    const { suggestLog = [] } = await chrome.storage.local.get('suggestLog');
    suggestLog.push(summarize(cur));
    idx = Math.min(idx + 1, materials.length);
    await chrome.storage.local.set({ suggestLog, suggestIdx: idx });
    renderLog(suggestLog);
    if (idx < materials.length) show();
    else $('progress').textContent = '全部完成，请复制结果。';
  };
}

const rel = (t, from) => (t === undefined || from === undefined ? undefined : t - from);
function summarize(c) {
  return {
    id: c.id,
    title: c.title,
    question: c.question,
    suggestions: c.suggestions,
    hit: c.hit,
    remark: c.remark,
    failed: c.failed,
    readMs: rel(c.tAsk, c.tShow), // 显示到点「问」
    readyMs: rel(c.tReady, c.tShow), // 显示到首条建议完整
    firstKeyMs: rel(c.tFirstKey, c.tShow), // 显示到第一次按键
    // 首条建议就绪时用户是否已开始打字：就绪晚于第一次按键即为“已开始”
    typingBeforeReady: c.tReady === undefined ? true : c.tFirstKey !== undefined && c.tFirstKey < c.tReady,
  };
}

const fmt = (ms) => (ms === undefined ? '-' : (ms / 1000).toFixed(1));
const hitText = (h) => (h ? `第 ${h} 条` : '无');
function rows(log) {
  return log.map((r, i) => [i + 1, r.title, r.question, r.typingBeforeReady ? '是' : '否', hitText(r.hit), fmt(r.readMs), fmt(r.readyMs), fmt(r.firstKeyMs), [r.failed, r.remark].filter(Boolean).join('；')]);
}
const HEAD = ['编号', '标题', '我会问的问题', '建议出现时是否已开始打字', '命中第几条', '阅读用时 s', '建议就绪 s', '首次按键 s', '备注'];
function renderLog(log) {
  const t = $('log');
  t.innerHTML = '';
  const h = t.insertRow();
  for (const x of HEAD) h.insertCell().textContent = x;
  for (const r of rows(log)) {
    const tr = t.insertRow();
    for (const x of r) tr.insertCell().textContent = String(x ?? '');
  }
}

$('copyMd').onclick = async () => {
  const { suggestLog = [] } = await chrome.storage.local.get('suggestLog');
  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const n = suggestLog.length;
  const hits = suggestLog.filter((r) => r.hit).length;
  const readyFirst = suggestLog.filter((r) => !r.typingBeforeReady).length;
  const md = [
    `命中 ${hits}/${n}；建议先于打字就绪 ${readyFirst}/${n}`,
    '',
    `| ${HEAD.join(' | ')} |`,
    `| ${HEAD.map(() => '---').join(' | ')} |`,
    ...rows(suggestLog).map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
  await navigator.clipboard.writeText(md);
};
$('copyJson').onclick = async () => {
  const { suggestLog = [] } = await chrome.storage.local.get('suggestLog');
  await navigator.clipboard.writeText(JSON.stringify(suggestLog, null, 2));
};
$('reset').onclick = async () => {
  if (!confirm('清空已有标注，从第 1 篇重新开始？')) return;
  await chrome.storage.local.remove(['suggestLog', 'suggestIdx']);
  idx = 0;
  renderLog([]);
  show();
};

const saved = await chrome.storage.local.get(['suggestLog', 'suggestIdx']);
let log = saved.suggestLog ?? [];
idx = saved.suggestIdx ?? 0;
// 旧版页面在后台被回收后就再也拿不到建议：从第一条没拿到建议的记录起作废，从那一篇接着做
const bad = log.findIndex((r) => !r.suggestions?.length);
if (bad >= 0) {
  log = log.slice(0, bad);
  idx = bad;
  await chrome.storage.local.set({ suggestLog: log, suggestIdx: idx });
}
renderLog(log);
if (idx < materials.length) show();
else $('progress').textContent = '全部完成，请复制结果。';
if (bad >= 0) $('progress').textContent += `（第 ${bad + 1} 篇起没拿到建议的记录已清除，从这里继续）`;
