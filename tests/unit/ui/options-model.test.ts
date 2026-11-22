// 设置页表单的纯逻辑（src/ui/options/model.ts）：连接增删改、常用模型与能力覆盖、提示词覆盖与恢复默认、
// 自定义动作校验、工具栏排序、站点规则、快捷键列表。每组操作之后的设置都要能通过设置结构的整体校验（migrateSettings）。
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migrateSettings, type Settings } from '@/core/domain/settings';
import type { Connection } from '@/core/llm/adapter';
import { PROMPT_REGISTRY } from '@/core/prompt/ask';
import { causesOf, netErrorCause } from '@/ui/options/diagnose';
import {
  actionRows,
  applyPreset,
  asConnectionTestResult,
  asListModelsResult,
  blankConnection,
  type CustomActionDraft,
  capabilityRow,
  displayBaseUrl,
  filterModels,
  headerRows,
  headersFromRows,
  isIpv6Rule,
  MAX_COMMON_MODELS,
  mergeConnectionForm,
  modelChoices,
  moveToolbarAction,
  NEW_CONNECTION_NAME,
  parseExtraParams,
  promptText,
  removeConnection,
  removeCustomAction,
  resetPrompt,
  resolveApiKey,
  setActionHidden,
  setCapabilityOverride,
  setDefaultModel,
  setOnToolbar,
  setPromptOverride,
  shortcutRows,
  shortcutsPageUrl,
  toggleCommonModel,
  toolbarOrder,
  toolbarPlacement,
  upsertConnection,
  upsertCustomAction,
  upsertSiteRule,
  validateCustomAction,
} from '@/ui/options/model';
import { S } from '@/ui/options/strings';

const base = (): Settings => structuredClone(DEFAULT_SETTINGS);
const ID_A = 'conn-aaaa-0001';
const ID_B = 'conn-bbbb-0002';
const conn = (id: string, over: Partial<Connection> = {}): Connection => ({
  ...blankConnection(id),
  name: `连接 ${id}`,
  baseUrl: 'https://relay.test/v1',
  apiKey: 'sk-test',
  ...over,
});
/** 结果必须是一份合法的设置（能原样通过迁移与校验） */
function expectValid(s: Settings): void {
  const r = migrateSettings(structuredClone(s));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.settings).toEqual(s);
}

describe('连接：预设、增删改', () => {
  it('新连接按预设带出地址与名字；自定义不带地址', () => {
    expect(blankConnection(ID_A, 'deepseek')).toMatchObject({
      id: ID_A,
      preset: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      stream: true,
      configVersion: 0,
    });
    expect(blankConnection(ID_A)).toMatchObject({ preset: 'custom', name: NEW_CONNECTION_NAME, baseUrl: '' });
  });

  it('换预设：自动起的名字跟着换，用户自己起的名字不动；换成自定义不清空地址', () => {
    const auto = applyPreset(blankConnection(ID_A, 'deepseek'), 'qwen');
    expect(auto.name).toBe('通义千问（阿里云百炼）');
    expect(auto.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    const named = applyPreset({ ...blankConnection(ID_A, 'deepseek'), name: '我的连接' }, 'openai');
    expect(named).toMatchObject({ name: '我的连接', preset: 'openai', baseUrl: 'https://api.openai.com/v1' });
    const custom = applyPreset(named, 'custom');
    expect(custom).toMatchObject({
      preset: 'custom',
      baseUrl: 'https://api.openai.com/v1',
      name: '我的连接',
    });
    expect(applyPreset(named, 'no-such-preset')).toBe(named);
  });

  it('新增：加在最后，配置版本从 0 起；名字留空补默认名，地址去掉首尾空格', () => {
    const { settings, saved } = upsertConnection(
      base(),
      conn(ID_A, { name: '  ', baseUrl: ' https://a.test/v1 ' }),
    );
    expect(settings.connections).toEqual([saved]);
    expect(saved).toMatchObject({
      name: NEW_CONNECTION_NAME,
      baseUrl: 'https://a.test/v1',
      configVersion: 0,
    });
    expectValid(settings);
  });

  it('修改：只改名字不动配置版本；改地址、Key、请求头、额外参数、逐字输出都让配置版本加一', () => {
    let s = upsertConnection(base(), conn(ID_A)).settings;
    s = upsertConnection(s, conn(ID_B)).settings;
    const renamed = upsertConnection(s, conn(ID_A, { name: '改名' }));
    expect(renamed.saved.configVersion).toBe(0);
    expect(renamed.settings.connections.map((c) => c.id)).toEqual([ID_A, ID_B]);
    const changes: Partial<Connection>[] = [
      { baseUrl: 'https://other.test/v1' },
      { apiKey: 'sk-new' },
      { headers: { 'x-team': 'a' } },
      { extraParams: { temperature: 0.2 } },
      { stream: false },
    ];
    for (const change of changes) {
      expect(upsertConnection(s, conn(ID_A, change)).saved.configVersion).toBe(1);
    }
    expectValid(renamed.settings);
  });

  it('删除：默认模型、辅助模型指向它的一并清掉，指向别的连接的保留', () => {
    let s = upsertConnection(base(), conn(ID_A)).settings;
    s = upsertConnection(s, conn(ID_B)).settings;
    s = {
      ...setDefaultModel(s, { connectionId: ID_A, model: 'm1' }),
      auxModel: { connectionId: ID_B, model: 'm2' },
    };
    const removedA = removeConnection(s, ID_A);
    expect(removedA.connections.map((c) => c.id)).toEqual([ID_B]);
    expect(removedA.defaultModel).toBeUndefined();
    expect('defaultModel' in removedA).toBe(false);
    expect(removedA.auxModel).toEqual({ connectionId: ID_B, model: 'm2' });
    const removedB = removeConnection(s, ID_B);
    expect(removedB.defaultModel).toEqual({ connectionId: ID_A, model: 'm1' });
    expect('auxModel' in removedB).toBe(false);
    expectValid(removedA);
    expectValid(removedB);
  });

  it('Key 输入框不回显：留空沿用已存的，填了替换，点清除才清空', () => {
    expect(resolveApiKey('sk-stored', '', false)).toBe('sk-stored');
    expect(resolveApiKey('sk-stored', 'sk-new', false)).toBe('sk-new');
    expect(resolveApiKey('sk-stored', 'sk-new', true)).toBe('');
    expect(resolveApiKey('', '', false)).toBe('');
  });

  it('保存草稿以存储里最新的连接为底：之后勾选的常用模型、能力覆盖不被旧草稿冲掉', () => {
    const draft = conn(ID_A, { name: '草稿里改的名字' });
    const stored = setCapabilityOverride(toggleCommonModel(conn(ID_A), 'm1', true), 'm1', { vision: 'yes' });
    const merged = mergeConnectionForm({ ...stored, configVersion: 3 }, draft);
    expect(merged).toMatchObject({
      name: '草稿里改的名字',
      models: ['m1'],
      capabilityOverrides: { m1: { vision: 'yes' } },
      configVersion: 3,
    });
    expect(mergeConnectionForm(undefined, draft)).toEqual(draft);
  });

  it('地址只显示到路径：查询串里的 Key 不显示', () => {
    expect(displayBaseUrl('https://relay.test:8443/v1?key=secret#x')).toBe('https://relay.test:8443/v1');
    expect(displayBaseUrl('不是地址?key=secret')).toBe('不是地址');
  });
});

describe('自定义请求头、额外请求参数', () => {
  it('请求头：空名字的行忽略；名字不合法、重复（不分大小写）报错', () => {
    expect(
      headersFromRows([
        { name: ' X-Team ', value: 'a' },
        { name: '', value: '没填名字' },
      ]),
    ).toEqual({
      ok: true,
      headers: { 'X-Team': 'a' },
    });
    expect(headersFromRows([{ name: 'bad name', value: '1' }])).toMatchObject({ ok: false });
    expect(
      headersFromRows([
        { name: 'X-A', value: '1' },
        { name: 'x-a', value: '2' },
      ]),
    ).toMatchObject({ ok: false });
    expect(headerRows({ a: '1', b: '2' })).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
  });

  it('额外参数：留空是空对象；必须是 JSON 对象；受保护字段报出来（不删）', () => {
    expect(parseExtraParams('  ', 'chatCompletions')).toEqual({ ok: true, value: {}, ignored: [] });
    expect(parseExtraParams('{"temperature":0.3}', 'chatCompletions')).toEqual({
      ok: true,
      value: { temperature: 0.3 },
      ignored: [],
    });
    expect(parseExtraParams('{"model":"x","stream":false,"top_p":1}', 'chatCompletions')).toMatchObject({
      ok: true,
      ignored: ['model', 'stream'],
    });
    for (const bad of ['{', '[1]', '"x"', 'null', '3']) {
      expect(parseExtraParams(bad, 'chatCompletions').ok).toBe(false);
    }
  });
});

describe('常用模型与能力覆盖', () => {
  it('勾选、取消；重复勾选不变；满 50 个不再加', () => {
    let c = toggleCommonModel(conn(ID_A), ' m1 ', true);
    expect(c.models).toEqual(['m1']);
    expect(toggleCommonModel(c, 'm1', true)).toBe(c);
    c = toggleCommonModel(c, 'm2', true);
    expect(toggleCommonModel(c, 'm1', false).models).toEqual(['m2']);
    expect(toggleCommonModel(c, '', true)).toBe(c);
    const full = { ...conn(ID_A), models: Array.from({ length: MAX_COMMON_MODELS }, (_, i) => `m${i}`) };
    expect(toggleCommonModel(full, 'one-more', true)).toBe(full);
    expectValid(upsertConnection(base(), full).settings);
  });

  it('搜索：空格分词、全部命中、不分大小写', () => {
    const models = ['deepseek-chat', 'deepseek-reasoner', 'Qwen-Plus', 'gpt-4o-mini'];
    expect(filterModels(models, '')).toEqual(models);
    expect(filterModels(models, 'DEEP rea')).toEqual(['deepseek-reasoner']);
    expect(filterModels(models, 'qwen')).toEqual(['Qwen-Plus']);
    expect(filterModels(models, 'nothing')).toEqual([]);
  });

  it('覆盖只写改过的字段；改回「跟随内置」删掉那一项，删空了不留字段', () => {
    let c = setCapabilityOverride(conn(ID_A), 'my-model', { thinking: 'effort' });
    c = setCapabilityOverride(c, 'my-model', { contextWindow: 64_000 });
    c = setCapabilityOverride(c, 'other', { vision: 'yes' });
    expect(c.capabilityOverrides).toEqual({
      'my-model': { thinking: 'effort', contextWindow: 64_000 },
      other: { vision: 'yes' },
    });
    expectValid(upsertConnection(base(), c).settings);
    const row = capabilityRow(c, 'my-model');
    expect(row.builtin).toMatchObject({ thinking: 'unknown', vision: 'unknown' });
    expect(row.effective).toMatchObject({ thinking: 'effort', vision: 'unknown', contextWindow: 64_000 });
    expect(row.overridden).toEqual({ thinking: true, vision: false, contextWindow: true });

    c = setCapabilityOverride(c, 'my-model', { thinking: undefined, contextWindow: undefined });
    expect(c.capabilityOverrides).toEqual({ other: { vision: 'yes' } });
    c = setCapabilityOverride(c, 'other', { vision: undefined });
    expect('capabilityOverrides' in c).toBe(false);
  });

  it('内置能认出的模型：未覆盖时显示内置判断', () => {
    const row = capabilityRow(conn(ID_A), 'deepseek-reasoner');
    expect(row.effective.thinking).toBe('effort');
    expect(row.overridden).toEqual({ thinking: false, vision: false, contextWindow: false });
  });

  it('默认模型下拉：各连接勾选的常用模型，加上当前默认模型（没勾选也要显示）', () => {
    let s = upsertConnection(base(), { ...conn(ID_A, { name: '甲' }), models: ['m1', 'm2'] }).settings;
    s = upsertConnection(s, conn(ID_B, { name: '乙' })).settings;
    expect(modelChoices(s).map((c) => c.label)).toEqual(['甲 · m1', '甲 · m2']);
    s = setDefaultModel(s, { connectionId: ID_B, model: 'only-default' });
    expect(modelChoices(s).map((c) => c.label)).toEqual(['甲 · m1', '甲 · m2', '乙 · only-default']);
    expectValid(s);
  });
});

describe('提示词覆盖与恢复默认', () => {
  const def = PROMPT_REGISTRY[0];
  if (!def) throw new Error('提示词登记表为空');

  it('保存：只存改过的；恢复默认：删掉覆盖', () => {
    const s = setPromptOverride(base(), def.id, '我改过的规则');
    expect(s.promptOverrides).toEqual({ [def.id]: '我改过的规则' });
    expect(promptText(s, def)).toBe('我改过的规则');
    expectValid(s);
    const back = resetPrompt(s, def.id);
    expect(back.promptOverrides).toEqual({});
    expect(promptText(back, def)).toBe(def.defaultText);
    expect(resetPrompt(back, def.id)).toBe(back);
  });

  it('清空、或改回和默认一样：等于恢复默认，不留一条多余的覆盖', () => {
    const s = setPromptOverride(base(), def.id, '改过');
    expect(setPromptOverride(s, def.id, '   ').promptOverrides).toEqual({});
    expect(setPromptOverride(s, def.id, def.defaultText).promptOverrides).toEqual({});
  });

  it('登记表里没有的编号不收；别的覆盖不受影响', () => {
    const s = setPromptOverride(base(), def.id, '改过');
    expect(setPromptOverride(s, 'no-such-prompt', 'x')).toBe(s);
    const other = PROMPT_REGISTRY[1];
    if (!other) throw new Error('登记表至少两条');
    const two = setPromptOverride(s, other.id, '另一条');
    expect(resetPrompt(two, def.id).promptOverrides).toEqual({ [other.id]: '另一条' });
  });
});

describe('工具栏排序与停用', () => {
  it('列表：工具栏上的在前（按顺序），其余在后；「解释代码」不参与排序', () => {
    const rows = actionRows(base());
    expect(rows.map((r) => r.def.id)).toEqual([
      'ask',
      'explain',
      'save',
      'summarizePage',
      'keyPoints',
      'pageAbout',
      'translate',
    ]);
    expect(rows.map((r) => r.toolbarIndex)).toEqual([0, 1, 2, -1, -1, -1, -1]);
  });

  it('前移、后移；到头不动；不在工具栏上的不动', () => {
    let s = moveToolbarAction(base(), 'save', -1);
    expect(s.toolbarActions).toEqual(['ask', 'save', 'explain']);
    s = moveToolbarAction(s, 'save', -1);
    expect(s.toolbarActions).toEqual(['save', 'ask', 'explain']);
    expect(moveToolbarAction(s, 'save', -1).toolbarActions).toEqual(['save', 'ask', 'explain']);
    expect(moveToolbarAction(s, 'explain', 1).toolbarActions).toEqual(['save', 'ask', 'explain']);
    expect(moveToolbarAction(s, 'translate', 1).toolbarActions).toEqual(['save', 'ask', 'explain']);
    expectValid(s);
  });

  it('放上工具栏排在最后，移出后不留；重复放不重复', () => {
    let s = setOnToolbar(base(), 'translate', true);
    expect(s.toolbarActions).toEqual(['ask', 'explain', 'save', 'translate']);
    expect(setOnToolbar(s, 'translate', true).toolbarActions).toEqual([
      'ask',
      'explain',
      'save',
      'translate',
    ]);
    s = setOnToolbar(s, 'explain', false);
    expect(s.toolbarActions).toEqual(['ask', 'save', 'translate']);
    expectValid(s);
  });

  it('设置里残留的不存在的动作、重复项：排序时丢掉', () => {
    const s: Settings = { ...base(), toolbarActions: ['ask', 'custom:gone-0000', 'ask', 'save'] };
    expect(toolbarOrder(s)).toEqual(['ask', 'save']);
    expect(moveToolbarAction(s, 'save', -1).toolbarActions).toEqual(['save', 'ask']);
  });

  it('停用：不占工具栏位置；超过 5 个时前 4 个显示，其余进「更多」', () => {
    let s = base();
    for (const id of ['summarizePage', 'keyPoints', 'pageAbout'] as const) s = setOnToolbar(s, id, true);
    // 6 个：ask explain save summarizePage | keyPoints pageAbout 进更多
    const six = toolbarPlacement(s);
    expect(six.get('summarizePage')).toEqual({ position: 4, overflow: false });
    expect(six.get('keyPoints')).toEqual({ position: 5, overflow: true });
    expect(six.get('pageAbout')).toEqual({ position: 6, overflow: true });
    // 停用一个剩 5 个：全部显示
    s = setActionHidden(s, 'explain', true);
    const five = toolbarPlacement(s);
    expect(five.has('explain')).toBe(false);
    expect([...five.values()].every((p) => !p.overflow)).toBe(true);
    expect(five.get('pageAbout')).toEqual({ position: 5, overflow: false });
    expect(actionRows(s).find((r) => r.def.id === 'explain')?.hidden).toBe(true);
    expect(setActionHidden(s, 'explain', false).hiddenActions).toEqual([]);
    expectValid(s);
  });
});

describe('自定义动作', () => {
  const draft = (over: Partial<CustomActionDraft> = {}): CustomActionDraft => ({
    label: '大白话',
    prompt: '把选中的内容改写成通俗易懂的大白话。',
    scope: 'selection',
    needsInput: false,
    ...over,
  });
  const UUID = '0b0c4a1e-7d57-4c0b-9a57-1f0f5a3c9e21';

  it('校验：名字必填、不超过 40 字、不与内置或其他自定义动作重名；提示词必填', () => {
    expect(validateCustomAction(draft(), base())).toEqual({});
    expect(validateCustomAction(draft({ label: '  ' }), base()).label).toBeTruthy();
    expect(validateCustomAction(draft({ label: '字'.repeat(41) }), base()).label).toBeTruthy();
    expect(validateCustomAction(draft({ label: '字'.repeat(40) }), base())).toEqual({});
    expect(validateCustomAction(draft({ label: '解释' }), base()).label).toBeTruthy();
    expect(validateCustomAction(draft({ prompt: ' \n ' }), base()).prompt).toBeTruthy();
    expect(validateCustomAction(draft({ prompt: 'x'.repeat(20_001) }), base()).prompt).toBeTruthy();
    const withOne = upsertCustomAction(base(), draft(), UUID);
    expect(validateCustomAction(draft(), withOne).label).toBeTruthy();
    // 编辑自己不算重名
    expect(validateCustomAction(draft({ id: `custom:${UUID}` }), withOne)).toEqual({});
  });

  it('数量上限 100：新建被拦，编辑已有的不拦', () => {
    let s = base();
    for (let i = 0; i < 100; i++)
      s = upsertCustomAction(
        s,
        draft({ label: `动作${i}` }),
        `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
    expect(validateCustomAction(draft({ label: '第 101 个' }), s).count).toBeTruthy();
    const first = s.customActions[0];
    if (!first) throw new Error('没有动作');
    expect(validateCustomAction(draft({ id: first.id as `custom:${string}`, label: '改名' }), s)).toEqual({});
    expectValid(s);
  });

  it('新建：进自定义列表并排到工具栏最后；修改：原位更新，工具栏顺序不变', () => {
    let s = upsertCustomAction(base(), draft({ label: ' 大白话 ', scope: 'page', needsInput: true }), UUID);
    const id = `custom:${UUID}` as const;
    expect(s.customActions).toEqual([
      {
        id,
        label: '大白话',
        kind: 'model',
        needsInput: true,
        scope: 'page',
        promptOverride: '把选中的内容改写成通俗易懂的大白话。',
      },
    ]);
    expect(s.toolbarActions).toEqual(['ask', 'explain', 'save', id]);
    expectValid(s);
    s = moveToolbarAction(s, id, -1);
    s = upsertCustomAction(s, draft({ id, label: '改名了', prompt: '新的提示词' }), 'ignored-uuid-0000');
    expect(s.customActions).toHaveLength(1);
    expect(s.customActions[0]).toMatchObject({ id, label: '改名了', promptOverride: '新的提示词' });
    expect(s.toolbarActions).toEqual(['ask', 'explain', id, 'save']);
    expect(actionRows(s).find((r) => r.def.id === id)).toMatchObject({ custom: true, toolbarIndex: 2 });
    expectValid(s);
  });

  it('删除：连同工具栏顺序与停用表里的编号', () => {
    const id = `custom:${UUID}` as const;
    let s = upsertCustomAction(base(), draft(), UUID);
    s = setActionHidden(s, id, true);
    s = removeCustomAction(s, id);
    expect(s.customActions).toEqual([]);
    expect(s.toolbarActions).toEqual(['ask', 'explain', 'save']);
    expect(s.hiddenActions).toEqual([]);
    expectValid(s);
  });
});

describe('网站黑名单', () => {
  it('归一后加入；同一主机改级别而不是加两条；不合法返回 undefined', () => {
    const one = upsertSiteRule([], 'https://Example.com/page?x=1', 'noToolbar');
    expect(one).toEqual([{ host: 'example.com', level: 'noToolbar' }]);
    expect(upsertSiteRule(one ?? [], 'example.com', 'noRead')).toEqual([
      { host: 'example.com', level: 'noRead' },
    ]);
    expect(upsertSiteRule([], 'com', 'noRead')).toBeUndefined();
    expect(upsertSiteRule([], '', 'noRead')).toBeUndefined();
  });

  it('IPv6 字面量：能加，但要提示「不弹工具栏」对它不生效', () => {
    const rules = upsertSiteRule([], '[::1]', 'noToolbar');
    expect(rules).toEqual([{ host: '[::1]', level: 'noToolbar' }]);
    expect(isIpv6Rule('[::1]')).toBe(true);
    expect(isIpv6Rule('example.com')).toBe(false);
  });
});

describe('测试连接：应答解析与原因说明（H9）', () => {
  it('形状不对的应答返回 null；带建议地址的失败保留建议地址', () => {
    expect(asConnectionTestResult(undefined)).toBeNull();
    expect(asConnectionTestResult({ ok: true })).toBeNull();
    expect(asConnectionTestResult({ ok: false, reason: 'notAllowed' })).toBeNull();
    expect(
      asConnectionTestResult({
        ok: false,
        error: { kind: 'htmlInsteadOfJson', status: 200 },
        elapsedMs: 12,
        suggestedBaseUrl: 'https://relay.test/v1',
      }),
    ).toEqual({
      ok: false,
      error: { kind: 'htmlInsteadOfJson', status: 200 },
      elapsedMs: 12,
      suggestedBaseUrl: 'https://relay.test/v1',
    });
    expect(asListModelsResult({ ok: true, models: ['a', 'b'] })).toEqual({ ok: true, models: ['a', 'b'] });
    expect(asListModelsResult({ ok: true, models: [1] })).toEqual({ ok: false });
    expect(asListModelsResult({ ok: false, error: { kind: 'auth', status: 401 } })).toEqual({
      ok: false,
      error: { kind: 'auth', status: 401 },
    });
  });

  it('网络层按浏览器错误码细分：解析、连不上、证书、代理；认不出的给笼统说明', () => {
    expect(netErrorCause('net::ERR_NAME_NOT_RESOLVED')).toBe(S.cause.netDns);
    expect(netErrorCause('net::ERR_CONNECTION_REFUSED')).toBe(S.cause.netConnect);
    expect(netErrorCause('net::ERR_CONNECTION_TIMED_OUT')).toBe(S.cause.netConnect);
    expect(netErrorCause('net::ERR_CERT_AUTHORITY_INVALID')).toBe(S.cause.netCert);
    expect(netErrorCause('net::ERR_SSL_PROTOCOL_ERROR')).toBe(S.cause.netCert);
    expect(netErrorCause('net::ERR_PROXY_CONNECTION_FAILED')).toBe(S.cause.netProxy);
    expect(netErrorCause('net::ERR_TUNNEL_CONNECTION_FAILED')).toBe(S.cause.netProxy);
    expect(netErrorCause('net::ERR_FAILED')).toBe(S.cause.network);
    expect(netErrorCause(undefined)).toBe(S.cause.network);
  });

  it('每类错误都有原因说明；可疑参数另起一句', () => {
    expect(causesOf({ kind: 'htmlInsteadOfJson', status: 200 })[0]).toContain('/v1');
    expect(causesOf({ kind: 'auth', status: 401 })[0]).toContain('Key');
    expect(causesOf({ kind: 'network', netError: 'net::ERR_NAME_NOT_RESOLVED' })).toEqual([S.cause.netDns]);
    expect(causesOf({ kind: 'paramRejected', suspectParam: 'reasoning_effort' })).toEqual([
      S.cause.paramRejected,
      S.cause.suspectParam('reasoning_effort'),
    ]);
  });
});

describe('快捷键列表（L4）', () => {
  it('列出四个命令的实际按键；有建议键位却没绑上的标出来，本来就没预设的不算', () => {
    const rows = shortcutRows([
      { name: '_execute_action', shortcut: '' },
      { name: 'open-float', shortcut: 'Alt+Shift+S' },
      { name: 'toggle-sidepanel', shortcut: 'Ctrl+Shift+Y' },
      { name: 'capture-region', shortcut: '' },
      { name: 'summarize-page', shortcut: '' },
    ]);
    expect(rows.map((r) => [r.name, r.shortcut, r.unbound])).toEqual([
      ['open-float', 'Alt+Shift+S', false],
      ['toggle-sidepanel', 'Ctrl+Shift+Y', false],
      ['capture-region', '', true],
      ['summarize-page', '', false],
    ]);
  });

  it('浏览器没给出某个命令时按没绑上处理', () => {
    expect(shortcutRows([]).map((r) => r.unbound)).toEqual([true, true, true, false]);
  });

  it('快捷键设置页地址：Edge 用 edge://，其余用 chrome://', () => {
    expect(shortcutsPageUrl('Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toBe(
      'edge://extensions/shortcuts',
    );
    expect(shortcutsPageUrl('Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36')).toBe(
      'chrome://extensions/shortcuts',
    );
  });
});
