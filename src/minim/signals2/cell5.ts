// cell5.ts — minimal struct factory built on alien-signals (engine2).
//
// One reactive primitive (`Cell<T>`): a callable signal carrying
// peek/follow/mirror methods. Typed cells extend the bare proto with
// user methods, getters, and per-field lenses (with alien's computed-
// equality propagation giving us per-field subscription for free).

import { signal, computed, lens, effect, batch, signalProto, type SignalFn } from "./engine2";
import type { CommonTraits } from "./traits";

export type { SignalFn, CommonTraits };
export type { Linear, Lerp, Metric, Equals } from "./traits";
export { signal, computed, lens, effect, batch };

// ── Public types ────────────────────────────────────────────────────

export type Val<T> = T | (() => T);
export type RO<T> = (() => T) & { peek(): T };

type Val_<X> = X extends Type<infer U, any> ? U : X extends FieldSpec<infer U> ? U : X;
type ShapeOf<V> = V extends Record<string, any> ? V extends Function ? V : { [K in keyof V]: Val_<V[K]> } : V;
type Lift<M, T> = { readonly [K in keyof M]: M[K] extends (self: T, ...a: infer A) => infer R ? (...a: A) => RO<R> : never };
type Get<G> = { readonly [K in keyof G]: G[K] extends (this: any) => infer R ? R : never };
type Fields<V> = V extends Record<string, any> ? V extends Function ? {} : { readonly [K in keyof V]: Cell<Val_<V[K]>> } : {};

export type Cell<T, Cfg = unknown> = SignalFn<T>
  & { raw(): Chain<T, Cfg> }
  & (Cfg extends { value: infer V } ? Fields<V> : {})
  & (Cfg extends { methods: infer M } ? Lift<M, T> : {})
  & (Cfg extends { getters: infer G } ? Get<G> : {});

export type Type<T = any, Cfg = unknown> = (Cfg extends { methods: infer M } ? M : {}) & {
  readonly tag: string;
  readonly value: any;
  readonly traits: Cfg extends { traits: infer Tr } ? Tr : {};
  readonly prototype: any;
  (init?: Partial<T>): Cell<T, Cfg>;
  is(v: unknown): v is Cell<T, Cfg>;
  with(init: T): FieldSpec<T>;
  /** Wrap a plain value into a fluent chain handle (~5ns/step, ~40B).
   *  Each method call mutates `.value` and returns the same handle. */
  chain(v: T): Chain<T, Cfg>;
};

/** Chain handle for fluent plain math. `.value` extracts. */
export type Chain<T, Cfg> = { value: T } & (Cfg extends { methods: infer M }
  ? { [K in keyof M]: M[K] extends (self: T, ...a: infer A) => infer R
      ? R extends T ? (...a: A) => Chain<T, Cfg> : (...a: A) => R
      : never }
  : {});

export interface FieldSpec<T = any> { readonly [BRAND]: "field"; readonly type: Type<T, any>; readonly init: T }

export interface StructDef<T = any> {
  tag: string;
  value: any;
  methods?: Record<string, (self: T, ...args: any[]) => any>;
  getters?: Record<string, (this: any) => any>;
  traits?: CommonTraits<T> & Record<string, unknown>;
}

// ── Detection ──────────────────────────────────────────────────────

const BRAND = Symbol.for("minim.struct.v5");
const isType = (v: any): boolean => typeof v === "function" && v[BRAND] === "type";
const isFieldSpec = (v: any): v is FieldSpec => v != null && typeof v === "object" && v[BRAND] === "field";
const isAnyCell = (v: any): boolean => typeof v === "function" && Object.getPrototypeOf(v)?.[BRAND] === "proto";

export const typeOf = <T>(c: SignalFn<T>): Type<T> | undefined => (c as any).constructor;
export const unwrap = <T>(v: Val<T>): T => typeof v === "function" ? (v as () => T)() : v;

/** Resolve a `value:` entry: extracts the field's initial value and
 *  the prototype its field-lens should inherit (so `tr.translate.x`
 *  inherits Vec.prototype methods). One walk covers both. */
function resolve(entry: any, override: any): { init: any; proto: any } {
  if (isType(entry)) return { init: override ?? entry.value, proto: entry.prototype };
  if (isFieldSpec(entry)) return { init: override ?? entry.init, proto: entry.type.prototype };
  if (isAnyCell(entry)) return { init: override ?? entry.peek(), proto: typeOf(entry)!.prototype };
  return { init: override ?? entry, proto: signalProto };
}

// ── struct() ───────────────────────────────────────────────────────

const RESERVED = new Set(["peek", "follow", "mirror", "raw", "constructor",
  "length", "name", "caller", "arguments", "prototype", "call", "apply", "toString", "bind"]);

export function struct<const Cfg extends StructDef>(cfg: Cfg): Type<ShapeOf<Cfg["value"]>, Cfg> {
  const methods = cfg.methods ?? {};
  const getters = cfg.getters ?? {};
  const fields = (cfg.value != null && typeof cfg.value === "object" && typeof cfg.value !== "function")
    ? Object.keys(cfg.value) : [];
  const all = new Set<string>();
  for (const n of [...Object.keys(methods), ...Object.keys(getters), ...fields]) {
    if (RESERVED.has(n)) throw new Error(`struct(${cfg.tag}): "${n}" is reserved`);
    if (all.has(n)) throw new Error(`struct(${cfg.tag}): "${n}" collides across method/getter/field`);
    all.add(n);
  }

  const Vec: any = function (init?: any) {
    const v = cfg.value;
    if (v != null && typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v)) out[k] = resolve(v[k], init?.[k]).init;
      return signal(out, Vec.prototype);
    }
    return signal(init !== undefined ? init : v, Vec.prototype);
  };
  Vec.tag = cfg.tag;
  Vec.value = cfg.value;
  Vec.traits = cfg.traits ?? {};
  Vec[BRAND] = "type";
  Vec.with = (init: any) => ({ [BRAND]: "field", type: Vec, init }) as FieldSpec;

  // Static methods (plain math).
  for (const [k, fn] of Object.entries(methods)) Vec[k] = fn;

  // Mutating chain ctor for `Vec.chain(v).method().method().value`.
  const Chain: any = function (this: any, v: any) { this.value = v; };
  for (const [k, fn] of Object.entries(methods)) {
    Chain.prototype[k] = function (this: any, ...a: any[]) {
      this.value = (fn as any)(this.value, ...a);
      return this;
    };
  }
  Vec.chain = (v: any) => new Chain(v);

  // Cell prototype.
  const proto: any = Object.create(signalProto);
  proto[BRAND] = "proto";
  proto.constructor = Vec;
  proto.raw = function (this: any) { return new Chain(this.peek()); };

  // Lifted reactive methods.
  for (const [k, fn] of Object.entries(methods)) {
    proto[k] = function (this: () => any, ...a: any[]) {
      const s = this;
      return computed(() => fn(s(), ...a.map(unwrap)));
    };
  }

  // Lazy getters (cache on first read).
  for (const [k, g] of Object.entries(getters)) {
    Object.defineProperty(proto, k, {
      configurable: true,
      get(this: any) { const v = g.call(this); Object.defineProperty(this, k, { value: v }); return v; },
    });
  }

  // Lazy field lenses (cache on first read).
  for (const k of fields) {
    const fieldProto = resolve((cfg.value as any)[k], undefined).proto;
    Object.defineProperty(proto, k, {
      configurable: true, enumerable: true,
      get(this: any) {
        const s = this;
        const f = lens(() => (s() as any)[k], (v: any) => { s({ ...s.peek(), [k]: v }); }, fieldProto);
        Object.defineProperty(this, k, { value: f, configurable: false, writable: false });
        return f;
      },
    });
  }

  Vec.prototype = proto;
  Vec.is = (v: unknown): boolean => isAnyCell(v) && Object.getPrototypeOf(v) === proto;
  return Vec as Type<ShapeOf<Cfg["value"]>, Cfg>;
}
