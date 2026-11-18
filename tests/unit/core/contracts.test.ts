import { describe, expect, it } from 'vitest';
import type { Anchor } from '@/core/anchor/anchor';
import type { PageDocReport } from '@/core/context/page-doc';
import { toPageKey } from '@/core/context/page-key';
import { defaultBudget, estimateTokens } from '@/core/context/plan';
import { jsonStringBytes, splitByJsonBytes, truncateByJsonBytes } from '@/core/domain/bytes';
import { bindingMatches, routeOnAsk } from '@/core/domain/float';
import { canRetry, canTransition, isTerminal, JOB_LIMITS } from '@/core/domain/job';
import {
  type anchorSchema,
  clientToBackground,
  contentToBackground,
  messageBytes,
  optionsToBackground,
  type PageConfig,
  pageDocSchema,
  parseFrom,
} from '@/core/domain/messages';
import type { Infer } from '@/core/domain/schema';
import {
  DEFAULT_SETTINGS,
  exportSettings,
  migrateSettings,
  SETTINGS_VERSION,
  type Settings,
} from '@/core/domain/settings';
import { normalizeSiteRule, onPolicyChange, SITE_MATRIX, siteLevelFor } from '@/core/domain/site-policy';

// 编译期：校验结构推出的类型必须能赋给领域类型（改一边忘了另一边会在 typecheck 失败）
const _anchor: (a: Infer<typeof anchorSchema>) => Anchor = (a) => a;
const _doc: (d: Infer<typeof pageDocSchema>) => PageDocReport = (d) => d;
void _anchor;
void _doc;
void (null as unknown as PageConfig);

const ID = '0123456789abcdef';
const TOKEN = '0123456789abcdef0123456789abcdef';
const MAX = JOB_LIMITS.maxFieldBytes;
const KB = 1024;

const click = (text: string) => ({
  type: 'action/click',
  actionId: 'ask',
  selectionRevision: 3,
  text,
  truncated: false,
  originalLength: [...text].length,
  inCode: false,
});

const ask = (extra: Record<string, unknown> = {}) => ({
  type: 'conv/ask',
  clientRequestId: ID,
  actionId: 'ask',
  text: '这段话什么意思？',
  selectionRevision: 1,
  contextTier: 'nearby',
  lengthTier: 'normal',
  thinking: 'off',
  model: { connectionId: ID, model: 'deepseek-flash' },
  ...extra,
});

describe('消息协议', () => {
  it('合法的意图消息通过', () => {
    expect(parseFrom('content', contentToBackground, click('选中的文字')).ok).toBe(true);
  });

  it('未知类型拒绝（先查角色，未登记的类型按无权拒绝）', () => {
    const r = parseFrom('content', contentToBackground, { type: 'model/fetch' });
    expect(r).toMatchObject({ ok: false, reason: 'notAllowed' });
    expect(parseFrom('content', contentToBackground, { kind: 'x' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('内容脚本夹带地址或 Key 的字段被拒（规则 6）', () => {
    const r = parseFrom('content', contentToBackground, {
      type: 'config/get',
      baseUrl: 'https://evil.example/v1',
    });
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('自报 tabId 的内容脚本消息被拒（规则 7）', () => {
    const r = parseFrom('content', contentToBackground, { type: 'config/get', tabId: 1 });
    expect(r.ok).toBe(false);
  });

  it('原型链上的键不算已知字段', () => {
    for (const k of ['constructor', 'toString', 'hasOwnProperty']) {
      const r = parseFrom('content', contentToBackground, { type: 'config/get', [k]: 'x' });
      expect(r).toMatchObject({ ok: false, reason: 'invalid' });
      if (!r.ok) expect(r.detail).not.toContain(k);
    }
  });

  it('选区超过 48 KB 被拒；整条超过 64 KB 先按大小拒绝', () => {
    expect(parseFrom('content', contentToBackground, click('字'.repeat(16_384))).ok).toBe(true);
    expect(parseFrom('content', contentToBackground, click('字'.repeat(16_385)))).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    const big = { type: 'config/get', pad: 'a'.repeat(64 * KB) };
    expect(parseFrom('content', contentToBackground, big)).toMatchObject({ ok: false, reason: 'tooLarge' });
  });

  it('各大消息把字段填满上限，整条仍不超过 64 KB', () => {
    const fill = (bytes: number) => '"'.repeat(Math.floor(bytes / 2));
    const anchor = {
      exact: fill(12 * KB),
      prefix: fill(KB),
      suffix: fill(KB),
      blockDigest: 'z'.repeat(128),
      headingPath: Array.from({ length: 12 }, () => fill(KB)),
      scrollRatio: 0.5,
      offsetInBlock: Number.MAX_SAFE_INTEGER,
    };
    const cases: [Parameters<typeof parseFrom>[0], Parameters<typeof parseFrom>[1], unknown][] = [
      ['content', contentToBackground, { ...click(fill(MAX)), originalLength: 2 ** 31 }],
      [
        'content',
        contentToBackground,
        { type: 'page/docPart', readId: ID, index: 999, total: 1000, data: fill(MAX) },
      ],
      [
        'content',
        contentToBackground,
        {
          type: 'selection/anchored',
          selectionRevision: 2 ** 31,
          anchor,
          blockIds: Array.from({ length: 200 }, () => '_'.repeat(32)),
        },
      ],
      ['float', clientToBackground, ask({ text: fill(MAX) })],
    ];
    for (const [role, schema, msg] of cases) {
      expect(messageBytes(msg)).toBeLessThanOrEqual(JOB_LIMITS.maxMessageBytes);
      expect(parseFrom(role, schema, msg).ok).toBe(true);
    }
  });

  it('序列化失败的消息按超限处理', () => {
    const loop: Record<string, unknown> = { type: 'config/get' };
    loop.self = loop;
    expect(messageBytes(loop)).toBe(Number.POSITIVE_INFINITY);
    expect(parseFrom('content', contentToBackground, loop)).toMatchObject({ ok: false, reason: 'tooLarge' });
  });

  it('角色授权：小窗不能查历史，侧边栏不能发起转接', () => {
    const q = { type: 'history/query', queryId: ID, limit: 20 };
    expect(parseFrom('float', clientToBackground, q)).toMatchObject({ ok: false, reason: 'notAllowed' });
    expect(parseFrom('sidepanel', clientToBackground, q).ok).toBe(true);
    const h = { type: 'handoff/start', conversationId: ID };
    expect(parseFrom('sidepanel', clientToBackground, h)).toMatchObject({ ok: false, reason: 'notAllowed' });
    const loc = { type: 'citation/locate', requestId: ID, messageId: ID, segmentIndex: 0 };
    expect(parseFrom('sidepanel', clientToBackground, loc).ok).toBe(true);
    expect(parseFrom('float', clientToBackground, loc)).toMatchObject({ ok: false, reason: 'notAllowed' });
  });

  it('握手按角色分开：小窗必须带令牌，侧边栏不能用小窗握手', () => {
    const hf = { type: 'conv/helloFloat', token: TOKEN };
    expect(parseFrom('float', clientToBackground, hf).ok).toBe(true);
    expect(parseFrom('float', clientToBackground, { type: 'conv/helloFloat' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(parseFrom('sidepanel', clientToBackground, hf)).toMatchObject({ ok: false, reason: 'notAllowed' });
    const hs = { type: 'conv/helloSidepanel', windowId: 1 };
    expect(parseFrom('sidepanel', clientToBackground, hs).ok).toBe(true);
    expect(parseFrom('float', clientToBackground, hs)).toMatchObject({ ok: false, reason: 'notAllowed' });
    // 角色只取自 sender，消息里报角色是未知字段
    expect(parseFrom('float', clientToBackground, { ...hf, role: 'sidepanel' }).ok).toBe(false);
    expect(parseFrom('unknown', clientToBackground, hf)).toMatchObject({ ok: false, reason: 'notAllowed' });
  });

  it('小窗重连：只有小窗能发，不带任何字段', () => {
    const r = { type: 'conv/resumeFloat' };
    expect(parseFrom('float', clientToBackground, r).ok).toBe(true);
    expect(parseFrom('float', clientToBackground, { ...r, token: TOKEN })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(parseFrom('float', clientToBackground, { ...r, documentId: 'x' }).ok).toBe(false);
    for (const role of ['sidepanel', 'content', 'options', 'unknown'] as const) {
      expect(parseFrom(role, clientToBackground, r)).toMatchObject({ ok: false, reason: 'notAllowed' });
    }
  });

  it('内容脚本不能发对话流消息；设置页消息只有设置页能发', () => {
    const r = parseFrom('content', clientToBackground, { type: 'conv/stop', jobId: ID });
    expect(r).toMatchObject({ ok: false, reason: 'notAllowed' });
    const t = { type: 'connection/test', connectionId: ID };
    expect(parseFrom('options', optionsToBackground, t).ok).toBe(true);
    expect(parseFrom('sidepanel', optionsToBackground, t)).toMatchObject({ ok: false, reason: 'notAllowed' });
  });

  it('发问消息完整校验；选中文字不经界面转手', () => {
    expect(parseFrom('float', clientToBackground, ask()).ok).toBe(true);
    expect(parseFrom('float', clientToBackground, ask({ selection: { text: '选区' } })).ok).toBe(false);
    expect(parseFrom('float', clientToBackground, ask({ thinking: 'max' })).ok).toBe(false);
    expect(parseFrom('float', clientToBackground, ask({ actionId: 'custom:x' })).ok).toBe(false);
    expect(parseFrom('float', clientToBackground, ask({ actionId: `custom:${ID}` })).ok).toBe(true);
  });

  it('页面模型不能自报身份（规则 7）', () => {
    const doc = { contentVersion: 'v1', title: 't', blocks: [], notes: [], textLength: 0, extractedAt: 1 };
    expect(pageDocSchema.parse(doc).ok).toBe(true);
    expect(pageDocSchema.parse({ ...doc, pageKey: 'https://a.com/' }).ok).toBe(false);
    expect(pageDocSchema.parse({ ...doc, url: 'https://a.com/' }).ok).toBe(false);
  });
});

describe('JSON 字节口径', () => {
  it('与 JSON.stringify 一致', () => {
    const samples = ['abc', '中文', '"\\', '\n\t\b\f\r', '\u0001\u001f', '😀𠀀', '\ud800', 'x\udc00y', 'é'];
    for (const s of samples) {
      expect(jsonStringBytes(s)).toBe(new TextEncoder().encode(JSON.stringify(s)).length - 2);
    }
  });

  it('切分不断开代理对，每片不超限', () => {
    const s = `${'😀'.repeat(10)}a${'字'.repeat(5)}`;
    const parts = splitByJsonBytes(s, 7);
    expect(parts.join('')).toBe(s);
    for (const p of parts) {
      expect(jsonStringBytes(p)).toBeLessThanOrEqual(7);
      expect(/\p{Cs}/u.test(p)).toBe(false);
    }
    expect(splitByJsonBytes('', 10)).toEqual(['']);
    expect(() => splitByJsonBytes('a', 5)).toThrow(RangeError);
    expect(truncateByJsonBytes('字字字', 6)).toEqual({ text: '字字', truncated: true });
    expect(truncateByJsonBytes('字', 6)).toEqual({ text: '字', truncated: false });
  });
});

describe('任务状态机', () => {
  it('终态不可覆盖', () => {
    expect(canTransition('streaming', 'completed')).toBe(true);
    expect(canTransition('completed', 'stopped')).toBe(false);
    expect(canTransition('stopped', 'completed')).toBe(false);
    expect(isTerminal('interrupted')).toBe(true);
    expect(isTerminal('streaming')).toBe(false);
  });

  it('失败、中断、停止可重试；完成的不重试（换个说法是新发问）', () => {
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('interrupted')).toBe(true);
    expect(canRetry('stopped')).toBe(true);
    expect(canRetry('completed')).toBe(false);
    expect(canRetry('streaming')).toBe(false);
  });
});

describe('站点权限', () => {
  it('按主机名匹配含子域，取更严', () => {
    const rules = [
      { host: 'example.com', level: 'noToolbar' as const },
      { host: 'secret.example.com', level: 'noRead' as const },
    ];
    expect(siteLevelFor('a.example.com', rules)).toBe('noToolbar');
    expect(siteLevelFor('x.secret.example.com', rules)).toBe('noRead');
    expect(siteLevelFor('badexample.com', rules)).toBe('normal');
  });

  it('规则归一化：去协议、路径、端口、通配前缀，拒绝顶级域与残缺 IP', () => {
    expect(normalizeSiteRule('https://Docs.Example.com/a?b#c')).toBe('docs.example.com');
    expect(normalizeSiteRule('*.example.com')).toBe('example.com');
    expect(normalizeSiteRule('example.com:8080')).toBe('example.com');
    expect(normalizeSiteRule('例子.中国')).toBe('xn--fsqu00a.xn--fiqs8s');
    expect(normalizeSiteRule('localhost')).toBe('localhost');
    expect(normalizeSiteRule('com')).toBeUndefined();
    expect(normalizeSiteRule('0.1')).toBeUndefined();
    expect(normalizeSiteRule('10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeSiteRule('[::1]:3000')).toBe('[::1]');
    expect(normalizeSiteRule('')).toBeUndefined();
  });

  it('IP 规则只精确匹配，非法规则跳过', () => {
    const rules = [
      { host: '0.0.1', level: 'noRead' as const },
      { host: 'com', level: 'noRead' as const },
      { host: '10.0.0.1', level: 'noToolbar' as const },
    ];
    expect(siteLevelFor('a.com', rules)).toBe('normal');
    expect(siteLevelFor('10.0.0.1', rules)).toBe('noToolbar');
    expect(siteLevelFor('x.10.0.0.1', rules)).toBe('normal');
  });

  it('「不读取」只允许规则建议，不允许模型建议', () => {
    expect(SITE_MATRIX.noRead.ruleSuggestions).toBe(true);
    expect(SITE_MATRIX.noRead.modelSuggestions).toBe(false);
    expect(SITE_MATRIX.noRead.readExplicitSelection).toBe(true);
  });

  it('策略变更：已发出的继续，未发出的取消', () => {
    expect(onPolicyChange(true)).toBe('continue');
    expect(onPolicyChange(false)).toBe('cancel');
  });
});

describe('pageKey', () => {
  it('去锚点与跟踪参数，保留业务参数与 #/、#! 路由', () => {
    expect(toPageKey('https://a.com/p?id=1&utm_source=x&fbclid=y#sec')).toBe('https://a.com/p?id=1');
    expect(toPageKey('https://a.com/app#/doc/3?spm=1')).toBe('https://a.com/app#/doc/3?spm=1');
    expect(toPageKey('https://a.com/app#!page')).toBe('https://a.com/app#!page');
    expect(toPageKey('https://a.com/?srsltid=1&_gl=2')).toBe('https://a.com/');
    expect(toPageKey('chrome://settings')).toBeUndefined();
  });

  it('保留的参数不重新编码', () => {
    expect(toPageKey('https://a.com/s?q=a%20b&x=1+2')).toBe('https://a.com/s?q=a%20b&x=1+2');
    expect(toPageKey('https://a.com/s?q=a%20b&utm_id=1&x=1+2')).toBe('https://a.com/s?q=a%20b&x=1+2');
    expect(toPageKey('https://a.com/s?utm%5Fsource=1&bad=%E0')).toBe('https://a.com/s?bad=%E0');
    expect(toPageKey('https://a.com/s?xsec_token=abc')).toBe('https://a.com/s?xsec_token=abc');
  });
});

describe('小窗路由', () => {
  it('失败状态走侧边栏', () => {
    expect(routeOnAsk('unknown')).toBe('float');
    expect(routeOnAsk('failedUnsupported')).toBe('sidepanel');
  });

  it('重连核对：标签页、框架、小窗文档都要对上，缺 documentId 一律拒绝', () => {
    const b = { tabId: 7, frameId: 3, floatDocumentId: 'doc-a', hostDocumentId: 'host-a', boundAt: 1 };
    expect(bindingMatches(b, { tabId: 7, frameId: 3, documentId: 'doc-a' })).toBe(true);
    expect(bindingMatches(b, { tabId: 7, frameId: 3, documentId: 'doc-b' })).toBe(false);
    expect(bindingMatches(b, { tabId: 8, frameId: 3, documentId: 'doc-a' })).toBe(false);
    expect(bindingMatches(b, { tabId: 7, frameId: 4, documentId: 'doc-a' })).toBe(false);
    expect(bindingMatches(b, { tabId: 7, frameId: 3 })).toBe(false);
    expect(bindingMatches(undefined, { tabId: 7, frameId: 3, documentId: 'doc-a' })).toBe(false);
  });
});

describe('预算', () => {
  it('未知上限按 32k；输出预留 min(4096, 20%)', () => {
    expect(defaultBudget()).toEqual({
      hardLimit: 32_000,
      outputReserve: 4096,
      speedSoftBudget: 16_000,
      summaryRead: 4800,
    });
    expect(defaultBudget(8000).outputReserve).toBe(1600);
  });

  it('非法输入退回默认值，不出现 NaN 或负数', () => {
    expect(defaultBudget(Number.NaN)).toEqual(defaultBudget());
    expect(defaultBudget(-5)).toEqual(defaultBudget());
    expect(defaultBudget(32_000, { speedSoftBudgetRatio: Number.NaN, summaryReadRatio: -1 })).toEqual(
      defaultBudget(),
    );
    expect(defaultBudget(10_000, { speedSoftBudgetRatio: 0.8 }).speedSoftBudget).toBe(8000);
  });

  it('token 估算：中日韩与全角符号按 1 字 1 个', () => {
    expect(estimateTokens('中文abcd')).toBe(Math.ceil(3 * 1.1));
    expect(estimateTokens('，。！')).toBe(Math.ceil(3 * 1.1));
    expect(estimateTokens('𠀀')).toBe(Math.ceil(1.1));
  });
});

const conn = {
  id: ID,
  name: 'x',
  preset: 'custom',
  baseUrl: 'https://x.example/v1?key=sk-q#frag',
  apiKey: 'sk-secret',
  headers: { 'X-Api-Key': 'sk-h', Authorization: 'Bearer sk-a', 'X-Trace': 'keep' },
  interfaceType: 'chatCompletions' as const,
  stream: true,
  extraParams: { access_token: 'sk-p', temperature: 0.3 },
  configVersion: 1,
};

describe('设置迁移', () => {
  it('首次安装得到默认值', () => {
    const r = migrateSettings(undefined);
    expect(r).toMatchObject({ ok: true, migratedFrom: 0 });
    if (r.ok) expect(r.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('更新版本的数据不降级覆盖', () => {
    expect(migrateSettings({ version: SETTINGS_VERSION + 1 })).toMatchObject({
      ok: false,
      error: 'newerVersion',
    });
    expect(migrateSettings('garbage')).toMatchObject({ ok: false, error: 'corrupt' });
  });

  it('缺的字段逐层补默认值，已有的保留', () => {
    const r = migrateSettings({ version: 1, reply: { lengthTier: 'brief' }, connections: [conn] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.reply).toEqual({ lengthTier: 'brief', language: 'auto', thinking: 'off' });
    expect(r.settings.connections[0]?.apiKey).toBe('sk-secret');
    expect(r.settings.toolbarActions).toEqual(['ask', 'explain', 'save']);
  });

  it('非法值判为损坏，不静默接受', () => {
    for (const bad of [
      { version: 1, reply: { lengthTier: 'huge' } },
      { version: 1, context: { speedSoftBudgetRatio: Number.NaN } },
      { version: 1, connections: [{ ...conn, interfaceType: 'grpc' }] },
      { version: 1, toolbarActions: ['rm -rf'] },
      { version: 1, unknownField: true },
    ]) {
      expect(migrateSettings(bad)).toMatchObject({ ok: false, error: 'corrupt' });
    }
  });

  it('导出默认脱敏：Key、像凭据的请求头与参数、地址查询串', () => {
    const s: Settings = { ...DEFAULT_SETTINGS, connections: [conn] };
    const c = exportSettings(s).connections[0];
    expect(c?.apiKey).toBe('');
    expect(c?.baseUrl).toBe('https://x.example/v1');
    expect(c?.headers).toEqual({ 'X-Api-Key': '', Authorization: '', 'X-Trace': 'keep' });
    expect(c?.extraParams).toEqual({ access_token: '', temperature: 0.3 });
    expect(JSON.stringify(exportSettings(s))).not.toContain('sk-');
    expect(exportSettings(s, true).connections[0]).toEqual(conn);
  });
});
