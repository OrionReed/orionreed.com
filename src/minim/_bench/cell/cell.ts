// Proposed minimal "cell" primitive — the slim alternative to the
// current `signals/struct.ts` framework. Goals:
//
//   - Same V8-friendly construction (Object.create + constructor.call
//     against per-type prototypes; no setPrototypeOf after construct)
//   - Same lazy-cache pattern for axes + getters (own-property install)
//   - Same per-arity unrolling WHERE IT EARNS ITS KEEP (axis writers
//     via `construct`; bench showed 1.6–2.2× wins). Lifters NOT
//     unrolled (~20% perf loss; not worth ~115 LOC).
//   - Open: anything you can put on a prototype works. No Schema
//     constraint, no nested-struct branch in finalize, no Builder DSL.
//   - Two type generics, not six: `Reactive<T, Proto> = Signal<T> & Proto`.
//
// Total budget: ~250 lines. Compare current struct.ts at 895.
//
// Reuses [STRUCT], [ALGEBRA], [LERP] from the existing framework so
// `instanceof` checks, integrators, and the tween engine continue to
// work uniformly across cell-built and struct-built types.

import {
  Signal,
  Computed,
  computed,
  lens,
  type ReadonlySignal,
} from "../../core/signal";
import { LERP } from "../../core/tween";
import { ALGEBRA, STRUCT, WRITABLE } from "../../signals/struct";

// ── The primitive ──────────────────────────────────────────────────

/** Per-type cell factory bundle. Returned by `defineCell`. */
export interface CellType<T, M> {
  readonly name: string;
  /** Writable cell with explicit initial value. */
  signal(v: T): Signal<T> & M;
  /** Read-only derived cell. */
  derived(fn: () => T): ReadonlySignal<T> & M;
  /** Writable lens cell. Reads/writes round-trip through the closures. */
  lens(read: () => T, write: (v: T) => void): Signal<T> & M;
  /** O(1) `instanceof`-style narrowing via the [STRUCT] marker. */
  is(v: unknown): v is Signal<T> & M;
  /** True for `signal()` and `lens()` results, false for `derived()`. */
  isWritable(v: unknown): v is Signal<T> & M;
}

interface CellOpts<T> {
  /** Suppress no-op writes when equal. */
  equals?: (a: T, b: T) => boolean;
}

/** Build a Signal-subtype family with custom prototype contents.
 *  All three flavors (signal/derived/lens) share installations via
 *  prototype chains:
 *
 *    signal:  inst → rwProto  → Signal.prototype
 *    derived: inst → roProto  → Computed.prototype
 *    lens:    inst → lensProto → <preact Lens.prototype> → Computed → Signal
 *
 *  Two arg slots intentional: `methods` is a regular object whose
 *  values are assigned (best for functions, symbol slots like
 *  [LERP]/[ALGEBRA], simple values); `descriptors` is a
 *  PropertyDescriptorMap installed via Object.defineProperties (the
 *  axes-helpers and lazy-getter-helpers return descriptor maps).
 *
 *  This split exists because spreading a PropertyDescriptorMap into
 *  a plain object copies the descriptor *as a value*, not as a real
 *  getter/setter — a footgun if hidden inside one input. */
export function defineCell<T, M extends object>(
  name: string,
  methods: M,
  descriptors: PropertyDescriptorMap = {},
  opts: CellOpts<T> = {},
): CellType<T, M> {
  const equalsFn = opts.equals;
  const sigOpts = equalsFn ? { name, equals: equalsFn } : { name };

  let self!: CellType<T, M>;

  const setupProto = (proto: object) => {
    // Methods: copy as regular properties (functions, symbols, values).
    for (const key of Reflect.ownKeys(methods)) {
      const desc = Object.getOwnPropertyDescriptor(methods, key)!;
      Object.defineProperty(proto, key, desc);
    }
    // Descriptors: install via defineProperties (preserves get/set).
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

  // ── lens proto: probe the preact Lens prototype, chain off it.
  const probe = lens<T>(() => undefined as any, () => {});
  const lensInstanceProto = Object.getPrototypeOf(probe);
  const lensProto = Object.create(lensInstanceProto);
  setupProto(lensProto);
  Object.defineProperty(lensProto, STRUCT, { value: undefined, writable: true });
  Object.defineProperty(lensProto, WRITABLE, { value: true });

  function makeSignal(v: T): Signal<T> & M {
    const inst = Object.create(rwProto);
    Signal.call(inst, v, sigOpts as any);
    return inst as Signal<T> & M;
  }

  function makeDerived(fn: () => T): ReadonlySignal<T> & M {
    const inst = Object.create(roProto);
    Computed.call(inst, fn as () => unknown, sigOpts as any);
    return inst as ReadonlySignal<T> & M;
  }

  function makeLens(
    read: () => T,
    write: (v: T) => void,
  ): Signal<T> & M {
    const l = lens(read, write) as any;
    Object.setPrototypeOf(l, lensProto);
    if (equalsFn) l._equals = equalsFn;
    return l as Signal<T> & M;
  }

  const isFn = (v: unknown): v is Signal<T> & M =>
    v != null && typeof v === "object" && (v as any)[STRUCT] === self;

  const isWritableFn = (v: unknown): v is Signal<T> & M =>
    isFn(v) && (v as any)[WRITABLE] === true;

  self = {
    name,
    signal: makeSignal,
    derived: makeDerived,
    lens: makeLens,
    is: isFn,
    isWritable: isWritableFn,
  };

  // Stamp the [STRUCT] marker on each per-type proto now that `self`
  // exists. Same pattern current struct.ts uses.
  rwProto[STRUCT] = self;
  roProto[STRUCT] = self;
  lensProto[STRUCT] = self;

  return self;
}

// ── Helpers (each independently testable / composable) ─────────────

/** Per-field axis projections. Returns property descriptors for each
 *  field name; reads return a lens projecting that field, writes
 *  round-trip through `write`. Lazy-built and cached as own-property
 *  on first read.
 *
 *  Pair with `construct(fn)` for fast (per-arity-unrolled) writers,
 *  or pass any `(v, k, n) => v` for the spread fallback. */
export function axes<T, K extends keyof T>(
  fields: readonly K[],
  write: (v: T, k: K, n: T[K]) => T,
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
            self.value = write(self.peek(), f, n as T[K]);
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

/** Lazy property getter — first read calls `fn`, caches the result as
 *  own-property, subsequent reads bypass the proto getter entirely.
 *  ~5ns per cached read (the bench measured 4.7ns on this machine). */
export function lazy<R>(fn: (this: any) => R): PropertyDescriptor {
  return {
    configurable: true,
    get(this: any) {
      const val = fn.call(this);
      Object.defineProperty(this, "__lazy", { value: val, configurable: true });
      // We don't know the property name here — the cache install
      // happens via the descriptor's installer pattern below.
      return val;
    },
  };
}

/** Build a getter descriptor that caches under `name`. Convenience
 *  for `lazy(...)` when you want the cache key to be the property
 *  name itself. */
export function lazyAt<R>(name: string, fn: (this: any) => R): PropertyDescriptor {
  return {
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

/** Lazy-getter object: `lazies({ name: fn, ... })` → property
 *  descriptors. Spreads cleanly into the proto literal. */
export function lazies<R extends Record<string, (this: any) => any>>(
  defs: R,
): PropertyDescriptorMap {
  const out: PropertyDescriptorMap = {};
  for (const name of Object.keys(defs)) {
    out[name] = lazyAt(name, defs[name]);
  }
  return out;
}

/** Lift a pure op `(self, ...args) => T` into a method that returns a
 *  derived cell, auto-resolving Signal/thunk/literal arg shapes.
 *
 *  Per-arity-unrolled (0/1/2; arity-3+ falls back to generic).
 *  Recovers the ~15-20% lifted-op perf the framework used to bake
 *  in. The unrolling lives ONLY here (one helper) instead of in the
 *  framework's `finalize`. The arity-1 case further specializes by
 *  arg shape (signal/thunk/literal) at construction so the per-call
 *  closure is monomorphic. */
export function lift<T>(
  fn: (self: T, ...args: any[]) => T,
  derived: (fn: () => T) => unknown,
) {
  const arity = Math.max(0, fn.length - 1);

  if (arity === 0) {
    return function (this: Signal<T>) {
      const self = this;
      return derived(() => fn(self.value));
    };
  }

  if (arity === 1) {
    return function (this: Signal<T>, a: unknown) {
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
    return function (this: Signal<T>, a: unknown, b: unknown) {
      const self = this;
      const ar = readerFor(a);
      const br = readerFor(b);
      return derived(() => fn(self.value, ar(), br()));
    };
  }

  // Generic fallback for arity 3+ (rare).
  return function (this: Signal<T>, ...args: unknown[]) {
    const self = this;
    const readers = args.map(readerFor);
    return derived(() => fn(self.value, ...readers.map((r) => r())));
  };
}

/** Same as `lift` but wraps in `computed` (scalar return type). */
export function liftScalar<T, R>(fn: (self: T, ...args: any[]) => R) {
  const arity = Math.max(0, fn.length - 1);

  if (arity === 0) {
    return function (this: Signal<T>): ReadonlySignal<R> {
      const self = this;
      return computed(() => fn(self.value));
    };
  }

  if (arity === 1) {
    return function (this: Signal<T>, a: unknown): ReadonlySignal<R> {
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
    return function (
      this: Signal<T>,
      a: unknown,
      b: unknown,
    ): ReadonlySignal<R> {
      const self = this;
      const ar = readerFor(a);
      const br = readerFor(b);
      return computed(() => fn(self.value, ar(), br()));
    };
  }

  return function (this: Signal<T>, ...args: unknown[]): ReadonlySignal<R> {
    const self = this;
    const readers = args.map(readerFor);
    return computed(() => fn(self.value, ...readers.map((r) => r())));
  };
}

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

/** Stamp [LERP] (for `.to` tween) and [ALGEBRA] (for integrators) on
 *  the proto. Returns a property bag suitable for spreading into the
 *  proto literal. The `lerp` op is also installed as a regular method. */
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

/** Build a fast axis writer from a positional constructor.
 *
 *  `construct((x, y, ...) => value)` returns a `(value, key, newField) =>
 *  newValue` writer. The axis writer factory `axes(...)` calls it
 *  per-field write, passing the field key and new value.
 *
 *  Per-arity unrolling for arities 1–6 (the bench showed 1.6–2.2×
 *  wins vs generic, with construct beating spread by 1.27–2.23×). */
export function construct<T>(
  fn: (...args: any[]) => T,
): (v: T, k: keyof T, n: T[keyof T]) => T {
  // We don't know the field order here — but axes() iterates fields in
  // declaration order, so we capture them at first call. This wires
  // the unrolled writer once the field set is known.
  let fields: (keyof T)[] | null = null;
  let writer: (v: T, k: keyof T, n: T[keyof T]) => T;

  return (v: T, k: keyof T, n: T[keyof T]): T => {
    if (writer) return writer(v, k, n);
    fields = Object.keys(v as any) as (keyof T)[];
    writer = makeWriter<T>(fields, fn);
    return writer(v, k, n);
  };
}

function makeWriter<T>(
  fields: readonly (keyof T)[],
  construct: (...args: any[]) => T,
): (v: T, k: keyof T, n: T[keyof T]) => T {
  const arity = fields.length;
  const idx = new Map<keyof T, number>();
  for (let i = 0; i < arity; i++) idx.set(fields[i], i);

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
  if (arity === 1) {
    return (_v, _k, n) => construct(n);
  }

  // Generic per-arity loop for 3, 5, 7+. Allocates an args array.
  const fs = fields;
  return (v, k, n) => {
    const fieldIdx = idx.get(k)!;
    const args = new Array(arity);
    for (let i = 0; i < arity; i++) {
      args[i] = i === fieldIdx ? n : v[fs[i]];
    }
    return construct(...args);
  };
}

/** Spread fallback — slower than `construct`, works for any shape. */
export function spreadWriter<T>(): (v: T, k: keyof T, n: T[keyof T]) => T {
  return (v, k, n) => ({ ...v, [k]: n }) as T;
}
