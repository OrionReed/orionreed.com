// struct3.ts — struct factory on top of class-based core3.
//
// API:  cell.value         read/write
//       cell.peek()        untracked read
//       cell.x             Lens<T> for field x (lazy, cached)
//       cell.add(b)        reactive method → Computed<R>
//       cell.raw()         fluent plain-math chain
//       Vec.chain(v)       same, on Type
//       Vec.add(a, b)      static plain math
//       Vec.traits         typed trait bag
//       Vec.is(v)          type guard via instanceof
//       Vec.with(init)     FieldSpec for nested defaults

import {
  Signal,
  Computed,
  Lens,
  signal,
  computed,
  lens,
  effect,
  batch,
  follow,
  mirror,
} from "./core3";

export {
  Signal,
  Computed,
  Lens,
  signal,
  computed,
  lens,
  effect,
  batch,
  follow,
  mirror,
};

// ── Trait interfaces (open registry, declaration-merge extensible) ──

export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}
export type Lerp<T> = (a: T, b: T, t: number) => T;
export type Metric<T> = (a: T, b: T) => number;
export type Equals<T> = (a: T, b: T) => boolean;
export interface CommonTraits<T> {
  linear?: Linear<T>;
  lerp?: Lerp<T>;
  metric?: Metric<T>;
  equals?: Equals<T>;
}

// ── Type system ──────────────────────────────────────────────────

export type Val<T> = T | (() => T);
export type RO<T> = Computed<T> | Signal<T> | Lens<T>;

type Of<X> =
  X extends Type<infer U, any> ? U : X extends FieldSpec<infer U> ? U : X;
type ShapeOf<V> =
  V extends Record<string, any>
    ? V extends Function
      ? V
      : { [K in keyof V]: Of<V[K]> }
    : V;
type FieldOf<X> =
  X extends Type<infer U, infer C>
    ? Cell<U, C>
    : X extends FieldSpec<infer U>
      ? Cell<U>
      : Cell<X>;
type Fields<V> =
  V extends Record<string, any>
    ? V extends Function
      ? {}
      : { readonly [K in keyof V]: FieldOf<V[K]> }
    : {};
type Methods<M, T> = {
  readonly [K in keyof M]: M[K] extends (self: T, ...a: infer A) => infer R
    ? (...a: A) => Computed<R>
    : never;
};
type Getters<G> = {
  readonly [K in keyof G]: G[K] extends (this: any) => infer R ? R : never;
};

export type Cell<T, Cfg = unknown> = Signal<T> & {
  raw(): Chain<T, Cfg>;
} & (Cfg extends { value: infer V } ? Fields<V> : {}) &
  (Cfg extends { methods: infer M } ? Methods<M, T> : {}) &
  (Cfg extends { getters: infer G } ? Getters<G> : {});

export type Type<T = any, Cfg = unknown> = (Cfg extends { methods: infer M }
  ? M
  : {}) & {
  readonly tag: string;
  readonly value: any;
  readonly traits: Cfg extends { traits: infer Tr } ? Tr : {};
  readonly prototype: any;
  (init?: Partial<T>): Cell<T, Cfg>;
  is(v: unknown): v is Cell<T, Cfg>;
  with(init: T): FieldSpec<T>;
  chain(v: T): Chain<T, Cfg>;
};

export type Chain<T, Cfg> = { value: T } & (Cfg extends { methods: infer M }
  ? {
      [K in keyof M]: M[K] extends (self: T, ...a: infer A) => infer R
        ? R extends T
          ? (...a: A) => Chain<T, Cfg>
          : (...a: A) => R
        : never;
    }
  : {});

export interface FieldSpec<T = any> {
  readonly [BRAND]: "field";
  readonly type: Type<T, any>;
  readonly init: T;
}

export interface StructDef<T = any> {
  tag: string;
  value: any;
  methods?: Record<string, (self: T, ...args: any[]) => any>;
  getters?: Record<string, (this: any) => any>;
  traits?: CommonTraits<T> & Record<string, unknown>;
}

// ── Detection & utils ───────────────────────────────────────────

const BRAND = Symbol.for("minim.struct");
const isType = (v: any): boolean =>
  typeof v === "function" && v[BRAND] === "type";
const isFieldSpec = (v: any): v is FieldSpec =>
  v != null && typeof v === "object" && v[BRAND] === "field";

export const typeOf = <T>(c: any): Type<T> | undefined => c?.constructor;
export const unwrap = <T>(v: Val<T>): T =>
  typeof v === "function" ? (v as () => T)() : v;

/** Resolve `value:` entry → (initial value, type's prototype for sub-lens methods). */
function resolve(entry: any, override: any): { init: any; proto: any } {
  if (isType(entry))
    return { init: override ?? entry.value, proto: entry.prototype };
  if (isFieldSpec(entry))
    return { init: override ?? entry.init, proto: entry.type.prototype };
  return { init: override ?? entry, proto: null };
}

// ── struct() ────────────────────────────────────────────────────

// Names defined on cell prototypes — methods/getters/fields can't clash.
const RESERVED = new Set(["value", "peek", "constructor", "raw"]);

export function struct<const Cfg extends StructDef>(
  cfg: Cfg,
): Type<ShapeOf<Cfg["value"]>, Cfg> {
  const methods = cfg.methods ?? {};
  const getters = cfg.getters ?? {};
  const fields =
    cfg.value != null &&
    typeof cfg.value === "object" &&
    typeof cfg.value !== "function"
      ? Object.keys(cfg.value)
      : [];
  const seen = new Set<string>();
  for (const n of [
    ...Object.keys(methods),
    ...Object.keys(getters),
    ...fields,
  ]) {
    if (RESERVED.has(n))
      throw new Error(`struct(${cfg.tag}): "${n}" is reserved`);
    if (seen.has(n))
      throw new Error(
        `struct(${cfg.tag}): "${n}" collides across method/getter/field`,
      );
    seen.add(n);
  }

  // Cell class — extends Signal for reactive machinery; methods,
  // getters, and field-lenses live on its prototype.
  class CellCls extends Signal<any> {
    constructor(init: any) {
      const v = cfg.value;
      if (v != null && typeof v === "object" && typeof v !== "function") {
        const out: any = {};
        for (const k of Object.keys(v)) out[k] = resolve(v[k], init?.[k]).init;
        super(out);
      } else {
        super(init !== undefined ? init : v);
      }
    }
  }
  Object.defineProperty(CellCls, "name", { value: cfg.tag });
  const proto = CellCls.prototype as any;

  // Reactive methods: lifted to `cell.method(...args) → Computed<R>`.
  for (const [k, fn] of Object.entries(methods)) {
    proto[k] = function (this: CellCls, ...args: any[]) {
      const self = this;
      return computed(() => fn(self.value, ...args.map(unwrap)));
    };
  }

  // Lazy getters — first access caches as own-prop.
  for (const [k, g] of Object.entries(getters)) {
    Object.defineProperty(proto, k, {
      configurable: true,
      get(this: any) {
        const v = g.call(this);
        Object.defineProperty(this, k, { value: v });
        return v;
      },
    });
  }

  // Lazy field lenses. For typed-entry fields, we need both Lens's
  // value get/set (delegating to parent) AND the typed methods/sub-
  // fields. Build a per-Type Lens subclass ONCE at struct() time
  // ("ViewLens") that extends Lens and carries the typed methods.
  // Each field-access just `new TypedLens(getter, setter)` — fast.
  //
  // (Originally I copied descriptors on each access: ~1400ns. Then
  // tried setPrototypeOf to typed proto: ~7ns but broke `instanceof
  // Lens` in engine dispatch. View-class approach: cheap construct,
  // correct instanceof.)
  const viewCache = new Map<object, any>();
  function makeViewClass(typedProto: any): any {
    let cached = viewCache.get(typedProto);
    if (cached) return cached;
    class ViewLens extends Lens {}
    for (const pk of Object.getOwnPropertyNames(typedProto)) {
      if (pk === "constructor" || pk === "value") continue;
      const desc = Object.getOwnPropertyDescriptor(typedProto, pk);
      if (desc) Object.defineProperty(ViewLens.prototype, pk, desc);
    }
    viewCache.set(typedProto, ViewLens);
    return ViewLens;
  }
  for (const k of fields) {
    const subProto = resolve((cfg.value as any)[k], undefined).proto;
    const LensCls = subProto ? makeViewClass(subProto) : Lens;
    Object.defineProperty(proto, k, {
      configurable: true,
      enumerable: true,
      get(this: CellCls) {
        const self = this;
        const fl: any = new LensCls(
          () => (self.value as any)[k],
          (v: any) => { self.value = { ...(self.value as any), [k]: v }; },
        );
        Object.defineProperty(this, k, { value: fl, configurable: false, writable: false });
        return fl;
      },
    });
  }

  // Chain ctor — mutating, for fluent plain math.
  const Chain: any = function (this: any, v: any) {
    this.value = v;
  };
  for (const [k, fn] of Object.entries(methods)) {
    Chain.prototype[k] = function (this: any, ...a: any[]) {
      this.value = (fn as any)(this.value, ...a);
      return this;
    };
  }
  proto.raw = function (this: CellCls) {
    return new Chain(this.peek());
  };

  // Type function — `Vec({x,y})` constructs a CellCls; also carries
  // static methods, traits, helpers.
  const Vec: any = function (init?: any) {
    return new CellCls(init);
  };
  Vec.tag = cfg.tag;
  Vec.value = cfg.value;
  Vec.traits = cfg.traits ?? {};
  Vec[BRAND] = "type";
  Vec.prototype = proto;
  Vec.is = (v: any): boolean => v instanceof CellCls;
  Vec.with = (init: any): FieldSpec =>
    ({ [BRAND]: "field", type: Vec, init }) as FieldSpec;
  Vec.chain = (v: any) => new Chain(v);
  for (const [k, fn] of Object.entries(methods)) Vec[k] = fn;

  // Make `instance.constructor === Vec` (the Type) so `typeOf(cell)`
  // returns the type with `.traits`/`.tag`/`.is`/`.with`/`.chain`.
  Object.defineProperty(proto, "constructor", { value: Vec, configurable: true, writable: true });

  return Vec as Type<ShapeOf<Cfg["value"]>, Cfg>;
}
