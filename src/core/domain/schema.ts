// 最小运行时校验（5.12）：core 不引第三方包，所以自带。一份定义同时给出类型（Infer）与校验。
// 只覆盖消息协议与设置需要的形状；未知字段一律拒绝（防止内容脚本夹带地址、Key 等，规则 6）。
import { jsonStringBytes } from './bytes';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Schema<T> {
  readonly parse: (v: unknown, path?: string) => Result<T>;
  readonly optional?: true;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (path: string, what: string): Result<never> => ({ ok: false, error: `${path || '$'}: ${what}` });

/** max / min 按 UTF-16 长度；maxBytes 按 JSON 编码后的字节（见 bytes.ts），能保证整条消息不超限的字段用它 */
export function str(
  opts: { max?: number; min?: number; maxBytes?: number; pattern?: RegExp } = {},
): Schema<string> {
  const { maxBytes, max = maxBytes ?? 64 * 1024, min = 0, pattern } = opts;
  return {
    parse: (v, p = '') => {
      if (typeof v !== 'string') return fail(p, '应为字符串');
      if (v.length < min || v.length > max) return fail(p, `长度应在 ${min}–${max}`);
      if (maxBytes !== undefined && jsonStringBytes(v) > maxBytes) return fail(p, `超过 ${maxBytes} 字节`);
      if (pattern && !pattern.test(v)) return fail(p, '格式不符');
      return ok(v);
    },
  };
}

export function int(opts: { min?: number; max?: number } = {}): Schema<number> {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts;
  return {
    parse: (v, p = '') =>
      typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
        ? ok(v)
        : fail(p, `应为 ${min}–${max} 的整数`),
  };
}

export function num(opts: { min?: number; max?: number } = {}): Schema<number> {
  const { min = -Infinity, max = Infinity } = opts;
  return {
    parse: (v, p = '') =>
      typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
        ? ok(v)
        : fail(p, `应为 ${min}–${max} 的数`),
  };
}

export const bool: Schema<boolean> = {
  parse: (v, p = '') => (typeof v === 'boolean' ? ok(v) : fail(p, '应为布尔值')),
};

export function lit<const T extends string | number | boolean>(value: T): Schema<T> {
  return { parse: (v, p = '') => (v === value ? ok(value) : fail(p, `应为 ${String(value)}`)) };
}

export function oneOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return {
    parse: (v, p = '') =>
      typeof v === 'string' && values.includes(v)
        ? ok(v as T[number])
        : fail(p, `应为 ${values.join(' / ')} 之一`),
  };
}

export function arr<T>(item: Schema<T>, opts: { max?: number } = {}): Schema<T[]> {
  const { max = 10_000 } = opts;
  return {
    parse: (v, p = '') => {
      if (!Array.isArray(v)) return fail(p, '应为数组');
      if (v.length > max) return fail(p, `元素不能超过 ${max} 个`);
      const out: T[] = [];
      for (let i = 0; i < v.length; i++) {
        const r = item.parse(v[i], `${p}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return ok(out);
    },
  };
}

export function opt<T>(inner: Schema<T>): Schema<T> & { optional: true } {
  return { parse: inner.parse, optional: true };
}

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends { optional: true } ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjOf<S extends Shape> = Simplify<
  { readonly [K in RequiredKeys<S>]: Infer<S[K]> } & { readonly [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

export function obj<const S extends Shape>(shape: S): Schema<ObjOf<S>> & { shape: S } {
  return {
    shape,
    parse: (v, p = '') => {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, '应为对象');
      const rec = v as Record<string, unknown>;
      // 用 hasOwn：`k in shape` 会让 constructor、toString 等原型链键通过。错误里不回显键名
      for (const k of Object.keys(rec)) if (!Object.hasOwn(shape, k)) return fail(p, '有未知字段');
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(shape)) {
        if (rec[k] === undefined) {
          if (s.optional) continue;
          return fail(`${p}.${k}`, '缺失');
        }
        const r = s.parse(rec[k], `${p}.${k}`);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      return ok(out as ObjOf<S>);
    },
  };
}

// 带标签联合：按 type 字段分派，未知类型拒绝
export function tagged<const M extends Record<string, Schema<object>>>(
  variants: M,
): Schema<{ [K in keyof M]: Infer<M[K]> }[keyof M]> & { variants: M } {
  return {
    variants,
    parse: (v, p = '') => {
      const t = typeof v === 'object' && v !== null ? (v as { type?: unknown }).type : undefined;
      if (typeof t !== 'string' || !Object.hasOwn(variants, t)) return fail(`${p}.type`, '未知消息类型');
      return (variants[t] as Schema<{ [K in keyof M]: Infer<M[K]> }[keyof M]>).parse(v, p);
    },
  };
}

/** 键值表（如请求头）。键只做长度限制；值按 value 校验 */
export function rec<T>(
  value: Schema<T>,
  opts: { maxKeys?: number; maxKey?: number } = {},
): Schema<Record<string, T>> {
  const { maxKeys = 100, maxKey = 200 } = opts;
  return {
    parse: (v, p = '') => {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, '应为对象');
      const entries = Object.entries(v);
      if (entries.length > maxKeys) return fail(p, `键不能超过 ${maxKeys} 个`);
      const out: Record<string, T> = {};
      for (const [k, x] of entries) {
        if (k.length > maxKey || k === '__proto__') return fail(p, '键不合法');
        const r = value.parse(x, `${p}[]`);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      return ok(out);
    },
  };
}

/** 任意 JSON 值（如额外请求参数）；只限深度 */
export const jsonValue: Schema<unknown> = {
  parse: (v, p = '') => (isJson(v, 0) ? ok(v) : fail(p, '应为 JSON 值')),
};
function isJson(v: unknown, depth: number): boolean {
  if (depth > 20) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJson(x, depth + 1));
  if (typeof v === 'object') return Object.values(v).every((x) => isJson(x, depth + 1));
  return false;
}
