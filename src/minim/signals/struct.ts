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
  type Easing,
  type Duration,
  type Tween,
} from "../core/signal";
import type { Yieldable, Animator } from "../core/anim";

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
  [K in keyof A]: A[K] | Signal<A[K]> | ReadonlySignal<A[K]> | (() => A[K]);
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

/** When the struct's ops include a `lerp(a, b, t) → S`, the framework
 *  installs a generic `.to(target, dur, ease?)` method on every
 *  *writable* Reactive of that type. Read-only Reactives can't be
 *  tweened — `.to` writes to the signal, which would throw on a
 *  derived. The conditional gates on both `lerp` registered AND `W`
 *  is "rw".
 *
 *  This is the *one* method auto-derived from a struct op, because
 *  the mapping is canonical: `lerp` means "interpolate", `.to` means
 *  "tween toward". For other animation strategies (spring, oscillate,
 *  drift, attract, …), see `signals/integrators.ts` — they're free
 *  functions that take the value type's algebra explicitly. */
type Tweenable<S, O, W extends RW> = W extends "rw"
  ? O extends { lerp: (a: any, b: any, t: number) => S }
    ? { to(target: S, dur: Duration, ease?: Easing): Tween<S> }
    : {}
  : {};

/** A reactive cell carrying a struct value, with field projections and
 *  lifted op methods. Writability flows through fields; ops always
 *  return read-only derived. */
export type Reactive<
  S extends Schema,
  O extends Ops<S> = {},
  X extends Scalars<S> = {},
  W extends RW = "rw",
  M = {},
  G = {},
> =
  & (W extends "rw" ? Signal<S> : ReadonlySignal<S>)
  & Fields<S, W>
  & Methods<S, O, X>
  & Tweenable<S, O, W>
  & (W extends "rw" ? M : {})
  & GetterTypes<G>;

/** Maps a record of getter functions to their return types as
 *  property accessors. `{ center: () => Reactive<V> }` becomes
 *  `{ readonly center: Reactive<V> }`. */
type GetterTypes<G> = {
  readonly [K in keyof G]: G[K] extends (this: any) => infer R ? R : never;
};

// ── StructType ──────────────────────────────────────────────────────

/** A registered struct: factory namespace + identity-as-instanceof-target.
 *
 *  Calling `v instanceof MyStruct` checks whether `v` is a Reactive
 *  produced by this struct (any flavor — signal, derived, or lens).
 *  This works because the framework stamps a hidden `[STRUCT]` marker
 *  on each per-struct prototype at registration. Single property
 *  read + identity comparison; cheaper than a typeof+prototype check. */
export interface StructType<
  S extends Schema,
  O extends Ops<S> = {},
  X extends Scalars<S> = {},
  M = {},
  G = {},
> {
  readonly name: string;
  readonly fields: readonly (keyof S)[];

  signal(v: S): Reactive<S, O, X, "rw", M, G>;
  derived(fn: () => S): Reactive<S, O, X, "ro", M, G>;
  lens(read: () => S, write: (v: S) => void): Reactive<S, O, X, "rw", M, G>;

  /** True if `v` is a Reactive produced by this struct. Equivalent
   *  to `v instanceof StructType` — sugar for cleaner narrowing. */
  is(v: unknown): v is Reactive<S, O, X, "rw" | "ro", M, G>;
  /** True if `v` is a *writable* Reactive produced by this struct
   *  (Vec.signal or Vec.lens results — not Vec.derived). */
  isWritable(v: unknown): v is Reactive<S, O, X, "rw", M, G>;

  /** instanceof support: `v instanceof MyStruct`. */
  [Symbol.hasInstance](v: unknown): boolean;
}

// Internal symbols used by the framework. Exported so integrators in
// other framework files can read the algebra; not part of the public
// user-facing API.
/** @internal Marks each per-struct prototype with the StructType that
 *  owns it. `v[STRUCT] === MyStruct` powers fast `instanceof` checks. */
export const STRUCT = Symbol("minim.struct");
/** @internal Carries the struct's value-type algebra (the registered
 *  ops bag). Integrators read this to find add/sub/scale/lerp/etc.
 *  for the value type, without the user passing it explicitly. */
export const ALGEBRA = Symbol("minim.algebra");
/** @internal Marks a writable per-struct prototype (vs read-only).
 *  Used by `StructType.isWritable`. */
export const WRITABLE = Symbol("minim.writable");

// ── Builder ─────────────────────────────────────────────────────────

interface BuilderState<S extends Schema> {
  name: string;
  defaults: S;
  equals?: (a: S, b: S) => boolean;
  construct?: (...args: any[]) => S;
}

/** Free-form methods a struct can declare via `.methods({...})`.
 *  Each method receives `this` as the writable Reactive — useful for
 *  things like `.set(target)` (returns `this`) and `.bind(target)`
 *  (returns a disposer) that don't fit the ops/scalars contracts.
 *  Installed on every writable per-struct prototype (signal AND lens). */
type MethodsBag<S extends Schema, O extends Ops<S>, X extends Scalars<S>, M_existing> = {
  [name: string]: (this: Reactive<S, O, X, "rw", M_existing>, ...args: any[]) => any;
};

/** Lazy property getters declared via `.getters({...})`. Each getter
 *  receives `this` as the Reactive (any flavor — w/ro/lens). The first
 *  read constructs the value; the framework caches it as an
 *  own-property on the instance, so subsequent reads bypass the getter
 *  entirely (one own-property access).
 *
 *  Use for "anchors" / projections that should look like properties
 *  rather than method calls — `b.center` rather than `b.center()`. */
type GettersBag<S extends Schema, O extends Ops<S>, X extends Scalars<S>, M, G_existing> = {
  [name: string]: (this: Reactive<S, O, X, "rw" | "ro", M, G_existing>) => any;
};

class Builder<
  S extends Schema,
  O extends Ops<S>,
  X extends Scalars<S>,
  M = {},
  G = {},
> {
  constructor(
    private state: BuilderState<S>,
    private opsObj: O,
    private scalarsObj: X,
    private methodsObj: M & Record<string, (...args: any[]) => any> = {} as M & Record<string, (...args: any[]) => any>,
    private gettersObj: G & Record<string, (...args: any[]) => any> = {} as G & Record<string, (...args: any[]) => any>,
  ) {}

  equals(fn: (a: S, b: S) => boolean): Builder<S, O, X, M, G> {
    return new Builder({ ...this.state, equals: fn }, this.opsObj, this.scalarsObj, this.methodsObj, this.gettersObj);
  }

  /** Optional opt-in for fast axis writes.
   *
   *  `construct(a, b, c, ...)` should return a fresh struct value
   *  with the args assigned to fields in declaration order. The
   *  framework derives per-axis writers by calling `construct` with
   *  the new value at the target field's position and the rest read
   *  from the current struct.
   *
   *  Why opt-in: the user's `construct` body uses static-key object
   *  literals, which V8 optimizes far better than the dynamic-key
   *  spread fallback. The framework itself has no knowledge of field
   *  names — it just calls `construct` positionally per arity.
   *
   *  Without `.construct(...)`, axis writes use a generic spread
   *  fallback (~30% slower on tight axis-write loops). For minim's
   *  built-in primitives we always provide it; user-defined structs
   *  can opt in if their writes are hot. */
  construct(fn: (...args: any[]) => S): Builder<S, O, X, M, G> {
    return new Builder({ ...this.state, construct: fn }, this.opsObj, this.scalarsObj, this.methodsObj, this.gettersObj);
  }

  /** Register struct-returning ops. Result type is enforced as `S`. */
  ops<O2 extends Ops<S>>(opsObj: O2): Builder<S, O2, X, M, G> {
    return new Builder(this.state, opsObj, this.scalarsObj, this.methodsObj, this.gettersObj);
  }

  /** Register scalar/primitive-returning ops. Result type is anything-but-S. */
  scalars<X2 extends Scalars<S>>(scalarsObj: X2): Builder<S, O, X2, M, G> {
    return new Builder(this.state, this.opsObj, scalarsObj, this.methodsObj, this.gettersObj);
  }

  /** Register free-form methods on the writable Reactive prototype.
   *  Use for methods that don't fit ops (return type ≠ S) or scalars
   *  (need to mutate `this`, return non-Reactive). Each method's
   *  `this` is typed as the writable Reactive.
   *
   *  Example: Vec uses this for `.set(target)` (returns this) and
   *  `.bind(target)` (returns a disposer). */
  methods<M2 extends MethodsBag<S, O, X, M>>(methodsObj: M2): Builder<S, O, X, M & M2, G> {
    const merged = { ...this.methodsObj, ...methodsObj } as M & M2 & Record<string, (...args: any[]) => any>;
    return new Builder<S, O, X, M & M2, G>(
      this.state,
      this.opsObj,
      this.scalarsObj,
      merged,
      this.gettersObj,
    );
  }

  /** Register lazy property getters on every per-struct prototype.
   *  First read constructs and caches as an own-property; subsequent
   *  reads bypass the getter (own-property fast path).
   *
   *  Use for projections that should read as properties rather than
   *  method calls. Example: AABB uses this for `.center`, `.top`,
   *  `.bottom`, `.left`, `.right` — each returns a `Reactive<V>`
   *  derived from the AABB. */
  getters<G2 extends GettersBag<S, O, X, M, G>>(gettersObj: G2): Builder<S, O, X, M, G & G2> {
    const merged = { ...this.gettersObj, ...gettersObj } as G & G2 & Record<string, (...args: any[]) => any>;
    return new Builder<S, O, X, M, G & G2>(
      this.state,
      this.opsObj,
      this.scalarsObj,
      this.methodsObj,
      merged,
    );
  }

  build(): StructType<S, O, X, M, G> {
    return finalize(this.state, this.opsObj, this.scalarsObj, this.methodsObj, this.gettersObj);
  }
}

export function struct<S extends Schema>(
  name: string,
  defaults: S,
): Builder<S, {}, {}, {}, {}> {
  return new Builder({ name, defaults }, {} as {}, {} as {});
}

/** Extract the schema type from a registered StructType. */
export type Of<T> = T extends StructType<infer S, any, any> ? S : never;

// ── Implementation ──────────────────────────────────────────────────

function finalize<S extends Schema, O extends Ops<S>, X extends Scalars<S>, M, G>(
  state: BuilderState<S>,
  opsObj: O,
  scalarsObj: X,
  methodsObj: M & Record<string, (...args: any[]) => any>,
  gettersObj: G & Record<string, (...args: any[]) => any>,
): StructType<S, O, X, M, G> {
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
  // If the user provided `.construct(fn)`, derive writers from it —
  // each axis writer calls `construct` positionally with the new
  // value at the target field's position. The static-key knowledge
  // lives in the user's `construct` body, not in the framework. The
  // framework only specializes by arity (1, 2, 4, 6, generic).
  //
  // Without `.construct(...)`: spread + computed-key fallback.
  //
  // CSP-safe in both cases: no `eval` / `new Function`.
  const axisWriterFactories = state.construct
    ? makeConstructWriters<S>(fields, state.construct)
    : makeSpreadWriters<S>(fields);

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

  // The one auto-derivation: `lerp` → `.to`. This mapping is canonical
  // (lerp=interpolate, to=tween-toward) so it lives in the framework.
  // Other animation strategies (spring, oscillate, drift, …) are free
  // functions in `_proto/integrators.ts`, written generically over the
  // value type's algebra and called explicitly with that algebra. No
  // coincidence-based "if you have add+sub+scale you also get spring."
  const lerpFn = (opsObj as any).lerp as
    | ((a: S, b: S, t: number) => S)
    | undefined;

  // Forward declaration — the struct value, used as the [STRUCT]
  // marker and as the `Symbol.hasInstance` target. Set after we
  // construct it below; protos reference it via closure.
  let structSelf: StructType<S, O, X, M, G>;

  /** Install the per-struct surface (lazy field accessors + ops +
   *  scalar ops + optional `.to` tween + free-form `.methods()`) onto
   *  a prototype. Called for the writable, readonly, and lens protos.
   *
   *  Also stamps the [STRUCT] / [ALGEBRA] / [WRITABLE] markers so
   *  that `v instanceof MyStruct` works in O(1) and integrators can
   *  read the value-type algebra without the user passing it. */
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
    if (lerpFn && mode === "rw") {
      proto.to = makeTweenMethod(lerpFn);
    }
    if (mode === "rw") {
      // Free-form methods: only on writable prototypes, since the
      // typing makes their `this` writable.
      for (const name of Object.keys(methodsObj)) {
        proto[name] = methodsObj[name];
      }
      proto[WRITABLE] = true;
    }
    // Lazy property getters: install on every per-struct proto. First
    // read constructs the value via the user's function, caches as an
    // own-property (so subsequent reads bypass the getter entirely).
    for (const name of Object.keys(gettersObj)) {
      const fn = gettersObj[name];
      Object.defineProperty(proto, name, {
        configurable: true,
        get(this: any) {
          const val = fn.call(this);
          Object.defineProperty(this, name, {
            value: val,
            writable: false,
            configurable: false,
            enumerable: false,
          });
          return val;
        },
      });
    }
    // Stamp the struct marker + algebra slot. Both are non-enumerable
    // by virtue of being symbol-keyed and defined here just before
    // returning. Define after so they're not enumerated by `for in`.
    Object.defineProperty(proto, STRUCT, {
      value: undefined,
      writable: true,
      configurable: false,
      enumerable: false,
    });
    proto[ALGEBRA] = opsObj;
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

  function makeSignal(v: S): Reactive<S, O, X, "rw", M, G> {
    const inst = Object.create(rwProto);
    Signal.call(inst, v, opts as any);
    return inst as Reactive<S, O, X, "rw", M, G>;
  }

  function makeDerived(fn: () => S): Reactive<S, O, X, "ro", M, G> {
    const inst = Object.create(roProto);
    Computed.call(inst, fn as () => unknown, opts as any);
    return inst as Reactive<S, O, X, "ro", M, G>;
  }
  makeDerivedRef = makeDerived;

  function makeLens(read: () => S, write: (v: S) => void): Reactive<S, O, X, "rw", M, G> {
    const l = lens(read, write) as any;
    Object.setPrototypeOf(l, lensRwProto);
    if (equalsFn) l._equals = equalsFn;
    return l as Reactive<S, O, X, "rw", M, G>;
  }

  // Cheap is/isWritable narrowings.
  const isFn = (v: unknown): v is Reactive<S, O, X, "rw" | "ro", M, G> => {
    return v != null && typeof v === "object" && (v as any)[STRUCT] === structSelf;
  };
  const isWritableFn = (v: unknown): v is Reactive<S, O, X, "rw", M, G> => {
    if (!isFn(v)) return false;
    return (v as any)[WRITABLE] === true;
  };

  structSelf = {
    name: state.name,
    fields,
    signal: makeSignal,
    derived: makeDerived,
    lens: makeLens,
    is: isFn,
    isWritable: isWritableFn,
    [Symbol.hasInstance]: isFn,
  };

  // Backfill the [STRUCT] marker on every per-struct prototype now
  // that we have `structSelf` to point to. The protos were already
  // stamped with the symbol-keyed slot; we set its value here.
  rwProto[STRUCT] = structSelf;
  roProto[STRUCT] = structSelf;
  lensRwProto[STRUCT] = structSelf;

  return structSelf;
}

// ── Generic tween (driven by the struct's lerp op) ─────────────────
//
// One engine works for every value type. The struct provides `lerp`;
// the framework wraps it in a generator that threads dt and writes
// the lerp'd value each frame. Chainable: `sig.to(a, 1).to(b, 1)`.

const defaultEase: Easing = (t) => 1 - (1 - t) * (1 - t); // easeOut

function makeTweenMethod<S>(lerpFn: (a: S, b: S, t: number) => S) {
  return function tweenTo(
    this: Signal<S>,
    target: S,
    dur: Duration,
    ease?: Easing,
  ): Tween<S> {
    return makeTween(this, target, dur, ease ?? defaultEase, lerpFn);
  };
}

function* tweenStep<S>(
  sig: Signal<S>,
  target: S,
  dur: Duration,
  ease: Easing,
  lerp: (a: S, b: S, t: number) => S,
): Animator {
  const start = sig.peek();
  let elapsed = 0;
  while (true) {
    const total = typeof dur === "number" ? dur : dur.value;
    if (elapsed >= total) break;
    const dt: number = yield;
    elapsed += dt;
    const t = total > 0 ? Math.min(elapsed / total, 1) : 1;
    sig.value = lerp(start, target, ease(t));
  }
  sig.value = target;
}

function makeTween<S>(
  sig: Signal<S>,
  target: S,
  dur: Duration,
  ease: Easing,
  lerp: (a: S, b: S, t: number) => S,
  prior?: Generator<Yieldable, void, number>,
): Tween<S> {
  const gen = (function* (): Animator {
    if (prior) yield* prior;
    yield* tweenStep(sig, target, dur, ease, lerp);
  })() as Tween<S>;
  gen.to = (t: S, d: Duration, e?: Easing) =>
    makeTween(sig, t, d, e ?? defaultEase, lerp, gen);
  return gen;
}

// ── Axis writer factories ──────────────────────────────────────────
//
// `axisWriterFactories[field]` is a `(parent) => (v) => void` —
// called once per first axis access to bake in the parent signal,
// returns the setter used by the lens.
//
// Two strategies, both fully generic over field names:
//
//  - `makeConstructWriters`: when the user provides `.construct(fn)`,
//    derive writers by calling `fn` positionally. The user's `fn`
//    body uses static-key literals; the framework just calls it with
//    the new value at the right position. Per-arity specialized so
//    the call is fixed-arity (no spread, no array alloc).
//
//  - `makeSpreadWriters`: fallback when no `.construct` is provided.
//    Uses object spread + computed-key overwrite. ~30% slower on
//    tight axis-write loops but works for any shape.
//
// Neither has hardcoded knowledge of field names — the framework
// stays shape-agnostic.

type AxisWriterFactory<S> = (parent: Signal<S>) => (v: any) => void;

function makeConstructWriters<S extends Schema>(
  fields: readonly (keyof S)[],
  construct: (...args: any[]) => S,
): Record<string, AxisWriterFactory<S>> {
  const writers: Record<string, AxisWriterFactory<S>> = {};
  const fs = fields as readonly string[];
  const arity = fs.length;

  if (arity === 1) {
    writers[fs[0]] = (parent) => (v) => {
      parent.value = construct(v);
    };
    return writers;
  }

  if (arity === 2) {
    const [f0, f1] = fs;
    writers[f0] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(v, c[f1]);
    };
    writers[f1] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(c[f0], v);
    };
    return writers;
  }

  if (arity === 4) {
    const [f0, f1, f2, f3] = fs;
    writers[f0] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(v, c[f1], c[f2], c[f3]);
    };
    writers[f1] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(c[f0], v, c[f2], c[f3]);
    };
    writers[f2] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(c[f0], c[f1], v, c[f3]);
    };
    writers[f3] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(c[f0], c[f1], c[f2], v);
    };
    return writers;
  }

  if (arity === 6) {
    const [f0, f1, f2, f3, f4, f5] = fs;
    writers[f0] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(v, c[f1], c[f2], c[f3], c[f4], c[f5]);
    };
    writers[f1] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(c[f0], v, c[f2], c[f3], c[f4], c[f5]);
    };
    writers[f2] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(c[f0], c[f1], v, c[f3], c[f4], c[f5]);
    };
    writers[f3] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(c[f0], c[f1], c[f2], v, c[f4], c[f5]);
    };
    writers[f4] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(c[f0], c[f1], c[f2], c[f3], v, c[f5]);
    };
    writers[f5] = (parent) => (v) => {
      const c = parent.peek() as any;
      parent.value = construct(c[f0], c[f1], c[f2], c[f3], c[f4], v);
    };
    return writers;
  }

  // Generic per-arity fallback (3, 5, 7+). Uses spread of an args
  // array — slower than the unrolled cases but still calls the
  // user's `construct` with static-key literal inside.
  for (let i = 0; i < fs.length; i++) {
    const fieldIdx = i;
    writers[fs[i]] = (parent) => (v) => {
      const c = parent.peek() as any;
      const args = new Array(arity);
      for (let j = 0; j < arity; j++) {
        args[j] = j === fieldIdx ? v : c[fs[j]];
      }
      parent.value = construct(...args);
    };
  }
  return writers;
}

function makeSpreadWriters<S extends Schema>(
  fields: readonly (keyof S)[],
): Record<string, AxisWriterFactory<S>> {
  const writers: Record<string, AxisWriterFactory<S>> = {};
  for (const field of fields) {
    const f = field;
    writers[String(field)] = (parent) => (v) => {
      parent.value = { ...(parent.peek() as any), [f]: v } as any;
    };
  }
  return writers;
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
      // body so JIT sees the same shape on every evaluation. Three
      // shapes: signal, thunk (function), or literal value.
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
    return function lifted2(this: ReadonlySignal<S>, a: unknown, b: unknown) {
      const self = this;
      const ar = readerFor(a);
      const br = readerFor(b);
      return derived(() => fn(self.value, ar(), br()));
    };
  }

  // Generic fallback for unusual arities (3+). Per-call cost is
  // acceptable here because high-arity ops are rare.
  return function liftedN(this: ReadonlySignal<S>, ...args: unknown[]) {
    const self = this;
    const readers = args.map(readerFor);
    return derived(() => fn(self.value, ...readers.map((r) => r())));
  };
}

/** Return a per-call reader for an arg: signals → `.value`, functions
 *  → call, literals → return as-is. Branches once at construction so
 *  the per-call closure is monomorphic. */
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
      if (typeof a === "function") {
        const fa = a as () => unknown;
        return computed(() => fn(self.value, fa()));
      }
      return computed(() => fn(self.value, a));
    };
  }

  if (arity === 2) {
    return function lifted2(this: ReadonlySignal<S>, a: unknown, b: unknown) {
      const self = this;
      const ar = readerFor(a);
      const br = readerFor(b);
      return computed(() => fn(self.value, ar(), br()));
    };
  }

  return function liftedN(this: ReadonlySignal<S>, ...args: unknown[]) {
    const self = this;
    const readers = args.map(readerFor);
    return computed(() => fn(self.value, ...readers.map((r) => r())));
  };
}
