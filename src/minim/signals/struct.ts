// Reactive value-type framework — runtime implementation. The
// type-level surface (`Cell` / `ReadonlyCell` / `StructType` /
// `WriteOf` / `ReadOf` / `NestedMap` / `NestedInput`) lives in
// `core/cell.ts`. This file just implements the builder, the per-type
// prototype machinery, and the lifted-op closures.
//
// `struct(name, defaults)` is the fluent Builder for record-shaped
// value types; internally it lifts ops and scalars, installs lazy
// axis/getter descriptors, and calls a per-type cell factory.
// `.nested(map)` opts into full SoA storage (per-field signals).
//
// `lerpable(initial, lerp)` (in core/tween.ts) is the escape hatch
// for value types you don't want to declare as a full struct.

import {
  Signal,
  Computed,
  computed,
  lens,
  signal,
  batch,
  type ReadonlySignal,
} from "./signal";
import {
  type Cell,
  type ReadonlyCell,
  type StructType,
  type NestedMap,
  type NestedInput,
} from "./cell";
import { LERP, tween, type Easing, type Tween } from "./tween";
import { asReader, toSig, type Val } from "./arg";

// Re-export the type-level surface so files that import from
// `./struct` (the historical home of `Reactive<...>` and friends)
// continue to work after the move into `signals/cell`.
export type {
  Cell,
  ReadonlyCell,
  StructType,
  WriteOf,
  ReadOf,
} from "./cell";

// ── Marker symbols ─────────────────────────────────────────────────
//
// Internal but exported so other framework files can read them.
// Stamped by `defineCell` on every per-type prototype.

/** @internal Marks a per-type prototype with the `StructType` that
 *  owns it. `v[STRUCT] === MyStruct` powers fast `instanceof` checks. */
export const STRUCT = Symbol.for("minim.struct");

// ── Capability slots ──────────────────────────────────────────────
//
// A struct can declare "capabilities" — typed contracts that library
// functions consume via prototype lookup. Three are built-in:
//
//   [ALGEBRA]  { add(a, b), sub(a, b), scale(a, k) }
//                Vector-space algebra. Consumed by `spring`, `oscillate`,
//                `drift`, `attract`, `mean`. Also enables auto-method
//                `.add(b)` / `.sub(b)` / `.scale(k)` on cells.
//
//   [LERP]     (a, b, t) => T
//                Linear interpolation. Consumed by `tween` / `.to()`.
//                Auto-installs `.to(target, dur)` and `.lerp(b, t)`
//                methods on writable cells.
//
//   [METRIC]   (a, b) => number
//                Distance function. Consumed by spring/oscillate's
//                precision-stop check (the principled `normOf` fix).
//                Auto-installs `.distance(b)` scalar method.
//
// User-defined capabilities use the same pattern: define a `Symbol.for(...)`
// for global uniqueness, then `registerCapability(Struct, sym, impl)` to
// stamp it on existing structs. Library functions look up the slot at
// runtime.

/** @internal Carries the value type's vector-space algebra. */
export const ALGEBRA = Symbol.for("minim.algebra");

/** @internal Carries the value type's distance function. */
export const METRIC = Symbol.for("minim.metric");

/** @internal Marks a writable per-type prototype (vs read-only).
 *  Used by `StructType.isWritable`. */
export const WRITABLE = Symbol.for("minim.writable");

// ── Lifters: bag-of-functions → reactive methods ───────────────────
//
// Each `op` / `scalar` in the user's bag becomes a method whose first
// arg is bound to `this.value` and remaining args are bound via
// `asReader` (the canonical Val<T> → thunk normaliser). The per-call
// closure stays monomorphic — `asReader` picks the right reader once
// at construction.
//
// Per-arity unrolled (0/1/2; 3+ generic). The arity-1 inline path
// shaves one stack-frame for the most common case (`vec.add(b)`).

/** Lift a pure struct-op into a method that returns a derived cell. */
function lift<T>(
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
      const ar = asReader(a as Val<unknown>);
      return derived(() => fn(self.value, ar()));
    };
  }
  if (arity === 2) {
    return function (this: ReadonlySignal<T>, a: unknown, b: unknown) {
      const self = this;
      const ar = asReader(a as Val<unknown>);
      const br = asReader(b as Val<unknown>);
      return derived(() => fn(self.value, ar(), br()));
    };
  }
  return function (this: ReadonlySignal<T>, ...args: unknown[]) {
    const self = this;
    const readers = args.map((a) => asReader(a as Val<unknown>));
    return derived(() => fn(self.value, ...readers.map((r) => r())));
  };
}

/** Lift a scalar-returning op into a method returning a `ReadonlyCell<R>`
 *  via `computed`. Same per-arity dispatch as `lift`. */
function liftScalar<T>(fn: (self: T, ...args: any[]) => unknown) {
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
      const ar = asReader(a as Val<unknown>);
      return computed(() => fn(self.value, ar()));
    };
  }
  if (arity === 2) {
    return function (this: ReadonlySignal<T>, a: unknown, b: unknown) {
      const self = this;
      const ar = asReader(a as Val<unknown>);
      const br = asReader(b as Val<unknown>);
      return computed(() => fn(self.value, ar(), br()));
    };
  }
  return function (this: ReadonlySignal<T>, ...args: unknown[]) {
    const self = this;
    const readers = args.map((a) => asReader(a as Val<unknown>));
    return computed(() => fn(self.value, ...readers.map((r) => r())));
  };
}

/** Per-arity-unrolled axis writer factory. Bench winner: 1.6-2.2× over
 *  the generic args-array fallback. arity 1/2/4/6 unrolled (the cases
 *  Vec / Box / Matrix2D need); 3/5/7+ use the generic loop. */
function construct<T>(
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
function axes<T>(
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
function lazies(
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
  /** Suppress no-op writes when equal. */
  equals?: (a: T, b: T) => boolean;
}

/** Builds a Signal-subtype family with a custom per-type prototype.
 *  `methods` are assigned plain (functions, `[LERP]`/`[ALGEBRA]` slots);
 *  `descriptors` go through `defineProperties` so getters stay getters. */
function defineCell<T, M extends object>(
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

// ── BuilderState — the internal config record produced by both the
//    public `defineStruct({...})` entry and the per-value-type wiring
//    in `values/*`. Keeps `finalize` agnostic of the entry shape. ──

interface BuilderState<T> {
  name: string;
  defaults: T;
  equals?: (a: T, b: T) => boolean;
  construct?: (...args: any[]) => T;
  nested?: NestedMap<T>;
  algebra?: { add: (a: T, b: T) => T; sub: (a: T, b: T) => T; scale: (a: T, k: number) => T };
  lerp?: (a: T, b: T, t: number) => T;
  metric?: (a: T, b: T) => number;
}

// ── finalize: build a StructType from a BuilderState + ops bags ───

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

  // ── Capability detection — both auto (from named ops) and explicit
  //    (via `state.algebra` / `.lerp` / `.metric` slots). Explicit
  //    wins if both are set. ────────────────────────────────────────
  const lerpFn = state.lerp ?? ops.lerp;
  if (lerpFn) {
    methods[LERP] = lerpFn;
    // `.to(target, dur, ease?)` is installed per-struct here (not on
    // Signal.prototype) so plain `signal()` has no `.to`.
    methods.to = function (
      this: Signal<T>,
      target: T,
      dur: Val<number>,
      ease?: Easing,
    ): Tween<T> {
      return tween(this, target, dur, ease, lerpFn);
    };
  }
  const algebra =
    state.algebra ??
    (ops.add && ops.sub && ops.scale
      ? { add: ops.add, sub: ops.sub, scale: ops.scale }
      : undefined);
  if (algebra) methods[ALGEBRA] = algebra;
  if (state.metric) {
    methods[METRIC] = state.metric;
    // Auto-install `.distance(b)` scalar method if not already present.
    if (!methods.distance) {
      methods.distance = liftScalar(state.metric as (self: T, b: T) => number);
    }
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

// ── Per-field input adoption ─────────────────────────────────────
//
// Each `.signal({...})` field input is normalized to a backing signal:
//
//   - Already a Cell of the matching nested type         → adopt as-is
//   - Some other Signal<T[K]>                            → wrap in `.lens` (rw)
//                                                          or `.derived` (ro)
//   - A function () => T[K]                              → wrap in derived
//   - A literal T[K]                                     → fresh signal
//
// Writability of a generic Signal is detected via the value descriptor's
// setter (Computed and Lens-via-Signal have no setter; plain Signal does).

function isWritableSig(s: object): boolean {
  let proto: object | null = Object.getPrototypeOf(s);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc) return typeof desc.set === "function";
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

function adoptField(
  initial: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nested: StructType<any, any, any, any, any, any> | undefined,
): Signal<unknown> {
  if (nested) {
    if (nested.is(initial)) return initial as unknown as Signal<unknown>;
    if (initial != null && (initial as object) instanceof Signal) {
      const sig = initial as Signal<unknown>;
      return (
        isWritableSig(sig)
          ? nested.lens(
              () => sig.value,
              (v) => {
                sig.value = v;
              },
            )
          : nested.derived(() => sig.value)
      ) as unknown as Signal<unknown>;
    }
    if (typeof initial === "function") {
      return nested.derived(initial as () => unknown) as unknown as Signal<unknown>;
    }
    return nested.signal(initial as NestedInput<any, any>) as unknown as Signal<unknown>;
  }
  // Non-nested field — canonical Val<T> → ReadonlyCell dispatch via
  // `toSig`. Signals pass through; thunks become computeds; literals
  // get wrapped in a fresh signal.
  return toSig(initial as Val<unknown>) as Signal<unknown>;
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
  signal(v: NestedInput<T>): Signal<T> & M;
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

  // ── RW proto: full SoA. Play off Signal.prototype so existing
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
    signal(v: NestedInput<T>): Signal<T> & M {
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
        const sig = adoptField(initial, nested);
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

// ── defineStruct: flat-config alternative to the Builder ──────────
//
// One function, one config object. Same runtime as the Builder under
// the hood — calls into `finalize` directly. Differences:
//
//   - Capabilities (`algebra`, `lerp`, `metric`) are first-class config
//     keys, not auto-detected from ops-bag names. Explicit, clearer.
//   - Auto-installs methods from capabilities: `.add/.sub/.scale` from
//     `algebra`; `.to(target, dur)` and `.lerp(b, t)` from `lerp`;
//     `.distance(b)` from `metric`.
//   - No method-chain plumbing — single function call, no Builder
//     instances allocated during definition.

/** Vector-space capability. Enables `spring` / `oscillate` / `drift`
 *  / `attract` / `mean` over the struct's value type. Also auto-lifts
 *  `.add(b)` / `.sub(b)` / `.scale(k)` as cell methods. */
export interface VectorSpace<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}

/** Flat config for `defineStruct`. The function captures the literal
 *  type via a `const` generic and projects each slot into the
 *  returned `StructType`. */
export interface StructConfig<T> {
  /** Display name and `Symbol.hasInstance` discriminator. */
  name: string;
  /** Default value used when `.signal()` is called without a seed. */
  defaults: T;
  /** Positional constructor. Powers fast (per-arity-unrolled) axis
   *  writers; without it the framework falls back to object spread. */
  construct?: (...args: any[]) => T;
  /** Suppress no-op writes when `eq(a, b)`. */
  equals?: (a: T, b: T) => boolean;
  /** Declare which fields hold values of other registered struct types
   *  (e.g. `{ x: Num, y: Num }`). Enables full SoA storage. */
  nested?: NestedMap<T>;
  // ── Capabilities ────────────────────────────────────────────────
  /** Vector-space algebra. Auto-lifts `.add(b)` / `.sub(b)` /
   *  `.scale(k)`. Stamps `[ALGEBRA]`. */
  algebra?: VectorSpace<T>;
  /** Linear interpolation. Auto-lifts `.to(target, dur, ease?)` and
   *  `.lerp(b, t)`. Stamps `[LERP]`. Enables `Tweenable` surface. */
  lerp?: (a: T, b: T, t: number) => T;
  /** Distance function. Auto-lifts `.distance(b)`. Stamps `[METRIC]`. */
  metric?: (a: T, b: T) => number;
  // ── Bags ────────────────────────────────────────────────────────
  /** Struct-returning ops. Lifted to derived-cell-returning methods. */
  ops?: Record<string, (self: T, ...args: any[]) => T>;
  /** Scalar-returning ops. Lifted to `ReadonlyCell<R>`-returning methods. */
  scalars?: Record<string, (self: T, ...args: any[]) => unknown>;
  /** Lazy property getters. First read calls, caches on the instance. */
  getters?: Record<string, (this: any) => unknown>;
  /** Free-form methods (`this`-typed). Writable cells only. */
  methods?: Record<string, (this: any, ...args: any[]) => any>;
}

/** Effective ops = user's `ops` bag + capabilities (algebra → add/sub/
 *  scale, lerp → lerp). Mirrors the runtime merge. Pull the inferred
 *  types out of the config object literal — `C extends { algebra: ...
 *  }` fires only when the field is actually present at the type level
 *  (i.e. the user wrote `algebra: {...}` inline). */
type EffectiveOps<T, C> = (C extends { ops: infer O extends Record<string, any> }
  ? O
  : {}) &
  (C extends { algebra: VectorSpace<T> }
    ? { add: (a: T, b: T) => T; sub: (a: T, b: T) => T; scale: (a: T, k: number) => T }
    : {}) &
  (C extends { lerp: (a: T, b: T, t: number) => T }
    ? { lerp: (a: T, b: T, t: number) => T }
    : {});

type EffectiveScalars<T, C> = (C extends {
  scalars: infer X extends Record<string, any>;
}
  ? X
  : {}) &
  (C extends { metric: (a: T, b: T) => number }
    ? { distance: (a: T, b: T) => number }
    : {});

/** Build a `StructType` from a flat config. Alternative to the fluent
 *  `struct(name, defaults).ops({...}).build()` Builder — same runtime,
 *  one function call, capabilities as first-class slots.
 *
 *  The returned `StructType`'s `O` parameter merges the capability
 *  ops (algebra / lerp) into the user's `ops` bag so the cell's type
 *  surface (`.to()`, `.add()`, etc.) lights up. Same for `metric` →
 *  `scalars.distance`.
 *
 *  @example
 *      const Num = defineStruct({
 *        name: "Num",
 *        defaults: 0,
 *        construct: (v: number) => v,
 *        algebra: { add: (a, b) => a + b, sub: (a, b) => a - b, scale: (a, k) => a * k },
 *        lerp:   (a, b, t) => a + (b - a) * t,
 *        metric: (a, b) => Math.abs(a - b),
 *        ops: { clamp: (a, lo: number, hi: number) => a < lo ? lo : a > hi ? hi : a },
 *        scalars: { abs: (a) => Math.abs(a) },
 *      });
 *      // Num.signal(0).to(...), .add(b), .distance(b), .clamp(lo, hi), …
 */
export function defineStruct<
  T,
  const C extends StructConfig<T>,
>(
  config: C & { defaults: T },
): StructType<
  T,
  EffectiveOps<T, C>,
  EffectiveScalars<T, C>,
  C extends { getters: infer G extends Record<string, (this: any) => unknown> } ? G : {},
  C extends { methods: infer M extends Record<string, (this: any, ...args: any[]) => any> } ? M : {},
  C extends { nested: infer N extends NestedMap<T> } ? N : {}
> {
  const state: BuilderState<T> = {
    name: config.name,
    defaults: config.defaults,
    construct: config.construct,
    equals: config.equals,
    nested: config.nested,
    algebra: config.algebra,
    lerp: config.lerp,
    metric: config.metric,
  };
  // Runtime ops bag = user ops + capabilities. Capabilities go FIRST
  // so user's own ops with the same name win.
  const ops: Record<string, (self: T, ...args: any[]) => T> = {};
  if (config.algebra) {
    ops.add = config.algebra.add as any;
    ops.sub = config.algebra.sub as any;
    ops.scale = config.algebra.scale as any;
  }
  if (config.lerp) ops.lerp = config.lerp as any;
  Object.assign(ops, config.ops ?? {});
  return finalize<T>(
    state,
    ops,
    config.scalars ?? {},
    config.getters ?? {},
    config.methods ?? {},
  ) as unknown as StructType<
    T,
    EffectiveOps<T, C>,
    EffectiveScalars<T, C>,
    C extends { getters: infer G extends Record<string, (this: any) => unknown> } ? G : {},
    C extends { methods: infer M extends Record<string, (this: any, ...args: any[]) => any> } ? M : {},
    C extends { nested: infer N extends NestedMap<T> } ? N : {}
  >;
}

// ── registerCapability: stamp a capability slot on an existing struct
//
// For built-in capabilities (`algebra`, `lerp`, `metric`) you usually
// declare them in `defineStruct({...})`. For user-defined capabilities,
// or to add a capability to an existing struct from outside its
// definition file, use this helper.
//
//   const ROTATION_SPACE = Symbol.for("myapp.rotation-space");
//   interface RotationSpace<T> { rotate(v: T, theta: number): T; }
//   registerCapability(Vec, ROTATION_SPACE, {
//     rotate: (v, theta) => ({ ... }),
//   });
//
//   // Library function consuming it:
//   function spin<T>(sig: ReadonlyCell<T>, rate: Val<number>): Animator {
//     const rot = (sig as any)[ROTATION_SPACE] as RotationSpace<T>;
//     if (!rot) throw new Error("spin: cell missing ROTATION_SPACE capability");
//     // ...
//   }

/** Stamp a capability slot on a struct's prototype chain so all of
 *  its `.signal()` / `.derived()` / `.lens()` instances expose it via
 *  `(cell as any)[symbol]`. Works for built-in capabilities and
 *  user-defined ones alike. */
export function registerCapability<T>(
  s: StructType<T, any, any, any, any, any>,
  capability: symbol,
  impl: unknown,
): void {
  // The cell instances chain to per-type prototypes that share the
  // same `[STRUCT]` slot. Walk via a fresh `.signal()` instance —
  // its proto chain is the canonical place to stamp.
  const probe = s.signal(s.defaults as any);
  let proto: object | null = Object.getPrototypeOf(probe);
  while (proto && (proto as any)[STRUCT] !== s) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto) {
    throw new Error(`registerCapability: struct ${s.name} has no [STRUCT] proto`);
  }
  Object.defineProperty(proto, capability, {
    value: impl,
    writable: true,
    configurable: true,
  });
  // Also stamp on the .derived() and .lens() proto chains so the
  // capability is available regardless of flavor.
  const dProbe = s.derived(() => s.defaults as any);
  let dProto: object | null = Object.getPrototypeOf(dProbe);
  while (dProto && (dProto as any)[STRUCT] !== s) {
    dProto = Object.getPrototypeOf(dProto);
  }
  if (dProto) {
    Object.defineProperty(dProto, capability, {
      value: impl,
      writable: true,
      configurable: true,
    });
  }
}
