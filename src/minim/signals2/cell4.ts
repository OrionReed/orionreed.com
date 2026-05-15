// cell4.ts — fused storage, native lens, methods+traits split.
//
// Built on engine2.ts. Key differences from cell3:
//
//   • Fused storage by default. ONE alien-signal holds the whole value.
//     Field accessors are lazy LENSES (native engine2 primitive) — they
//     read via projection (with computed equality, so per-field
//     subscription works) and write via parent-update.
//
//   • Split storage opt-in via function-form value: `value: () => ({
//     x: signal(0), y: signal(0) })`. No `layout:` config slot.
//
//   • peek/follow/sync inherited from `engine2.signalProto` — no
//     duplication, no per-cell-type proto layer for them.
//
//   • Methods exist in TWO places:
//       1. cell.method(...args) — returns reactive Cell via computed
//          wrap. The ergonomic / reactive-by-default path.
//       2. Vec.method(self, ...args) — pure function. The escape hatch
//          for hot paths or "one big computation" via `computed(() =>
//          Vec.foo(Vec.bar(point(), ...), ...))`.
//
//   • Per-field subscription is provided by alien-signals' computed
//     equality propagation. Verified in _cell4.test.ts.

import {
  signal as bareSignal,
  computed,
  lens,
  effect,
  batch,
  signalProto,
  setActiveSub,
  type SignalFn,
} from "./engine2";

// ── Public types ────────────────────────────────────────────────────

export type { SignalFn };
// cell4 (legacy) bare signal includes peek/follow/sync via signalProto.
// cell5 dropped this default for perf — see cell5.ts.
export const signal = <T>(initial: T): SignalFn<T> => bareSignal(initial, signalProto);
export { computed, lens, effect, batch };

// Internal: signal-with-explicit-proto (used by struct cells which set
// their own Vec.prototype). Not exported.
const stampedSignal = bareSignal;

export type Cell<T, Cfg = unknown> = SignalFn<T> & CellBase<T> & CellSurface<T, Cfg>;

interface CellBase<T> {
  peek(): T;
  follow(other: SignalFn<T>): () => void;
  sync(other: SignalFn<T>): () => void;
}

type CellSurface<T, Cfg> = FieldsOf<Cfg> & MethodsOf<Cfg, T> & GettersOf<Cfg>;

type FieldsOf<Cfg> = Cfg extends { value: infer V }
  ? V extends Record<string, any>
    ? V extends Function ? {}
    : { readonly [K in keyof V]: Cell<FieldValueOf<V[K]>> }
  : {}
  : {};

type FieldValueOf<X> =
  X extends Type<infer U> ? U
  : X extends Cell<infer U> ? U
  : X;

type MethodsOf<Cfg, T> = Cfg extends { methods: infer M }
  ? { readonly [K in keyof M]: M[K] extends (self: T, ...args: infer A) => infer R
      ? (...args: A) => RO<R> : never }
  : {};

type GettersOf<Cfg> = Cfg extends { getters: infer G }
  ? { readonly [K in keyof G]: G[K] extends (this: any) => infer R ? R : never }
  : {};

export type RO<T> = (() => T) & { peek(): T };

export type Val<T> = T | (() => T);

/** Static methods on Type — same `(self: T, ...args) => R` functions
 *  the user declared in `methods:`, also installed as own-props on the
 *  Type so `Vec.add(a, b)` works as pure math. */
type StaticMethodsOf<Cfg> = Cfg extends { methods: infer M } ? M : {};

export type Type<T = any, Cfg = unknown> = StaticMethodsOf<Cfg> & {
  readonly tag: string;
  readonly value: any;
  readonly traits: Cfg extends { traits: infer Tr } ? Tr : {};
  readonly prototype: any;
  (init?: ValueInit<Cfg>): Cell<T, Cfg>;
  is(v: unknown): v is Cell<T, Cfg>;
  /** Produce a typed field-spec for use inside another struct's `value:`.
   *  Replaces the cell-as-default-spec pattern (`scale: Vec({x:1,y:1})`)
   *  which would otherwise share a single mutable cell across all parent
   *  instances. */
  with(init: T): FieldSpec<T>;
};

/** Tagged spec produced by `Type.with(init)`. Recognized by the field
 *  resolver as "use this type, with this initial value." */
export interface FieldSpec<T = any> {
  readonly [FIELD_SPEC]: true;
  readonly type: Type<T, any>;
  readonly init: T;
}

type ValueInit<Cfg> = Cfg extends { value: infer V }
  ? V extends Record<string, any> ? { [K in keyof V]?: FieldValueOf<V[K]> }
    : V
  : any;

type ValueOfRT<Cfg> = Cfg extends { value: infer V }
  ? V extends Record<string, any>
    ? V extends Function ? V : { [K in keyof V]: FieldValueOf<V[K]> }
    : V
  : never;

export interface StructDef<T = any> {
  tag: string;
  value: any;
  methods?: Record<string, (self: T, ...args: any[]) => any>;
  getters?: Record<string, (this: any) => any>;
  // `unknown` (not `any`) so const-inference preserves the literal shape.
  traits?: Record<string, unknown>;
}

// ── Reserved-name guard ─────────────────────────────────────────────

const RESERVED = new Set([
  "peek", "follow", "sync", "constructor",
  "length", "name", "caller", "arguments", "prototype",
  "call", "apply", "toString", "bind",
]);

function guardReserved(tag: string, kind: string, names: Iterable<string>): void {
  for (const n of names) {
    if (RESERVED.has(n)) throw new Error(`struct(${tag}): ${kind} "${n}" is reserved.`);
  }
}

// ── Brand & detection ───────────────────────────────────────────────

const BRAND = Symbol.for("minim.struct.v4");
const FIELD_SPEC = Symbol.for("minim.fieldSpec.v4");

function isType(v: unknown): boolean {
  return typeof v === "function" && (v as any)[BRAND] === "type";
}

function isAnyCell(v: unknown): boolean {
  if (typeof v !== "function") return false;
  const p = Object.getPrototypeOf(v);
  return p != null && p[BRAND] === "proto";
}

function isFieldSpec(v: unknown): v is FieldSpec {
  return typeof v === "object" && v !== null && (v as any)[FIELD_SPEC] === true;
}

export function typeOf<T>(c: SignalFn<T>): Type<T> | undefined {
  return (c as any).constructor as Type<T> | undefined;
}

export function unwrap<T>(v: Val<T>): T {
  return typeof v === "function" ? (v as () => T)() : v;
}

// ── struct() ─────────────────────────────────────────────────────────

/** Resolve a `value:` entry to (initial value, field-proto). Used in
 *  both struct() (for the lens-proto) and constructCell (for the
 *  initial whole-value). Single source of truth for entry semantics. */
function resolveEntry(entry: unknown, override: unknown): { initial: unknown; fieldProto: any } {
  if (isType(entry)) {
    return {
      initial: override !== undefined ? override : (entry as any).value,
      fieldProto: (entry as any).prototype,
    };
  }
  if (isFieldSpec(entry)) {
    return {
      initial: override !== undefined ? override : (entry as any).init,
      fieldProto: (entry as any).type.prototype,
    };
  }
  if (isAnyCell(entry)) {
    // Legacy cell-as-default-spec: still works but discouraged (shared
    // mutable cell). Prefer `Type.with(init)`.
    const t = typeOf(entry as any) as any;
    return {
      initial: override !== undefined ? override : (entry as any).peek(),
      fieldProto: t.prototype,
    };
  }
  return {
    initial: override !== undefined ? override : entry,
    fieldProto: signalProto,
  };
}

function installStaticMethods(Vec: any, methods?: Record<string, (self: any, ...args: any[]) => any>) {
  if (!methods) return;
  for (const [name, fn] of Object.entries(methods)) Vec[name] = fn;
}

function installLiftedMethods(proto: any, methods?: Record<string, (self: any, ...args: any[]) => any>) {
  if (!methods) return;
  for (const [name, fn] of Object.entries(methods)) {
    proto[name] = function (this: () => any, ...args: any[]) {
      const self = this;
      return computed(() => fn(self(), ...args.map(unwrap)));
    };
  }
}

function installGetters(proto: any, getters?: Record<string, (this: any) => any>) {
  if (!getters) return;
  for (const [name, getter] of Object.entries(getters)) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: any) {
        const v = getter.call(this);
        Object.defineProperty(this, name, { value: v });
        return v;
      },
    });
  }
}

function installFieldLenses(proto: any, value: any) {
  if (value == null || typeof value !== "object" || typeof value === "function") return;
  for (const k of Object.keys(value)) {
    const { fieldProto } = resolveEntry(value[k], undefined);
    Object.defineProperty(proto, k, {
      configurable: true,
      enumerable: true,
      get(this: any): any {
        const self = this;
        const fieldFn = lens(
          () => (self() as any)[k],
          (v: any) => {
            const cur = self.peek();
            self({ ...cur, [k]: v });
          },
          fieldProto,
        );
        Object.defineProperty(self, k, {
          value: fieldFn, configurable: false, writable: false,
        });
        return fieldFn;
      },
    });
  }
}

export function struct<const Cfg extends StructDef>(
  cfg: Cfg,
): Type<ValueOfRT<Cfg>, Cfg> {
  // Reserved + cross-bag collision guard.
  const methodNames = Object.keys(cfg.methods ?? {});
  const getterNames = Object.keys(cfg.getters ?? {});
  const fieldNames = (cfg.value != null && typeof cfg.value === "object" && typeof cfg.value !== "function")
    ? Object.keys(cfg.value) : [];
  guardReserved(cfg.tag, "method", methodNames);
  guardReserved(cfg.tag, "getter", getterNames);
  guardReserved(cfg.tag, "field", fieldNames);
  const all = new Set<string>();
  for (const n of methodNames.concat(getterNames, fieldNames)) {
    if (all.has(n)) {
      throw new Error(`struct(${cfg.tag}): name "${n}" used by more than one of method/getter/field.`);
    }
    all.add(n);
  }

  const Vec: any = function (init?: any) {
    return constructCell(Vec, init);
  };
  Vec.tag = cfg.tag;
  Vec.value = cfg.value;
  Vec.traits = cfg.traits ?? {};
  Vec[BRAND] = "type";
  installStaticMethods(Vec, cfg.methods);

  const proto: any = Object.create(signalProto);
  proto[BRAND] = "proto";
  proto.constructor = Vec;
  installLiftedMethods(proto, cfg.methods);
  installGetters(proto, cfg.getters);
  installFieldLenses(proto, cfg.value);

  Vec.prototype = proto;
  Vec.is = (v: unknown): boolean => isAnyCell(v) && Object.getPrototypeOf(v) === proto;
  Vec.with = (init: any): FieldSpec => ({ [FIELD_SPEC]: true, type: Vec, init } as FieldSpec);

  return Vec as Type<ValueOfRT<Cfg>, Cfg>;
}

// ── Cell construction ───────────────────────────────────────────────
//
// Three forms:
//
//   1. value = a function: split storage — user-built signals as fields.
//   2. value = object with primitive/typed entries: FUSED — one signal
//      holds the whole object; field accessors are lazy lenses.
//   3. value = primitive scalar (number/string/bool): single signal.

function constructCell(Vec: any, init: any): any {
  const valueSpec = Vec.value;

  // ── Form 1: function value (split storage) ───────────────
  if (typeof valueSpec === "function" && !isType(valueSpec)) {
    const built = (valueSpec as () => Record<string, SignalFn<any>>)();
    if (init && typeof init === "object") {
      for (const k of Object.keys(init)) if (k in built) built[k](init[k]);
    }
    const keys = Object.keys(built);
    const read = () => {
      const o: any = {};
      for (const k of keys) o[k] = built[k]();
      return o;
    };
    const write = (v: any) => {
      batch(() => {
        for (const k of keys) if (k in v) built[k](v[k]);
      });
    };
    const cellFn: any = function (...args: any[]) {
      if (args.length === 0) return read();
      write(args[0]);
    };
    Object.setPrototypeOf(cellFn, Vec.prototype);
    for (const k of keys) {
      Object.defineProperty(cellFn, k, {
        value: built[k], writable: false, configurable: false, enumerable: true,
      });
    }
    return cellFn;
  }

  // ── Form 2: object value (FUSED storage) ─────────────────
  // ONE alien-signal holds the whole object. Field accessors live on
  // the prototype (set up in struct()), so any cell or sub-cell with
  // `Object.getPrototypeOf(x) === Vec.prototype` gets them for free.
  if (valueSpec != null && typeof valueSpec === "object") {
    const initial: any = {};
    for (const k of Object.keys(valueSpec)) {
      const ov = init && typeof init === "object" ? init[k] : undefined;
      initial[k] = resolveEntry(valueSpec[k], ov).initial;
    }
    return stampedSignal(initial, Vec.prototype);
  }

  // ── Form 3: scalar primitive ─────────────────────────────
  return stampedSignal(init !== undefined ? init : valueSpec, Vec.prototype);
}
