// 怪癖学习的纯逻辑（5.8 AR-09）：参数被拒自动重试成功后记下来，同一连接 + 接口类型 + 模型 +
// 配置版本（capabilityKey）的后续请求预先不发这个参数；一个连接学到的不影响另一连接，配置版本
// 变了自然失效（键里带着它）。这里只管「一张表怎么增删查」，不碰存储——持久化在
// background/quirk-store.ts（storage.local，独立键，配置版本变化不需要显式清理旧键）。
import type { Connection } from './adapter';
import { capabilityKey } from './adapter';

export type QuirksTable = Readonly<Record<string, readonly string[]>>;

export const EMPTY_QUIRKS: QuirksTable = {};

/** 这个连接 + 模型已经学到的、应该预先不发的参数名 */
export function quirksFor(
  table: QuirksTable,
  conn: Pick<Connection, 'id' | 'interfaceType' | 'configVersion'>,
  model: string,
): readonly string[] {
  return table[capabilityKey(conn, model)] ?? [];
}

/** 记一条新学到的怪癖；已经记过的原样返回（不产生新对象，调用方可按引用判断有没有变化） */
export function withQuirk(
  table: QuirksTable,
  conn: Pick<Connection, 'id' | 'interfaceType' | 'configVersion'>,
  model: string,
  param: string,
): QuirksTable {
  const key = capabilityKey(conn, model);
  const existing = table[key] ?? [];
  if (existing.includes(param)) return table;
  return { ...table, [key]: [...existing, param] };
}
