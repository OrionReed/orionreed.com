// PROPOSAL: a Builder-facade redesign of `signals/struct.ts`. Same
// authoring shape as today (fluent .construct().equals().ops()...
// .build()), but underneath is ~400 LOC vs current 895. Keys:
//
//   1. The "primitive" is `defineCell(name, methods, descriptors,
//      opts)` — ~50 LOC. Builds a Signal-subtype with custom proto.
//      Same V8 trick as current struct (Object.create + ctor.call).
//
//   2. Helpers (`lift`, `liftScalar`, `axes`, `lazies`, `withAlgebra`,
//      `construct`) compose into the methods/descriptors bags. Each
//      ~10-50 LOC, independently testable. Per-arity unrolling lives
//      ONLY in `lift` / `liftScalar` / `construct`.
//
//   3. The Builder is a thin fluent facade that collects user's
//      ops/scalars/methods/getters into the right bags, then calls
//      `defineCell` once on `.build()`. ~120 LOC.
//
// What changes for users: nothing visible. Same struct() entry, same
// fluent chain, same methods at the call site. What changes
// architecturally:
//
//   - No Schema constraint — T can be any type (arrays, variants…).
//     The Builder ASSUMES record-shaped defaults for axis derivation
//     but does NOT enforce.
//   - Reactive<T> drops to 4 generics from 6; conditional types
//     still exist but contained in one place.
//   - Drop the nested-struct field branch — if a user wants it,
//     they put a Vec directly in the defaults; no special handling
//     needed (there's no Schema to teach about it).
//
// Power-user escape: `defineCell` is exported so non-record value
// types (strings, arrays, custom shapes) can drop down past the
// Builder.

import {
  Signal,
  Computed,
  computed,
  lens,
  type ReadonlySignal,
} from "../../core/signal";
import { LERP } from "../../core/tween";
import { ALGEBRA, STRUCT, WRITABLE } from "../../signals/struct";

// ── Type surface ───────────────────────────────────────────────────

export type RW = "rw" | "ro";

type ReactiveArgs<A extends readonly unknown[]> = {
  [K in keyof A]: A[K] | Signal<A[K]> | ReadonlySignal<A[K]> | (() => A[K]);
};

/** Lift a struct-returning op to its method form. */
type LiftStructFn<F, T, O, G> = F extends (
  self: any,
  ...args: infer A
) => any
  ? (...args: ReactiveArgs<A>) => Reactive<T, O, {}, G, "ro">
  : never;

/** Lift a scalar-returning op to its method form. */
type LiftScalarFn<F> = F extends (self: any, ...args: infer A) => infer R
  ? (...args: ReactiveArgs<A>) => ReadonlySignal<R>
  : never;

/** Methods bag derived from ops + scalars + free-form. */
type Methods<T, O, X, M, G> =
  & { [K in keyof O]: LiftStructFn<O[K], T, O, G> }
  & { [K in keyof X]: LiftScalarFn<X[K]> }
  & M;

/** Getter return types, projected as readonly properties. */
type GetterProps<G> = {
  readonly [K in keyof G]: G[K] extends (this: any) => infer R ? R : never;
};

/** Axis projections of a record-shaped T, writable when parent is. */
type Axes<T, W extends RW> = T extends Record<string, any>
  ? {
      readonly [K in keyof T]: W extends "rw"
        ? Signal<T[K]>
        : ReadonlySignal<T[K]>;
    }
  : {};

/** When the struct's ops include `lerp`, `.to(target, dur)` is
 *  installed on writable Reactives via the prototype `[LERP]` slot. */
type Tweenable<T, O, W extends RW> = W extends "rw"
  ? O extends { lerp: (a: any, b: any, t: number) => T }
    ? { to(target: T, dur: number, ease?: (t: number) => number): unknown }
    : {}
  : {};

/** A reactive cell carrying a value of type T. Writability flows
 *  through axes; ops always return read-only derived. Generics:
 *
 *    T  — value type
 *    O  — struct-returning ops bag (auto-lifted to derived methods)
 *    X  — scalar-returning ops bag (auto-lifted to computed methods)
 *    G  — lazy-getters bag
 *    M  — free-form methods bag (verbatim, writable-only)
 *    W  — "rw" or "ro"
 *
 *  Six generics is still a lot, but only T is positional in user
 *  code — the rest default and are filled in by the Builder. */
export type Reactive<
  T,
  O = {},
  X = {},
  G = {},
  M = {},
  W extends RW = "rw",
> =
  & (W extends "rw" ? Signal<T> : ReadonlySignal<T>)
  & Axes<T, W>
  & Methods<T, O, X, M, G>
  & GetterProps<G>
  & Tweenable<T, O, W>
  & (W extends "rw" ? M : {});

/** A registered struct: factory namespace + identity-as-instanceof. */
export interface StructType<T, O = {}, X = {}, G = {}, M = {}> {
  readonly name: string;
  readonly defaults: T;
  signal(v: T): Reactive<T, O, X, G, M, "rw">;
  derived(fn: () => T): Reactive<T, O, X, G, M, "ro">;
  lens(read: () => T, write: (v: T) => void): Reactive<T, O, X, G, M, "rw">;
  is(v: unknown): v is Reactive<T, O, X, G, M, RW>;
  isWritable(v: unknown): v is Reactive<T, O, X, G, M, "rw">;
}

// ── Internal helpers ───────────────────────────────────────────────

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

/** Per-arity-unrolled struct-op lifter. arity 0/1/2 unrolled, 3+
 *  generic. The arity-1 case further specializes by arg shape at
 *  construction so the per-call closure is monomorphic. */
function liftOp<T>(
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

/** Per-arity-unrolled scalar-op lifter. */
function liftScalarOp<T>(fn: (self: T, ...args: any[]) => unknown) {
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

/** Per-arity-unrolled axis writer (the bench winner — 1.6-2.2× over
 *  generic). arity 1/2/4/6 unrolled; others use a fixed-size args
 *  array fallback. */
function makeAxisWriter<T>(
  fields: readonly (keyof T)[],
  construct: (...args: any[]) => T,
): (v: T, k: keyof T, n: T[keyof T]) => T {
  const arity = fields.length;
  if (arity === 1) {
    return (_v, _k, n) => construct(n);
  }
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
  // Generic fallback (3, 5, 7+).
  const idx = new Map<keyof T, number>();
  for (let i = 0; i < arity; i++) idx.set(fields[i], i);
  const fs = fields;
  return (v, k, n) => {
    const fieldIdx = idx.get(k)!;
    const args = new Array(arity);
    for (let i = 0; i < arity; i++) args[i] = i === fieldIdx ? n : v[fs[i]];
    return construct(...args);
  };
}

function spreadWriter<T>(): (v: T, k: keyof T, n: T[keyof T]) => T {
  return (v, k, n) => ({ ...v, [k]: n }) as T;
}

/** Build per-axis lazy getter descriptors. Each first-read installs
 *  a `lens` as own-property; subsequent reads bypass the proto getter
 *  entirely. */
function buildAxisDescriptors<T>(
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

/** Build lazy-getter descriptors. First read calls user fn, caches
 *  result as own-property on the instance. */
function buildLazyDescriptors(
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

// ── The cell primitive ────────────────────────────────────────────

interface CellOpts<T> {
  equals?: (a: T, b: T) => boolean;
}

/** Build a Signal-subtype family with custom proto contents.
 *  Public escape hatch — lets you build reactive value types that
 *  don't fit the Builder's record-shaped assumption (strings,
 *  arrays, variants, …). The Builder uses this internally on
 *  `.build()`. */
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

  const rwProto = Object.create(Signal.prototype);
  setupProto(rwProto);
  Object.defineProperty(rwProto, STRUCT, { value: undefined, writable: true });
  Object.defineProperty(rwProto, WRITABLE, { value: true });

  const roProto = Object.create(Computed.prototype);
  setupProto(roProto);
  Object.defineProperty(roProto, STRUCT, { value: undefined, writable: true });

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
}

type OpsBag<T> = Record<string, (self: T, ...args: any[]) => T>;
type ScalarsBag<T> = Record<string, (self: T, ...args: any[]) => unknown>;
type MethodsBag<T, O, X, M, G> = Record<
  string,
  (this: Reactive<T, O, X, G, M, "rw">, ...args: any[]) => any
>;
type GettersBag<T, O, X, M, G> = Record<
  string,
  (this: Reactive<T, O, X, G, M, RW>) => any
>;

class Builder<T, O = {}, X = {}, G = {}, M = {}> {
  constructor(
    private state: BuilderState<T>,
    private ops_: O,
    private scalars_: X,
    private getters_: G,
    private methods_: M,
  ) {}

  equals(fn: (a: T, b: T) => boolean): Builder<T, O, X, G, M> {
    return new Builder({ ...this.state, equals: fn }, this.ops_, this.scalars_, this.getters_, this.methods_);
  }

  construct(fn: (...args: any[]) => T): Builder<T, O, X, G, M> {
    return new Builder({ ...this.state, construct: fn }, this.ops_, this.scalars_, this.getters_, this.methods_);
  }

  ops<O2 extends OpsBag<T>>(bag: O2): Builder<T, O & O2, X, G, M> {
    return new Builder<T, O & O2, X, G, M>(
      this.state,
      { ...this.ops_, ...bag } as O & O2,
      this.scalars_,
      this.getters_,
      this.methods_,
    );
  }

  scalars<X2 extends ScalarsBag<T>>(bag: X2): Builder<T, O, X & X2, G, M> {
    return new Builder<T, O, X & X2, G, M>(
      this.state,
      this.ops_,
      { ...this.scalars_, ...bag } as X & X2,
      this.getters_,
      this.methods_,
    );
  }

  getters<G2 extends GettersBag<T, O, X, M, G>>(
    bag: G2,
  ): Builder<T, O, X, G & G2, M> {
    return new Builder<T, O, X, G & G2, M>(
      this.state,
      this.ops_,
      this.scalars_,
      { ...this.getters_, ...bag } as G & G2,
      this.methods_,
    );
  }

  methods<M2 extends MethodsBag<T, O, X, M, G>>(
    bag: M2,
  ): Builder<T, O, X, G, M & M2> {
    return new Builder<T, O, X, G, M & M2>(
      this.state,
      this.ops_,
      this.scalars_,
      this.getters_,
      { ...this.methods_, ...bag } as M & M2,
    );
  }

  build(): StructType<T, O, X, G, M> {
    return finalize(
      this.state,
      this.ops_ as Record<string, any>,
      this.scalars_ as Record<string, any>,
      this.getters_ as Record<string, any>,
      this.methods_ as Record<string, any>,
    ) as StructType<T, O, X, G, M>;
  }
}

/** Build a `Reactive<T>` factory. Fluent: chain `.construct()`,
 *  `.equals()`, `.ops()`, `.scalars()`, `.getters()`, `.methods()`,
 *  then `.build()`. */
export function struct<T>(name: string, defaults: T): Builder<T> {
  return new Builder({ name, defaults }, {}, {}, {}, {});
}

// ── finalize: the Builder→cell bridge ─────────────────────────────

function finalize<T>(
  state: BuilderState<T>,
  ops: Record<string, (self: T, ...args: any[]) => T>,
  scalars: Record<string, (self: T, ...args: any[]) => unknown>,
  getters: Record<string, (this: any) => unknown>,
  rawMethods: Record<string, (this: any, ...args: any[]) => any>,
): StructType<T> {
  // Forward ref so lifted ops can return Reactives of this struct.
  let cellRef: ReturnType<typeof defineCell<T, any>>;
  const mkDerived = (fn: () => T) => cellRef.derived(fn);

  // Methods bag: lift ops + scalars + raw methods + algebra slots.
  const methods: Record<PropertyKey, unknown> = {};

  for (const name of Object.keys(ops)) {
    methods[name] = liftOp(ops[name], mkDerived);
  }
  for (const name of Object.keys(scalars)) {
    methods[name] = liftScalarOp(scalars[name]);
  }
  for (const name of Object.keys(rawMethods)) {
    methods[name] = rawMethods[name];
  }

  // Stamp algebra slots if the user provided add/sub/scale or lerp.
  // Integrators read [ALGEBRA] to find vector-space ops; the tween
  // engine reads [LERP] to dispatch `.to`.
  if (ops.lerp) methods[LERP] = ops.lerp;
  if (ops.add && ops.sub && ops.scale) {
    methods[ALGEBRA] = { add: ops.add, sub: ops.sub, scale: ops.scale };
  }

  // Descriptors bag: axes + lazy getters.
  const fieldKeys = Object.keys(state.defaults as object) as (keyof T)[];
  const writer = state.construct
    ? makeAxisWriter<T>(fieldKeys, state.construct)
    : spreadWriter<T>();
  const descriptors: PropertyDescriptorMap = {
    ...buildAxisDescriptors<T>(fieldKeys, writer),
    ...buildLazyDescriptors(getters),
  };

  cellRef = defineCell<T, any>(state.name, methods, descriptors, {
    equals: state.equals,
  });

  return {
    name: state.name,
    defaults: state.defaults,
    signal: cellRef.signal,
    derived: cellRef.derived,
    lens: cellRef.lens,
    is: cellRef.is,
    isWritable: cellRef.isWritable,
  } as StructType<T>;
}
