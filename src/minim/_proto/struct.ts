// Prototype: a `struct(...)` framework that produces `Reactive<T>`
// classes whose runtime shape matches hand-rolled equivalents (Point /
// DerivedPoint), but with one declaration site instead of N classes.
//
// Three performance rules drive the implementation:
//
//  1. No per-call indirection. Lifted methods directly invoke the
//     user's raw op via a closed-over reference — no Reflect, no
//     lookup, no dispatch table. Same call depth as a hand-written
//     method.
//  2. No setPrototypeOf after construction. We instantiate Signal /
//     Computed directly against the per-struct prototypes via
//     constructor.call to avoid V8's hidden-class transition cost.
//  3. Lazy field accessors. `get x()` builds-and-caches the field
//     projection on first access (via own-property install), then the
//     getter is bypassed entirely on subsequent reads. Most
//     intermediates in derived chains never touch `.x`/`.y` and pay
//     zero allocations for them.
//
// Layout: AoS only in this prototype. SoA is a follow-up toggle.

import {
  Signal,
  Computed,
  computed,
  lens,
  type ReadonlySignal,
} from "../core/signal";

// ── Public type surface ─────────────────────────────────────────────

export type Schema = Record<string, number>;
export type RW = "rw" | "ro";

/** Op signature: positional `self`, then domain args. */
export type Op<S, R> = (self: S, ...args: any[]) => R;

/** Lift a struct-returning op into its reactive method form.
 *
 *   add: (a: V, b: V) => V
 *     ⤳ (b: V | Signal<V> | ReadonlySignal<V> | Reactive<V>) => Reactive<V, "ro">
 */
export type LiftStruct<
  F,
  S extends Schema,
  O extends Ops<S>,
  X extends Scalars<S>,
> = F extends (self: any, ...args: infer A) => any
  ? (...args: ReactiveArgs<A>) => Reactive<S, O, X, "ro">
  : never;

/** Lift a scalar-returning op into a `ReadonlySignal<R>` method. */
export type LiftScalar<F> = F extends (
  self: any,
  ...args: infer A
) => infer R
  ? (...args: ReactiveArgs<A>) => ReadonlySignal<R>
  : never;

type ReactiveArgs<A extends readonly unknown[]> = {
  [K in keyof A]: A[K] | Signal<A[K]> | ReadonlySignal<A[K]>;
};

/** Field projections. Writable when parent is writable. */
type Fields<S, W extends RW> = {
  readonly [K in keyof S]: W extends "rw" ? Signal<S[K]> : ReadonlySignal<S[K]>;
};

type Ops<S> = Record<string, (self: S, ...args: any[]) => S>;
type Scalars<S> = Record<string, (self: S, ...args: any[]) => unknown>;

type Methods<S extends Schema, O extends Ops<S>, X extends Scalars<S>> =
  & { [K in keyof O]: LiftStruct<O[K], S, O, X> }
  & { [K in keyof X]: LiftScalar<X[K]> };

/** A reactive cell carrying a struct value, with field projections and
 *  lifted op methods. Writability flows through fields; ops always
 *  return read-only derived. */
export type Reactive<
  S extends Schema,
  O extends Ops<S> = {},
  X extends Scalars<S> = {},
  W extends RW = "rw",
> =
  & (W extends "rw" ? Signal<S> : ReadonlySignal<S>)
  & Fields<S, W>
  & Methods<S, O, X>;

// ── StructType ──────────────────────────────────────────────────────

export interface StructType<
  S extends Schema,
  O extends Ops<S> = {},
  X extends Scalars<S> = {},
> {
  readonly name: string;
  readonly fields: readonly (keyof S)[];

  signal(v: S): Reactive<S, O, X, "rw">;
  derived(fn: () => S): Reactive<S, O, X, "ro">;
  lens(read: () => S, write: (v: S) => void): Reactive<S, O, X, "rw">;
}

// ── Builder ─────────────────────────────────────────────────────────

interface BuilderState<S extends Schema> {
  name: string;
  defaults: S;
  equals?: (a: S, b: S) => boolean;
}

class Builder<S extends Schema, O extends Ops<S>, X extends Scalars<S>> {
  constructor(
    private state: BuilderState<S>,
    private opsObj: O,
    private scalarsObj: X,
  ) {}

  equals(fn: (a: S, b: S) => boolean): Builder<S, O, X> {
    return new Builder({ ...this.state, equals: fn }, this.opsObj, this.scalarsObj);
  }

  /** Register struct-returning ops. Result type is enforced as `S`. */
  ops<O2 extends Ops<S>>(opsObj: O2): Builder<S, O2, X> {
    return new Builder(this.state, opsObj, this.scalarsObj);
  }

  /** Register scalar/primitive-returning ops. Result type is anything-but-S. */
  scalars<X2 extends Scalars<S>>(scalarsObj: X2): Builder<S, O, X2> {
    return new Builder(this.state, this.opsObj, scalarsObj);
  }

  build(): StructType<S, O, X> {
    return finalize(this.state, this.opsObj, this.scalarsObj);
  }
}

export function struct<S extends Schema>(
  name: string,
  defaults: S,
): Builder<S, {}, {}> {
  return new Builder({ name, defaults }, {} as {}, {} as {});
}

/** Extract the schema type from a registered StructType. */
export type Of<T> = T extends StructType<infer S, any, any> ? S : never;

// ── Implementation ──────────────────────────────────────────────────

function finalize<S extends Schema, O extends Ops<S>, X extends Scalars<S>>(
  state: BuilderState<S>,
  opsObj: O,
  scalarsObj: X,
): StructType<S, O, X> {
  const fields = Object.keys(state.defaults) as (keyof S)[];
  const equalsFn = state.equals;

  // Forward declaration — referenced by `liftStruct` closures we
  // install during proto installation, defined further down.
  let makeDerivedRef!: (fn: () => S) => unknown;

  // ── Pre-build descriptors for the lazy field accessors.
  //
  // Writable accessor: builds a Lens that reads/writes the parent's
  // value with the field swapped in. Readonly accessor: builds a
  // Computed that projects the field. Both install themselves as
  // own-properties on first access so subsequent reads bypass the
  // prototype getter entirely.
  // Pre-pick the axis-write strategy per field at struct registration.
  // For common schema shapes ({x,y}, {x,y,w,h}, {a,b,c,d,e,f}) we
  // generate writers that use STATIC keys in their object literals —
  // V8 then emits a fast inline cache for the prop store, matching
  // hand-rolled `{x: v, y: source.peek().y}` performance. For
  // arbitrary schemas we fall back to a spread + computed-key
  // overwrite (still better than the old for-loop, but ~30% slower
  // than the static path on tight axis-write loops).
  //
  // CSP-safe: no `eval` / `new Function`. Just a one-time dispatch.
  const axisWriterFactories = pickAxisWriterFactories<S>(fields);

  const writableFieldGetter = (field: keyof S) => {
    const factory = axisWriterFactories[field as string];
    return function (this: Signal<S>) {
      const setter = factory(this);
      const projection = lens(() => (this.value as any)[field], setter);
      Object.defineProperty(this, field as PropertyKey, {
        value: projection,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      return projection;
    };
  };

  const readonlyFieldGetter = (field: keyof S) => {
    return function (this: ReadonlySignal<S>) {
      const projection = computed(() => (this.value as any)[field]);
      Object.defineProperty(this, field as PropertyKey, {
        value: projection,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      return projection;
    };
  };

  /** Install the per-struct surface (lazy field accessors + ops +
   *  scalar ops) onto a prototype. Called once each for the writable
   *  prototype, the readonly prototype, and the lens prototype. */
  const installSurface = (proto: any, mode: "rw" | "ro") => {
    const fieldGetter = mode === "rw" ? writableFieldGetter : readonlyFieldGetter;
    for (const field of fields) {
      Object.defineProperty(proto, field as PropertyKey, {
        configurable: true,
        get: fieldGetter(field),
      });
    }
    for (const opName of Object.keys(opsObj)) {
      proto[opName] = liftStruct(opsObj[opName], (fn) => makeDerivedRef(fn));
    }
    for (const opName of Object.keys(scalarsObj)) {
      proto[opName] = liftScalar(scalarsObj[opName]);
    }
  };

  // ── Two top-level prototypes. Both have the surface installed.
  const rwProto = Object.create(Signal.prototype);
  const roProto = Object.create(Computed.prototype);
  installSurface(rwProto, "rw");
  installSurface(roProto, "ro");

  // ── Lens prototype. We can't reference Lens's class directly (it's
  // not exported from signal.ts), so we sample its prototype via a
  // probe. The lens-flavored Reactive uses this as its proto chain:
  //
  //   instance → lensRwProto → Lens.prototype → Computed.prototype → Signal.prototype
  //
  // `lensRwProto` carries our field accessors + op methods. The
  // value getter+setter on Lens.prototype provides lens read/write
  // semantics. One setPrototypeOf per lens construction (not per-call).
  const lensProbe = lens<S>(() => state.defaults, () => {});
  const lensInstanceProto = Object.getPrototypeOf(lensProbe);
  const lensRwProto = Object.create(lensInstanceProto);
  installSurface(lensRwProto, "rw");

  // ── Constructors. Instantiate against per-struct prototypes via
  // Object.create + constructor.call — no Object.setPrototypeOf after
  // construction (which forces a hidden-class transition in V8).
  const opts = equalsFn
    ? { equals: equalsFn, name: state.name }
    : { name: state.name };

  function makeSignal(v: S): Reactive<S, O, X, "rw"> {
    const inst = Object.create(rwProto);
    Signal.call(inst, v, opts as any);
    return inst as Reactive<S, O, X, "rw">;
  }

  function makeDerived(fn: () => S): Reactive<S, O, X, "ro"> {
    const inst = Object.create(roProto);
    Computed.call(inst, fn as () => unknown, opts as any);
    return inst as Reactive<S, O, X, "ro">;
  }
  makeDerivedRef = makeDerived;

  function makeLens(read: () => S, write: (v: S) => void): Reactive<S, O, X, "rw"> {
    const l = lens(read, write) as any;
    Object.setPrototypeOf(l, lensRwProto);
    if (equalsFn) l._equals = equalsFn;
    return l as Reactive<S, O, X, "rw">;
  }

  return {
    name: state.name,
    fields,
    signal: makeSignal,
    derived: makeDerived,
    lens: makeLens,
  };
}

// ── Axis writer specialization ──────────────────────────────────────
//
// Returns a record `{ [fieldName]: factory }` where each factory is
// `(parent: Signal<S>) => (v) => void` — call it with the parent
// signal at lens construction time, get back a setter.
//
// For common schemas the setter body uses static-key object literals
// (matches hand-rolled legacy speed). For others, a generic spread
// fallback. Picked once per (struct, field) pair at registration.

type AxisWriterFactory<S> = (parent: Signal<S>) => (v: any) => void;

function pickAxisWriterFactories<S extends Schema>(
  fields: readonly (keyof S)[],
): Record<string, AxisWriterFactory<S>> {
  const factories: Record<string, AxisWriterFactory<S>> = {};
  const fs = fields as readonly string[];
  const len = fs.length;

  // Detect known shapes once; per-field switch within.
  const isXY = len === 2 && fs[0] === "x" && fs[1] === "y";
  const isXYWH =
    len === 4 &&
    fs[0] === "x" && fs[1] === "y" && fs[2] === "w" && fs[3] === "h";
  const isABCDEF =
    len === 6 &&
    fs[0] === "a" && fs[1] === "b" && fs[2] === "c" &&
    fs[3] === "d" && fs[4] === "e" && fs[5] === "f";

  for (const field of fs) {
    factories[field] = makeFactory<S>(field, fs, { isXY, isXYWH, isABCDEF });
  }
  return factories;
}

function makeFactory<S extends Schema>(
  field: string,
  _fields: readonly string[],
  shape: { isXY: boolean; isXYWH: boolean; isABCDEF: boolean },
): AxisWriterFactory<S> {
  // Each branch returns a factory that closes over `parent` and uses
  // STATIC keys in its object literal.
  if (shape.isXY) {
    if (field === "x") {
      return (parent) => (v) => {
        parent.value = { x: v, y: (parent.peek() as any).y } as any;
      };
    }
    return (parent) => (v) => {
      parent.value = { x: (parent.peek() as any).x, y: v } as any;
    };
  }

  if (shape.isXYWH) {
    if (field === "x") {
      return (parent) => (v) => {
        const c = parent.peek() as any;
        parent.value = { x: v, y: c.y, w: c.w, h: c.h } as any;
      };
    }
    if (field === "y") {
      return (parent) => (v) => {
        const c = parent.peek() as any;
        parent.value = { x: c.x, y: v, w: c.w, h: c.h } as any;
      };
    }
    if (field === "w") {
      return (parent) => (v) => {
        const c = parent.peek() as any;
        parent.value = { x: c.x, y: c.y, w: v, h: c.h } as any;
      };
    }
    return (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = { x: c.x, y: c.y, w: c.w, h: v } as any;
    };
  }

  if (shape.isABCDEF) {
    if (field === "a") {
      return (parent) => (v) => {
        const c = parent.peek() as any;
        parent.value = { a: v, b: c.b, c: c.c, d: c.d, e: c.e, f: c.f } as any;
      };
    }
    if (field === "b") {
      return (parent) => (v) => {
        const c = parent.peek() as any;
        parent.value = { a: c.a, b: v, c: c.c, d: c.d, e: c.e, f: c.f } as any;
      };
    }
    if (field === "c") {
      return (parent) => (v) => {
        const c = parent.peek() as any;
        parent.value = { a: c.a, b: c.b, c: v, d: c.d, e: c.e, f: c.f } as any;
      };
    }
    if (field === "d") {
      return (parent) => (v) => {
        const c = parent.peek() as any;
        parent.value = { a: c.a, b: c.b, c: c.c, d: v, e: c.e, f: c.f } as any;
      };
    }
    if (field === "e") {
      return (parent) => (v) => {
        const c = parent.peek() as any;
        parent.value = { a: c.a, b: c.b, c: c.c, d: c.d, e: v, f: c.f } as any;
      };
    }
    return (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = { a: c.a, b: c.b, c: c.c, d: c.d, e: c.e, f: v } as any;
    };
  }

  // Generic fallback: spread + computed-key overwrite.
  return (parent) => (v) => {
    parent.value = { ...(parent.peek() as any), [field]: v } as any;
  };
}

/** Specialized struct-op lifter, dispatched by arity at registration.
 *
 *  `fn.length - 1` is the non-self arity. We install a closure with
 *  matching named parameters — no rest-args, no `arguments` object,
 *  no per-call `args.length` branching. The arity-1 case (the most
 *  common: `add`, `sub`, `scale`, `lerp` with a captured t) further
 *  specializes on whether the arg is a Signal at construction time,
 *  so the closure body has no per-eval branch either. */
function liftStruct<S extends Schema>(
  fn: (self: S, ...args: any[]) => S,
  derived: (fn: () => S) => unknown,
) {
  const arity = Math.max(0, fn.length - 1);

  if (arity === 0) {
    return function lifted0(this: ReadonlySignal<S>) {
      const self = this;
      return derived(() => fn(self.value));
    };
  }

  if (arity === 1) {
    return function lifted1(this: ReadonlySignal<S>, a: unknown) {
      const self = this;
      // Branch once at construction: produce a monomorphic closure
      // body so JIT sees the same shape on every evaluation.
      if (a instanceof Signal) {
        const sa = a as Signal<unknown>;
        return derived(() => fn(self.value, sa.value));
      }
      return derived(() => fn(self.value, a));
    };
  }

  if (arity === 2) {
    return function lifted2(this: ReadonlySignal<S>, a: unknown, b: unknown) {
      const self = this;
      const aSig = a instanceof Signal;
      const bSig = b instanceof Signal;
      const sa = aSig ? (a as Signal<unknown>) : null;
      const sb = bSig ? (b as Signal<unknown>) : null;
      // Four monomorphic shapes. JIT specialises each.
      if (sa && sb) return derived(() => fn(self.value, sa.value, sb.value));
      if (sa) return derived(() => fn(self.value, sa.value, b));
      if (sb) return derived(() => fn(self.value, a, sb.value));
      return derived(() => fn(self.value, a, b));
    };
  }

  // Generic fallback for unusual arities. Per-call cost is acceptable
  // here because high-arity ops are rare.
  return function liftedN(this: ReadonlySignal<S>, ...args: unknown[]) {
    const self = this;
    const sigFlags = args.map((a) => a instanceof Signal);
    return derived(() =>
      fn(
        self.value,
        ...args.map((a, i) => (sigFlags[i] ? (a as Signal<unknown>).value : a)),
      ),
    );
  };
}

/** Same shape as liftStruct but with `computed()` as the wrapper, so
 *  scalar results land as a plain `ReadonlySignal<R>`. */
function liftScalar<S>(fn: (self: S, ...args: any[]) => unknown) {
  const arity = Math.max(0, fn.length - 1);

  if (arity === 0) {
    return function lifted0(this: ReadonlySignal<S>) {
      const self = this;
      return computed(() => fn(self.value));
    };
  }

  if (arity === 1) {
    return function lifted1(this: ReadonlySignal<S>, a: unknown) {
      const self = this;
      if (a instanceof Signal) {
        const sa = a as Signal<unknown>;
        return computed(() => fn(self.value, sa.value));
      }
      return computed(() => fn(self.value, a));
    };
  }

  if (arity === 2) {
    return function lifted2(this: ReadonlySignal<S>, a: unknown, b: unknown) {
      const self = this;
      const aSig = a instanceof Signal;
      const bSig = b instanceof Signal;
      const sa = aSig ? (a as Signal<unknown>) : null;
      const sb = bSig ? (b as Signal<unknown>) : null;
      if (sa && sb) return computed(() => fn(self.value, sa.value, sb.value));
      if (sa) return computed(() => fn(self.value, sa.value, b));
      if (sb) return computed(() => fn(self.value, a, sb.value));
      return computed(() => fn(self.value, a, b));
    };
  }

  return function liftedN(this: ReadonlySignal<S>, ...args: unknown[]) {
    const self = this;
    const sigFlags = args.map((a) => a instanceof Signal);
    return computed(() =>
      fn(
        self.value,
        ...args.map((a, i) => (sigFlags[i] ? (a as Signal<unknown>).value : a)),
      ),
    );
  };
}
