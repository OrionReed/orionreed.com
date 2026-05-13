// minim's reactive value-type framework. Build a `Reactive<T>` for
// any T via the fluent `struct()` Builder, or drop to `defineCell`
// when you need a custom shape (arrays, variants, strings…).
//
// Three layers, each independently usable:
//
//   1. `defineCell(name, methods, descriptors, opts)` — primitive.
//      Builds a Signal-subtype with a custom prototype, V8-friendly
//      (Object.create + ctor.call against per-type protos). The
//      escape hatch for non-record value types.
//
//   2. Helpers (`lift`, `liftScalar`, `axes`, `lazies`, `withAlgebra`,
//      `construct`) — compose into the methods/descriptors bags
//      `defineCell` consumes. Per-arity unrolling lives in `lift` /
//      `liftScalar` / `construct`.
//
//   3. `struct(name, defaults)` — fluent Builder that collects ops/
//      scalars/getters/methods, then calls `defineCell` once on
//      `.build()`. The common case for record-shaped value types.
//
// Why this shape: the cell primitive is small (~50 LOC) and fully
// general (T = any type). The helpers each do one well-named thing.
// The Builder is a thin facade — no `Schema = Record<string, number
// | StructType>` constraint, just `T`. The benches show this design
// at parity-or-faster than the old monolithic finalize across the
// whole Vec/Box surface, while the framework itself shrinks ~35%.

import {
  Signal,
  Computed,
  computed,
  lens,
  signal,
  batch,
  type ReadonlySignal,
} from "../core/signal";
import { LERP, type Easing, type Duration, type Tween } from "../core/tween";

// ── Type surface ───────────────────────────────────────────────────

export type RW = "rw" | "ro";

type ReactiveArgs<A extends readonly unknown[]> = {
  [K in keyof A]: A[K] | Signal<A[K]> | ReadonlySignal<A[K]> | (() => A[K]);
};

/** Lift a struct-returning op `(self, ...args) => T` into its method
 *  form `(...args) => Reactive<T, ...>`. Threads `G` (lazy getters)
 *  through to the result so cardinals/lazy projections survive lifted
 *  derivations (e.g. `vec.add(b).length` works because the derived
 *  also has `.length`). `M` is dropped — free-form methods are
 *  writable-only by design and lifted ops always return read-only. */
type LiftedStruct<F, T, O, X, G> = F extends (
  self: any,
  ...args: infer A
) => any
  ? (...args: ReactiveArgs<A>) => Reactive<T, O, X, G, {}, "ro">
  : never;

/** Lift a scalar-returning op `(self, ...args) => R` into a method
 *  `(...args) => ReadonlySignal<R>`. */
type LiftedScalar<F> = F extends (self: any, ...args: infer A) => infer R
  ? (...args: ReactiveArgs<A>) => ReadonlySignal<R>
  : never;

/** Methods bag — lifted ops + lifted scalars. Verbatim free-form
 *  methods (`M`) are NOT included here; they're added separately by
 *  Reactive only on writable flavors. */
type Methods<T, O, X, G> =
  & { [K in keyof O]: LiftedStruct<O[K], T, O, X, G> }
  & { [K in keyof X]: LiftedScalar<X[K]> };

/** Lazy getter return types projected as readonly properties.
 *  `{ center: (this) => Reactive<V> }` becomes `{ readonly center:
 *  Reactive<V> }`. */
type GetterProps<G> = {
  readonly [K in keyof G]: G[K] extends (this: any) => infer R ? R : never;
};

/** Per-axis projections of a record-shaped T. Writable when parent
 *  is writable. T that isn't a record yields no axes (e.g. T=string
 *  has no `string.x` axis).
 *
 *  When `N` declares nested struct types for some keys, those axes
 *  expose the nested struct's full surface (`.translate.x`, `.translate.length`,
 *  …) instead of a plain Signal. */
type Axes<T, W extends RW, N> = T extends Record<string, any>
  ? {
      readonly [K in keyof T]: K extends keyof N
        ? N[K] extends StructType<
            infer NT,
            infer NO,
            infer NX,
            infer NG,
            infer NM,
            infer NN
          >
          ? Reactive<NT, NO, NX, NG, NM, W, NN>
          : never
        : W extends "rw"
          ? Signal<T[K]>
          : ReadonlySignal<T[K]>;
    }
  : {};

/** When the struct's ops bag includes `lerp`, `.to(target, dur, ease?)`
 *  is installed on writable Reactives via the prototype `[LERP]` slot.
 *  One method auto-derived from one canonical op (lerp → tween-toward).
 *  Other animation strategies (spring, oscillate, …) are free
 *  functions in `signals/integrators.ts` that read `[ALGEBRA]` from
 *  the prototype slot. */
type Tweenable<T, O, W extends RW> = W extends "rw"
  ? O extends { lerp: (a: any, b: any, t: number) => T }
    ? { to(target: T, dur: Duration, ease?: Easing): Tween<T> }
    : {}
  : {};

/** A reactive cell carrying a value of type T.
 *
 *  Generics:
 *    T  — value type (any type, not just records)
 *    O  — struct-returning ops bag
 *    X  — scalar-returning ops bag
 *    G  — lazy-getters bag
 *    M  — free-form methods bag (verbatim, writable-only)
 *    W  — "rw" or "ro"
 *    N  — nested-struct map (for fields whose values are themselves
 *         registered struct types — e.g. `Transform.translate: Vec`)
 *
 *  Only `T` appears in user-facing positions; the rest default and
 *  are filled in by the Builder via inference. */
export type Reactive<
  T,
  O = {},
  X = {},
  G = {},
  M = {},
  W extends RW = "rw",
  N = {},
> =
  & (W extends "rw" ? Signal<T> : ReadonlySignal<T>)
  & Axes<T, W, N>
  & Methods<T, O, X, G>
  & GetterProps<G>
  & Tweenable<T, O, W>
  & (W extends "rw" ? M : {});

/** Nested-struct field map. Keys are fields of T whose values should
 *  be exposed as `Reactive<TheirNestedStruct>` rather than plain
 *  signals — and (for `.signal()` flavor) stored SoA-style as
 *  per-field signals so per-axis writes bypass the parent. */
export type NestedMap<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof T]?: StructType<T[K], any, any, any, any, any>;
};

/** A registered struct: factory namespace + identity-as-instanceof.
 *  `v instanceof MyStruct` is O(1) via the [STRUCT] prototype slot. */
export interface StructType<T, O = {}, X = {}, G = {}, M = {}, N = {}> {
  readonly name: string;
  readonly defaults: T;
  signal(v: T): Reactive<T, O, X, G, M, "rw", N>;
  derived(fn: () => T): Reactive<T, O, X, G, M, "ro", N>;
  lens(read: () => T, write: (v: T) => void): Reactive<T, O, X, G, M, "rw", N>;
  is(v: unknown): v is Reactive<T, O, X, G, M, RW, N>;
  isWritable(v: unknown): v is Reactive<T, O, X, G, M, "rw", N>;
  [Symbol.hasInstance](v: unknown): boolean;
}

// ── Marker symbols ─────────────────────────────────────────────────
//
// Internal but exported so other framework files can read them.
// Stamped by `defineCell` on every per-type prototype.

/** @internal Marks a per-type prototype with the `StructType` that
 *  owns it. `v[STRUCT] === MyStruct` powers fast `instanceof` checks. */
export const STRUCT = Symbol("minim.struct");

/** @internal Carries the value type's vector-space algebra (add, sub,
 *  scale). Integrators (`spring`, `oscillate`, …) read this from the
 *  prototype to find ops for the value type without the user passing
 *  them explicitly. */
export const ALGEBRA = Symbol("minim.algebra");

/** @internal Marks a writable per-type prototype (vs read-only).
 *  Used by `StructType.isWritable`. */
export const WRITABLE = Symbol("minim.writable");

// ── Helpers (each does one thing, all composable) ──────────────────

/** Per-call reader for a lifted-op arg: signals → `.value`, functions
 *  → call, literals → return as-is. Branched once at construction so
 *  the resulting closure is monomorphic. */
function readerFor(a: unknown): () => unknown {
  if (a instanceof Signal) {
    const s = a as Signal<unknown>;
    return () => s.value;
  }
  if (typeof a === "function") {
    const f = a as () => unknown;
    return () => f();
  }
  return () => a;
}

/** Lift a pure struct-op into a method that returns a derived cell.
 *  Per-arity unrolled (0/1/2; 3+ generic). Arity-1 further specializes
 *  by arg shape so the per-call closure is monomorphic. */
export function lift<T>(
  fn: (self: T, ...args: any[]) => T,
  derived: (fn: () => T) => unknown,
) {
  const arity = Math.max(0, fn.length - 1);
  if (arity === 0) {
    return function (this: ReadonlySignal<T>) {
      const self = this;
      return derived(() => fn(self.value));
    };
  }
  if (arity === 1) {
    return function (this: ReadonlySignal<T>, a: unknown) {
      const self = this;
      if (a instanceof Signal) {
        const sa = a as Signal<unknown>;
        return derived(() => fn(self.value, sa.value));
      }
      if (typeof a === "function") {
        const fa = a as () => unknown;
        return derived(() => fn(self.value, fa()));
      }
      return derived(() => fn(self.value, a));
    };
  }
  if (arity === 2) {
    return function (this: ReadonlySignal<T>, a: unknown, b: unknown) {
      const self = this;
      const ar = readerFor(a);
      const br = readerFor(b);
      return derived(() => fn(self.value, ar(), br()));
    };
  }
  return function (this: ReadonlySignal<T>, ...args: unknown[]) {
    const self = this;
    const readers = args.map(readerFor);
    return derived(() => fn(self.value, ...readers.map((r) => r())));
  };
}

/** Lift a scalar-returning op into a method that returns a
 *  `ReadonlySignal<R>` (via `computed`). Same per-arity dispatch
 *  as `lift`. */
export function liftScalar<T>(fn: (self: T, ...args: any[]) => unknown) {
  const arity = Math.max(0, fn.length - 1);
  if (arity === 0) {
    return function (this: ReadonlySignal<T>) {
      const self = this;
      return computed(() => fn(self.value));
    };
  }
  if (arity === 1) {
    return function (this: ReadonlySignal<T>, a: unknown) {
      const self = this;
      if (a instanceof Signal) {
        const sa = a as Signal<unknown>;
        return computed(() => fn(self.value, sa.value));
      }
      if (typeof a === "function") {
        const fa = a as () => unknown;
        return computed(() => fn(self.value, fa()));
      }
      return computed(() => fn(self.value, a));
    };
  }
  if (arity === 2) {
    return function (this: ReadonlySignal<T>, a: unknown, b: unknown) {
      const self = this;
      const ar = readerFor(a);
      const br = readerFor(b);
      return computed(() => fn(self.value, ar(), br()));
    };
  }
  return function (this: ReadonlySignal<T>, ...args: unknown[]) {
    const self = this;
    const readers = args.map(readerFor);
    return computed(() => fn(self.value, ...readers.map((r) => r())));
  };
}

/** Per-arity-unrolled axis writer factory. Bench winner: 1.6-2.2× over
 *  the generic args-array fallback. arity 1/2/4/6 unrolled (the cases
 *  Vec / Box / Matrix2D need); 3/5/7+ use the generic loop. */
export function construct<T>(
  fn: (...args: any[]) => T,
): (v: T, k: keyof T, n: T[keyof T]) => T {
  // Lazy: discover field order from the first call's `v`. Then build
  // the per-arity-specialized writer once and cache.
  let writer: (v: T, k: keyof T, n: T[keyof T]) => T;
  return (v, k, n) => {
    if (writer) return writer(v, k, n);
    writer = makeWriter<T>(Object.keys(v as any) as (keyof T)[], fn);
    return writer(v, k, n);
  };
}

function makeWriter<T>(
  fields: readonly (keyof T)[],
  construct: (...args: any[]) => T,
): (v: T, k: keyof T, n: T[keyof T]) => T {
  const arity = fields.length;
  if (arity === 1) return (_v, _k, n) => construct(n);
  if (arity === 2) {
    const [f0, f1] = fields;
    return (v, k, n) =>
      k === f0 ? construct(n, v[f1]) : construct(v[f0], n);
  }
  if (arity === 4) {
    const [f0, f1, f2, f3] = fields;
    return (v, k, n) => {
      if (k === f0) return construct(n, v[f1], v[f2], v[f3]);
      if (k === f1) return construct(v[f0], n, v[f2], v[f3]);
      if (k === f2) return construct(v[f0], v[f1], n, v[f3]);
      return construct(v[f0], v[f1], v[f2], n);
    };
  }
  if (arity === 6) {
    const [f0, f1, f2, f3, f4, f5] = fields;
    return (v, k, n) => {
      if (k === f0) return construct(n, v[f1], v[f2], v[f3], v[f4], v[f5]);
      if (k === f1) return construct(v[f0], n, v[f2], v[f3], v[f4], v[f5]);
      if (k === f2) return construct(v[f0], v[f1], n, v[f3], v[f4], v[f5]);
      if (k === f3) return construct(v[f0], v[f1], v[f2], n, v[f4], v[f5]);
      if (k === f4) return construct(v[f0], v[f1], v[f2], v[f3], n, v[f5]);
      return construct(v[f0], v[f1], v[f2], v[f3], v[f4], n);
    };
  }
  // Generic per-arity loop for 3, 5, 7+. Allocates a small args array.
  const idx = new Map<keyof T, number>();
  for (let i = 0; i < arity; i++) idx.set(fields[i], i);
  return (v, k, n) => {
    const i0 = idx.get(k)!;
    const args = new Array(arity);
    for (let i = 0; i < arity; i++) args[i] = i === i0 ? n : v[fields[i]];
    return construct(...args);
  };
}

function spreadWriter<T>(): (v: T, k: keyof T, n: T[keyof T]) => T {
  return (v, k, n) => ({ ...v, [k]: n }) as T;
}

/** Build per-axis lazy property descriptors. Each first-read installs
 *  a `lens` as own-property on the instance; subsequent reads bypass
 *  the proto getter entirely (own-property fast path). */
export function axes<T>(
  fields: readonly (keyof T)[],
  write: (v: T, k: keyof T, n: T[keyof T]) => T,
): PropertyDescriptorMap {
  const out: PropertyDescriptorMap = {};
  for (const f of fields) {
    out[f as PropertyKey] = {
      configurable: true,
      get(this: Signal<T>) {
        const self = this;
        const l = lens(
          () => self.value[f],
          (n) => {
            self.value = write(self.peek(), f, n as T[keyof T]);
          },
        );
        Object.defineProperty(self, f as PropertyKey, {
          value: l,
          enumerable: false,
          configurable: false,
          writable: false,
        });
        return l;
      },
    };
  }
  return out;
}

/** Build lazy-getter descriptors. First read calls `fn`, caches the
 *  result as own-property; subsequent reads are at memory speed. */
export function lazies(
  defs: Record<string, (this: any) => unknown>,
): PropertyDescriptorMap {
  const out: PropertyDescriptorMap = {};
  for (const name of Object.keys(defs)) {
    const fn = defs[name];
    out[name] = {
      configurable: true,
      get(this: any) {
        const val = fn.call(this);
        Object.defineProperty(this, name, {
          value: val,
          enumerable: false,
          configurable: false,
          writable: false,
        });
        return val;
      },
    };
  }
  return out;
}

/** Stamp `[LERP]` and `[ALGEBRA]` symbols on the methods bag. The
 *  tween engine reads `[LERP]` to dispatch `.to(target, dur)`;
 *  integrators read `[ALGEBRA]` to find add/sub/scale for the value
 *  type. The Builder calls this automatically when ops include
 *  `lerp` (for `[LERP]`) or `add`+`sub`+`scale` (for `[ALGEBRA]`). */
export function withAlgebra<T>(alg: {
  add: (a: T, b: T) => T;
  sub: (a: T, b: T) => T;
  scale: (a: T, k: number) => T;
  lerp?: (a: T, b: T, t: number) => T;
}): Record<PropertyKey, unknown> {
  const out: Record<PropertyKey, unknown> = {
    [ALGEBRA]: { add: alg.add, sub: alg.sub, scale: alg.scale },
  };
  if (alg.lerp) out[LERP] = alg.lerp;
  return out;
}

// ── The cell primitive ────────────────────────────────────────────

interface CellOpts<T> {
  /** Suppress no-op writes when equal. */
  equals?: (a: T, b: T) => boolean;
}

/** Build a Signal-subtype family with custom prototype contents.
 *  Used internally by the Builder; exposed publicly as the escape
 *  hatch for non-record value types (strings, arrays, variants).
 *
 *  Two arg slots intentional:
 *
 *    - `methods`: regular object whose values are assigned to the
 *      proto. Best for functions, symbol slots ([LERP], [ALGEBRA]),
 *      simple values.
 *
 *    - `descriptors`: PropertyDescriptorMap installed via
 *      `Object.defineProperties`. The axes/lazies helpers return
 *      these.
 *
 *  Why split: spreading a PropertyDescriptorMap into a plain object
 *  copies the descriptor *as a value* (not as a real getter/setter)
 *  — silent no-op footgun. Two slots makes that impossible. */
export function defineCell<T, M extends object>(
  name: string,
  methods: M,
  descriptors: PropertyDescriptorMap = {},
  opts: CellOpts<T> = {},
): {
  signal(v: T): Signal<T> & M;
  derived(fn: () => T): ReadonlySignal<T> & M;
  lens(read: () => T, write: (v: T) => void): Signal<T> & M;
  is(v: unknown): v is Signal<T> & M;
  isWritable(v: unknown): v is Signal<T> & M;
  [Symbol.hasInstance](v: unknown): boolean;
} {
  const equalsFn = opts.equals;
  const sigOpts = equalsFn ? { name, equals: equalsFn } : { name };
  let self!: ReturnType<typeof defineCell<T, M>>;

  const setupProto = (proto: object) => {
    for (const key of Reflect.ownKeys(methods)) {
      const desc = Object.getOwnPropertyDescriptor(methods, key)!;
      Object.defineProperty(proto, key, desc);
    }
    Object.defineProperties(proto, descriptors);
  };

  // ── rw proto: chained off Signal.prototype.
  const rwProto = Object.create(Signal.prototype);
  setupProto(rwProto);
  Object.defineProperty(rwProto, STRUCT, { value: undefined, writable: true });
  Object.defineProperty(rwProto, WRITABLE, { value: true });

  // ── ro proto: chained off Computed.prototype.
  const roProto = Object.create(Computed.prototype);
  setupProto(roProto);
  Object.defineProperty(roProto, STRUCT, { value: undefined, writable: true });

  // ── lens proto: probe preact's Lens prototype, chain off it.
  const probe = lens<T>(() => undefined as any, () => {});
  const lensInstanceProto = Object.getPrototypeOf(probe);
  const lensProto = Object.create(lensInstanceProto);
  setupProto(lensProto);
  Object.defineProperty(lensProto, STRUCT, { value: undefined, writable: true });
  Object.defineProperty(lensProto, WRITABLE, { value: true });

  const isFn = (v: unknown): v is Signal<T> & M =>
    v != null && typeof v === "object" && (v as any)[STRUCT] === self;
  const isWritableFn = (v: unknown): v is Signal<T> & M =>
    isFn(v) && (v as any)[WRITABLE] === true;

  self = {
    signal(v: T): Signal<T> & M {
      const inst = Object.create(rwProto);
      Signal.call(inst, v, sigOpts as any);
      return inst as Signal<T> & M;
    },
    derived(fn: () => T): ReadonlySignal<T> & M {
      const inst = Object.create(roProto);
      Computed.call(inst, fn as () => unknown, sigOpts as any);
      return inst as ReadonlySignal<T> & M;
    },
    lens(read: () => T, write: (v: T) => void): Signal<T> & M {
      const l = lens(read, write) as any;
      Object.setPrototypeOf(l, lensProto);
      if (equalsFn) l._equals = equalsFn;
      return l as Signal<T> & M;
    },
    is: isFn,
    isWritable: isWritableFn,
    [Symbol.hasInstance]: isFn,
  };

  rwProto[STRUCT] = self;
  roProto[STRUCT] = self;
  lensProto[STRUCT] = self;

  return self;
}

// ── The Builder facade ────────────────────────────────────────────

interface BuilderState<T> {
  name: string;
  defaults: T;
  equals?: (a: T, b: T) => boolean;
  construct?: (...args: any[]) => T;
  nested?: NestedMap<T>;
}

type OpsBag<T> = Record<string, (self: T, ...args: any[]) => T>;
type ScalarsBag<T> = Record<string, (self: T, ...args: any[]) => unknown>;
type MethodsBag<T, O, X, M, G, N> = Record<
  string,
  (this: Reactive<T, O, X, G, M, "rw", N>, ...args: any[]) => any
>;
type GettersBag<T, O, X, M, G, N> = Record<
  string,
  (this: Reactive<T, O, X, G, M, RW, N>) => any
>;

class Builder<T, O = {}, X = {}, G = {}, M = {}, N = {}> {
  constructor(
    private state: BuilderState<T>,
    private ops_: O,
    private scalars_: X,
    private getters_: G,
    private methods_: M,
  ) {}

  /** Suppress no-op writes when `eq(a, b)`. */
  equals(fn: (a: T, b: T) => boolean): Builder<T, O, X, G, M, N> {
    return new Builder(
      { ...this.state, equals: fn },
      this.ops_,
      this.scalars_,
      this.getters_,
      this.methods_,
    );
  }

  /** Positional constructor; powers fast (per-arity-unrolled) axis
   *  writers. Without this, axes use a slower spread fallback. */
  construct(fn: (...args: any[]) => T): Builder<T, O, X, G, M, N> {
    return new Builder(
      { ...this.state, construct: fn },
      this.ops_,
      this.scalars_,
      this.getters_,
      this.methods_,
    );
  }

  /** Declare which fields hold values of *other* registered struct
   *  types. The framework then:
   *
   *    - Exposes those fields with the nested struct's full surface
   *      (`tr.translate.x`, `tr.translate.length`, …).
   *    - For `.signal()` flavor, switches storage to SoA: each nested
   *      field is its own per-field signal (an own-property on the
   *      cell instance), so per-axis writes (`tr.translate.x.value =
   *      5`) only re-run subscribers of `translate`'s x lens — not
   *      everything reading the whole `tr`. The remaining non-nested
   *      fields share a single AoS Signal underneath.
   *    - For `.derived()` and `.lens()` flavors, uses AoS storage
   *      with nested-struct-typed projections (so the surface is the
   *      same; only the per-axis write story differs).
   *
   *  Trade-offs: SoA pays for construction (one Signal per nested
   *  field instead of one for the whole struct) and for whole-value
   *  reads (must compose). Wins on per-axis writes (the hot path for
   *  Shape's transform). Use only for value types whose nested fields
   *  see lots of independent axis writes. */
  nested<N2 extends NestedMap<T>>(map: N2): Builder<T, O, X, G, M, N2> {
    return new Builder<T, O, X, G, M, N2>(
      { ...this.state, nested: map as NestedMap<T> },
      this.ops_,
      this.scalars_,
      this.getters_,
      this.methods_,
    );
  }

  /** Struct-returning ops `(self, ...args) => T`. Each becomes a
   *  reactive method. If you provide `add` / `sub` / `scale`, the
   *  framework auto-stamps `[ALGEBRA]` so integrators (spring etc.)
   *  work on this type. If you provide `lerp`, the framework auto-
   *  stamps `[LERP]` so `.to(target, dur)` is installed. */
  ops<O2 extends OpsBag<T>>(bag: O2): Builder<T, O & O2, X, G, M, N> {
    return new Builder<T, O & O2, X, G, M, N>(
      this.state,
      { ...this.ops_, ...bag } as O & O2,
      this.scalars_,
      this.getters_,
      this.methods_,
    );
  }

  /** Scalar-returning ops `(self, ...args) => R`. Each becomes a
   *  reactive method returning `ReadonlySignal<R>`. */
  scalars<X2 extends ScalarsBag<T>>(bag: X2): Builder<T, O, X & X2, G, M, N> {
    return new Builder<T, O, X & X2, G, M, N>(
      this.state,
      this.ops_,
      { ...this.scalars_, ...bag } as X & X2,
      this.getters_,
      this.methods_,
    );
  }

  /** Lazy property getters. First read calls the function and
   *  caches the result as own-property — subsequent reads are at
   *  memory speed. Use for "anchors" / projections that should look
   *  like properties rather than method calls. */
  getters<G2 extends GettersBag<T, O, X, M, G, N>>(
    bag: G2,
  ): Builder<T, O, X, G & G2, M, N> {
    return new Builder<T, O, X, G & G2, M, N>(
      this.state,
      this.ops_,
      this.scalars_,
      { ...this.getters_, ...bag } as G & G2,
      this.methods_,
    );
  }

  /** Free-form methods (`this`-typed). Installed verbatim, not
   *  lifted. Use for things like `.set(target)` (returns this) and
   *  `.bind(target)` (returns a disposer) that don't fit the ops
   *  contract. Only on writable Reactives. */
  methods<M2 extends MethodsBag<T, O, X, M, G, N>>(
    bag: M2,
  ): Builder<T, O, X, G, M & M2, N> {
    return new Builder<T, O, X, G, M & M2, N>(
      this.state,
      this.ops_,
      this.scalars_,
      this.getters_,
      { ...this.methods_, ...bag } as M & M2,
    );
  }

  build(): StructType<T, O, X, G, M, N> {
    return finalize(
      this.state,
      this.ops_ as Record<string, any>,
      this.scalars_ as Record<string, any>,
      this.getters_ as Record<string, any>,
      this.methods_ as Record<string, any>,
    ) as unknown as StructType<T, O, X, G, M, N>;
  }
}

/** Build a `Reactive<T>` factory. Fluent: chain `.construct()`,
 *  `.equals()`, `.nested()`, `.ops()`, `.scalars()`, `.getters()`,
 *  `.methods()`, then `.build()`. */
export function struct<T>(name: string, defaults: T): Builder<T> {
  return new Builder({ name, defaults }, {}, {}, {}, {});
}

// ── finalize: bridge from Builder state to defineCell ─────────────

function finalize<T>(
  state: BuilderState<T>,
  ops: Record<string, (self: T, ...args: any[]) => T>,
  scalars: Record<string, (self: T, ...args: any[]) => unknown>,
  getters: Record<string, (this: any) => unknown>,
  rawMethods: Record<string, (this: any, ...args: any[]) => any>,
): StructType<T> {
  // Methods bag: lift ops + scalars, install raw methods verbatim.
  // Forward ref so lifted ops can build derived-flavored Reactives
  // of THIS struct (chaining: `vec.add(b).scale(2)`).
  let derivedRef!: (fn: () => T) => unknown;
  const mkDerived = (fn: () => T) => derivedRef(fn);

  const methods: Record<PropertyKey, unknown> = {};
  for (const name of Object.keys(ops)) {
    methods[name] = lift(ops[name], mkDerived);
  }
  for (const name of Object.keys(scalars)) {
    methods[name] = liftScalar(scalars[name]);
  }
  for (const name of Object.keys(rawMethods)) {
    methods[name] = rawMethods[name];
  }

  // Auto-stamp algebra slots if user provided the canonical ops.
  if (ops.lerp) methods[LERP] = ops.lerp;
  if (ops.add && ops.sub && ops.scale) {
    methods[ALGEBRA] = { add: ops.add, sub: ops.sub, scale: ops.scale };
  }

  const fieldKeys =
    state.defaults != null && typeof state.defaults === "object"
      ? (Object.keys(state.defaults as object) as (keyof T)[])
      : [];

  const nestedMap = state.nested ?? ({} as NestedMap<T>);
  const hasNested = Object.keys(nestedMap).length > 0;

  if (!hasNested) {
    // ── Plain AoS path: a single Signal/Computed/Lens stores the whole T,
    //    axes lens over it. The default and the fast common case.
    const writer = state.construct
      ? construct(state.construct)
      : spreadWriter<T>();
    const descriptors: PropertyDescriptorMap = {
      ...axes<T>(fieldKeys, writer),
      ...lazies(getters),
    };
    const cellRef = defineCell<T, any>(state.name, methods, descriptors, {
      equals: state.equals,
    });
    derivedRef = cellRef.derived;
    return {
      name: state.name,
      defaults: state.defaults,
      signal: cellRef.signal,
      derived: cellRef.derived,
      lens: cellRef.lens,
      is: cellRef.is,
      isWritable: cellRef.isWritable,
      [Symbol.hasInstance]: cellRef.is,
    } as StructType<T>;
  }

  // ── Nested path: SoA storage for `.signal()`, AoS-with-nested-typed-
  //    projections for `.derived()` / `.lens()`. See `defineNestedCell`
  //    for the runtime design notes.
  const cellRef = defineNestedCell<T, any>(
    state.name,
    methods,
    getters,
    fieldKeys,
    nestedMap,
    { equals: state.equals },
  );
  derivedRef = cellRef.derived;
  return {
    name: state.name,
    defaults: state.defaults,
    signal: cellRef.signal,
    derived: cellRef.derived,
    lens: cellRef.lens,
    is: cellRef.is,
    isWritable: cellRef.isWritable,
    [Symbol.hasInstance]: cellRef.is,
  } as StructType<T>;
}

// ── The nested-aware cell factory ────────────────────────────────
//
// Storage layout for `.signal()` flavor: full SoA. Every field —
// nested-struct *and* scalar — is its own per-field signal, installed
// as an own-property on the cell instance at construction. Nested
// fields use the nested struct's `.signal()` (so `tr.translate` IS a
// `Vec.signal`); other fields use a plain `signal()`.
//
// The cell instance has no underlying value of its own; its `.value`
// getter composes `{ k: this[k].value, ... }` (tracking each part);
// its setter `batch`-decomposes a whole-T write back into per-part
// writes. Subscribers of `cell.value` actually subscribe to each
// per-field signal — writes to one field only re-fire readers of THAT
// field, which is the whole point.
//
// Trade-offs vs AoS:
//   + Per-axis access at parity with five separate signals (a single
//     property read; the per-field signal IS the field).
//   + Per-axis writes only touch their own signal — no cross-field
//     re-fires on shared subscribers.
//   - Construction allocates one Signal per field instead of one for
//     the whole struct (~4-6× more work, ~4× more memory).
//   - Whole-value reads/writes pay composition cost (still <300ns).
//
// `.derived()` and `.lens()` flavors keep AoS storage (the user's
// closure produces/consumes whole-T values) but install nested-struct-
// typed projections for the nested keys, so the *surface* matches.

function defineNestedCell<T, M extends object>(
  name: string,
  methods: M,
  getters: Record<string, (this: any) => unknown>,
  fieldKeys: readonly (keyof T)[],
  nestedMap: NestedMap<T>,
  opts: CellOpts<T> = {},
): {
  signal(v: T): Signal<T> & M;
  derived(fn: () => T): ReadonlySignal<T> & M;
  lens(read: () => T, write: (v: T) => void): Signal<T> & M;
  is(v: unknown): v is Signal<T> & M;
  isWritable(v: unknown): v is Signal<T> & M;
  [Symbol.hasInstance](v: unknown): boolean;
} {
  const equalsFn = opts.equals;
  const sigOpts = equalsFn ? { name, equals: equalsFn } : { name };

  const setupProto = (proto: object) => {
    for (const key of Reflect.ownKeys(methods)) {
      const desc = Object.getOwnPropertyDescriptor(methods, key)!;
      Object.defineProperty(proto, key, desc);
    }
    Object.defineProperties(proto, lazies(getters));
  };

  // ── RW proto: full SoA. Chained off Signal.prototype so existing
  //    `instanceof Signal` checks pass and subscribe/derive/etc work.
  //    The instance has no underlying value — `.value` get/set
  //    composes/decomposes per-field signals.
  const rwProto = Object.create(Signal.prototype);
  setupProto(rwProto);

  Object.defineProperty(rwProto, "value", {
    configurable: true,
    get(this: any): T {
      const out: Record<string, unknown> = {};
      for (const k of fieldKeys) out[k as string] = this[k].value;
      return out as T;
    },
    set(this: any, v: T) {
      const obj = v as Record<string, unknown>;
      batch(() => {
        for (const k of fieldKeys) this[k].value = obj[k as string];
      });
    },
  });

  Object.defineProperty(rwProto, "peek", {
    configurable: true,
    writable: true,
    value(this: any): T {
      const out: Record<string, unknown> = {};
      for (const k of fieldKeys) out[k as string] = this[k].peek();
      return out as T;
    },
  });

  Object.defineProperty(rwProto, STRUCT, { value: undefined, writable: true });
  Object.defineProperty(rwProto, WRITABLE, { value: true });

  // ── RO proto: AoS storage (user's closure produces whole-T) with
  //    nested-typed per-field projections.
  const roProto = Object.create(Computed.prototype);
  setupProto(roProto);
  installProjectionAxes(roProto, fieldKeys, nestedMap, "ro");
  Object.defineProperty(roProto, STRUCT, { value: undefined, writable: true });

  // ── Lens proto: probe preact's Lens prototype, chain off it.
  const probe = lens<T>(
    () => undefined as any,
    () => {},
  );
  const lensInstanceProto = Object.getPrototypeOf(probe);
  const lensProto = Object.create(lensInstanceProto);
  setupProto(lensProto);
  installProjectionAxes(lensProto, fieldKeys, nestedMap, "lens");
  Object.defineProperty(lensProto, STRUCT, { value: undefined, writable: true });
  Object.defineProperty(lensProto, WRITABLE, { value: true });

  let self!: ReturnType<typeof defineNestedCell<T, M>>;
  const isFn = (v: unknown): v is Signal<T> & M =>
    v != null && typeof v === "object" && (v as any)[STRUCT] === self;
  const isWritableFn = (v: unknown): v is Signal<T> & M =>
    isFn(v) && (v as any)[WRITABLE] === true;

  self = {
    signal(v: T): Signal<T> & M {
      const inst = Object.create(rwProto);
      // Initialize Signal's instance fields (so `_equals`, `_targets`,
      // etc. exist for any preact code that walks them). The
      // underlying `_value` is unused — our composed getter never
      // reads it.
      Signal.call(inst, undefined, sigOpts as any);

      const obj = v as Record<string, unknown>;
      for (const k of fieldKeys) {
        const nested = nestedMap[k];
        const initial = obj[k as string];
        const sig = nested
          ? nested.signal(initial as never)
          : signal(initial);
        Object.defineProperty(inst, k as PropertyKey, {
          value: sig,
          enumerable: false,
          configurable: false,
          writable: false,
        });
      }
      return inst as Signal<T> & M;
    },
    derived(fn: () => T): ReadonlySignal<T> & M {
      const inst = Object.create(roProto);
      Computed.call(inst, fn as () => unknown, sigOpts as any);
      return inst as ReadonlySignal<T> & M;
    },
    lens(read: () => T, write: (v: T) => void): Signal<T> & M {
      const l = lens(read, write) as any;
      Object.setPrototypeOf(l, lensProto);
      if (equalsFn) l._equals = equalsFn;
      return l as Signal<T> & M;
    },
    is: isFn,
    isWritable: isWritableFn,
    [Symbol.hasInstance]: isFn,
  };

  rwProto[STRUCT] = self;
  roProto[STRUCT] = self;
  lensProto[STRUCT] = self;

  return self;
}

/** Install per-field axes on a non-SoA proto (RO / Lens). Nested
 *  fields project through the nested struct's own factory; non-nested
 *  fields use the standard lens-over-whole-value pattern. */
function installProjectionAxes<T>(
  proto: object,
  fields: readonly (keyof T)[],
  nestedMap: NestedMap<T>,
  flavor: "ro" | "lens",
): void {
  for (const f of fields) {
    const nested = nestedMap[f];
    Object.defineProperty(proto, f as PropertyKey, {
      configurable: true,
      get(this: any) {
        const self = this;
        let view: unknown;
        if (nested) {
          if (flavor === "ro") {
            view = nested.derived(
              () =>
                (self.value as Record<string, unknown>)[f as string] as never,
            );
          } else {
            view = nested.lens(
              () =>
                (self.value as Record<string, unknown>)[f as string] as never,
              (n) => {
                const cur = self.value as Record<string, unknown>;
                self.value = { ...cur, [f as string]: n };
              },
            );
          }
        } else if (flavor === "ro") {
          view = computed(
            () => (self.value as Record<string, unknown>)[f as string],
          );
        } else {
          view = lens(
            () => (self.value as Record<string, unknown>)[f as string],
            (n) => {
              const cur = self.value as Record<string, unknown>;
              self.value = { ...cur, [f as string]: n };
            },
          );
        }
        Object.defineProperty(self, f as PropertyKey, {
          value: view,
          enumerable: false,
          configurable: false,
          writable: false,
        });
        return view;
      },
    });
  }
}
