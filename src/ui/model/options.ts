// 模型下拉的纯逻辑（H4、H5、contract-v1.5 增量；本次只在界面里临时切换，不走 conv/setModel——
// 该消息类型本版本后台不处理，见 background/conv.ts）：按连接分组常用模型、搜索过滤、换模型再试
// 的候选（H12）、思考控件随模型能力变化（H6）。不碰扩展 API，便于单测。

import type { ThinkingLevel } from '@/core/context/plan';
import type { Connection, ModelCapabilities, ModelErrorKind, ModelRef } from '@/core/llm/adapter';
import { effectiveCapabilities } from '@/core/llm/capabilities';

export interface ModelGroup {
  connectionId: string;
  connectionName: string;
  models: readonly string[];
}

/** 超过这么多常用模型才显示搜索框（H4：「列表可搜索（勾选多的时候）」） */
export const SEARCH_THRESHOLD = 8;

/** 按连接分组用户勾选的常用模型；没勾选过的连接不出现在结果里 */
export function modelGroups(connections: readonly Connection[]): ModelGroup[] {
  return connections
    .map((c) => ({ connectionId: c.id, connectionName: c.name, models: c.models ?? [] }))
    .filter((g) => g.models.length > 0);
}

export function totalModels(groups: readonly ModelGroup[]): number {
  return groups.reduce((n, g) => n + g.models.length, 0);
}

export function sameModel(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return !!a && !!b && a.connectionId === b.connectionId && a.model === b.model;
}

/** 搜索过滤：模型标识或连接名包含关键字（大小写不敏感）；命中连接名时这个连接下的模型全留着 */
export function filterGroups(groups: readonly ModelGroup[], query: string): ModelGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups as ModelGroup[];
  return groups
    .map((g) =>
      g.connectionName.toLowerCase().includes(q)
        ? g
        : { ...g, models: g.models.filter((m) => m.toLowerCase().includes(q)) },
    )
    .filter((g) => g.models.length > 0);
}

export interface SwitchCandidate {
  ref: ModelRef;
  label: string;
}

/**
 * H12：默认模型连不上时才建议换模型——按错误分类判断（连不上、鉴权失败、服务端出错、地址多半不对
 * 这类，换个模型/连接大概率能避开）。中途断流、没有正文、参数被拒、内容超限、用户自己中止的不建议——
 * 换模型大概率解决不了，瞎建议反而误导
 */
export const MODEL_SWITCH_ERROR_KINDS: ReadonlySet<ModelErrorKind> = new Set<ModelErrorKind>([
  'network',
  'timeout',
  'auth',
  'server',
  'htmlInsteadOfJson',
  'notFound',
  'badResponse',
  'redirected',
  'rateLimited',
]);

/**
 * 「换个模型再试」（H12）的候选：常用模型里排除这次失败的那一个；别的连接的排在前面
 * （同一个连接大概率是同样连不上，排后面仅作补充）
 */
export function switchCandidates(connections: readonly Connection[], failed: ModelRef): SwitchCandidate[] {
  const rows: (SwitchCandidate & { otherConn: boolean })[] = [];
  for (const g of modelGroups(connections)) {
    for (const m of g.models) {
      if (g.connectionId === failed.connectionId && m === failed.model) continue;
      rows.push({
        ref: { connectionId: g.connectionId, model: m },
        label: `${g.connectionName} · ${m}`,
        otherConn: g.connectionId !== failed.connectionId,
      });
    }
  }
  rows.sort((a, b) => Number(b.otherConn) - Number(a.otherConn));
  return rows.map(({ ref, label }) => ({ ref, label }));
}

/** 所选模型的有效能力；没有模型（没有连接）或它指向的连接不存在（已被删）时为 null，按「未知」处理 */
export function capabilitiesFor(
  connections: readonly Connection[],
  model: ModelRef | null,
): ModelCapabilities | null {
  const conn = model && connections.find((c) => c.id === model.connectionId);
  return conn && model ? effectiveCapabilities(conn, model.model) : null;
}

export type ThinkingControlMode = 'full' | 'toggle' | 'disabled';

/** 思考控件随模型能力变化（H6）：开关只显示关/开；无思考的禁用；未知（或连接没了）照常四档 */
export function thinkingControlMode(capability: ModelCapabilities | null): ThinkingControlMode {
  if (capability?.thinking === 'toggle') return 'toggle';
  if (capability?.thinking === 'none') return 'disabled';
  return 'full';
}

/**
 * 按控件模式换算实际要发送的思考强度：开关类模型只认「关/非关」，各档都按「开」处理（5.8，
 * thinking.ts 的 qwen 分支同一个道理）；不支持思考的模型强制关闭；其余模式原样发送
 */
export function clampThinking(mode: ThinkingControlMode, level: ThinkingLevel): ThinkingLevel {
  if (mode === 'disabled') return 'off';
  if (mode === 'toggle') return level === 'off' ? 'off' : 'medium';
  return level;
}
