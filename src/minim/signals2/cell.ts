// ── minim signals2 — Cell + Type ─────────────────────────────────────
//
// Design rules:
//
//   • One reactive primitive: Cell<T>. It's a callable function.
//     `v()` reads, `v(x)` writes. No `.value` getter — call IS read.
//
//   • One config shape: Type<T>. Plain JS object. Capabilities are
//     direct properties (`Vec.lerp`, `Vec.linear`, `Vec.metric`); no
//     `[ALGEBRA]` symbols, no `defineStruct` ceremony.
//
//   • Capabilities propagate through `nested`. Transform declares NO
//     linear/lerp/metric of its own; the runtime walks `nested:` and
//     synthesises composite operations. The type-level `EffectivelyHas`
//     predicate recursively checks the same path, so Transform's
//     `.lerp()`, `.add()`, `.distance()` are typed without casts.
//
//   • `Val<T> = T | (() => T)`. Cells ARE callables, so a cell is
//     already `() => T` and slots into Val<T> with no special case.
//
//   • Storage (SoA vs AoS) is a runtime hint, not a type-level field.
//     `struct({...})` declares a default; callers override per-use:
//     `Transform(initial, { storage: "soa" })`.

import {
  signal,
  computed,
  effect,
  setActiveSub,
  isSignal,
  startBatch,
  endBatch,
  type SignalFn,
} from "./engine";

// ── Public types ────────────────────────────────────────────────────

/** Core writable-cell shape — call to read, call with arg to write,
 *  peek for untracked, type for capability dispatch. */
export interface CellBase<T, C = unknown> extends SignalFn<T> {
  /** Untracked read — doesn't subscribe the current effect. */
  peek(): T;
  /** The Type this cell is attached to (or undefined for bare cells). */
  readonly type?: Type<T, C>;
}

/** A writable reactive value. Generic over the source config `C` so
 *  methods, getters, fields, and capability surface are all inferred
 *  from the original `struct({...})` literal. */
export type Cell<T, C = unknown> =
  CellBase<T, C> &
  MethodSurface<T, C> &
  GetterSurface<C> &
  CapabilitySurface<T, C> &
  FieldSurface<T>;

/** Read-only writable-shape — same call/peek/type but no writer. */
export interface ROBase<T, C = unknown> {
  (): T;
  peek(): T;
  readonly type?: Type<T, C>;
  readonly __t?: T;
}

export type RO<T, C = unknown> =
  ROBase<T, C> &
  MethodSurface<T, C> &
  GetterSurface<C> &
  CapabilitySurface<T, C> &
  FieldSurface<T>;

/** Anywhere a value-or-source is accepted: literal or thunk. Because
 *  Cell<T> is `() => T`, cells satisfy `(() => T)` with no special case. */
export type Val<T> = T | (() => T);

/** Linear (vector-space-over-real-numbers) algebra: an additive group
 *  with a scalar action. Required by `mean`, `spring`, `oscillate`,
 *  and the cell's `.add()`, `.sub()`, `.scale()` methods.
 *
 *  Named `Linear` rather than the older `Algebra` because the precise
 *  structure is "vector space over ℝ" — not arbitrary algebra. */
export interface Linear<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}

/** Storage strategy:
 *
 *   - "aos" (default): one signal per cell, fields are lazy lens-style
 *     projections. Cheap construction, low memory, coarse invalidation.
 *
 *   - "soa": one signal per declared field, parent is a fan-in/fan-out
 *     callable. Pays for construction (~5x); wins on per-field write
 *     subscriber isolation. Use when individual fields are written
 *     independently and have different subscriber sets. */
export type Storage = "aos" | "soa";

/** A typed-field spec carrying a Type + an explicit initial value.
 *  Produced by `SomeType.with(init)` for use inside `defaults: {...}`:
 *
 *      defaults: {
 *        translate: Vec,                     // typed, init = Vec.defaults
 *        scale: Vec.with({ x: 1, y: 1 }),    // typed, init overridden
 *        opacity: Num.with(1),               // typed, init = 1 (not Num.defaults=0)
 *      }
 *
 *  Branded so the runtime can distinguish a `Type.with(...)` result
 *  from a literal record that happens to have `type` and `init` keys.
 *  Generic in `C` so the original type's config is preserved for
 *  composite-capability inference. */
export interface FieldSpec<T, C = unknown> {
  readonly __field: true;
  readonly type: Type<T, C>;
  readonly init: T;
}

// ── Reserved names — runtime guard ──────────────────────────────────

/** Function-prototype intrinsics + framework keys that user `methods`
 *  / `getters` MUST NOT clash with. Checked at `struct({...})` time. */
export const RESERVED_NAMES = new Set<string>([
  "length", "name", "caller", "arguments", "prototype",
  "bind", "call", "apply", "toString",
  "type", "peek",
]);

// ── Type<T, C>: the single Type interface ──────────────────────────
//
// User passes the config-shaped subset (via `struct({...})`); the
// framework adds the factory methods + capability copies + `is` guard.
// One interface, no separate TypeConfig vs Type duplication.

export interface Type<T, C = unknown> {
  // ── User-supplied config ─────────────────────────────────────
  readonly name?: string;
  // `defaults` is loosely typed because it accepts BOTH the plain T
  // value (legacy) AND a record where each entry may be a Type or
  // FieldSpec (new style). The runtime `walkDefaults` resolves either
  // shape to a concrete T. Type-level ExtractT<C> handles the union
  // for inference purposes; the constraint here just stays open.
  readonly defaults: any;
  readonly equals?: (a: T, b: T) => boolean;
  readonly lerp?: (a: T, b: T, t: number) => T;
  readonly linear?: Linear<T>;
  readonly metric?: (a: T, b: T) => number;
  readonly nested?: { [K in keyof T]?: Type<T[K], any> };
  readonly storage?: Storage;
  readonly methods?: Record<string, (self: T, ...args: any[]) => any>;
  readonly getters?: Record<string, (this: any) => any>;

  // ── Framework-added (after `struct(cfg)`) ─────────────────────
  /** Callable as factory: `Vec({x:1, y:2})` === `Vec.cell({x:1, y:2})`. */
  (this: void, initial: T, opts?: { storage?: Storage }): Cell<T, C>;

  /** Build a writable cell. */
  cell(initial: T, opts?: { storage?: Storage }): Cell<T, C>;
  /** Build a read-only cell from a getter. */
  derived(fn: () => T): RO<T, C>;
  /** Build a writable lens — reads via `r`, writes via `w`. */
  lens(read: () => T, write: (v: T) => void): Cell<T, C>;
  /** Type guard: any flavor of this type's cell. */
  is(v: unknown): v is Cell<T, C> | RO<T, C>;

  /** Build a `FieldSpec<T, C>` for use inside another struct's
   *  `defaults`:
   *      defaults: { scale: Vec.with({ x: 1, y: 1 }) }
   *  Equivalent to `{ __field: true, type: this, init }`. Preserves
   *  `C` so composite-capability inference can still walk the typed
   *  field's config. */
  with(init: T): FieldSpec<T, C>;

  // Plain math, copied from `linear` if present.
  add: Linear<T>["add"] | undefined;
  sub: Linear<T>["sub"] | undefined;
  scale: Linear<T>["scale"] | undefined;
}

/** What the user passes to `struct()`.
 *
 *  Defined as a standalone interface (NOT `Omit<Type<T>, ...>`) because
 *  Omit preserves call signatures and would make StructInput itself
 *  callable. Plain config objects aren't callable, so the constraint
 *  would never match. */
export interface StructInput<T> {
  readonly name?: string;
  readonly defaults: any;
  readonly equals?: (a: T, b: T) => boolean;
  readonly lerp?: (a: T, b: T, t: number) => T;
  readonly linear?: Linear<T>;
  readonly metric?: (a: T, b: T) => number;
  readonly nested?: { [K in keyof T]?: Type<T[K], any> };
  readonly storage?: Storage;
  readonly methods?: Record<string, (self: T, ...args: any[]) => any>;
  readonly getters?: Record<string, (this: any) => any>;
}

// ── Composite capability detection (type level) ─────────────────────
//
// A type effectively has capability K iff:
//   (a) It directly declares K on its config, OR
//   (b) Its `defaults` entries are all Types/FieldSpecs that recursively
//       have K (new style), OR
//   (c) It has a `nested:` map and all children have K (legacy style).
//
// "Directly declares K" uses `K extends keyof C` so optional fields
// count. Depth growth is in a boolean, stays well under TS's
// instantiation limit. Validated in `_inference_check.ts`.

type EffectivelyHas<K extends string, C> =
  K extends keyof C
    ? Exclude<C[K extends keyof C ? K : never], undefined> extends never
      ? false
      : true
    : C extends { nested: infer N }
      ? AllChildrenHave<K, N>
      : C extends { defaults: infer D }
        ? AllDefaultEntriesHave<K, D>
        : false;

type AllChildrenHave<K extends string, N> =
  keyof N extends never
    ? false
    : { [F in keyof N]: EffectivelyHas<K, N[F]> }[keyof N] extends true
      ? true
      : false;

/** Walk a defaults map: for each entry that is a Type or FieldSpec,
 *  check the underlying config for K. Non-Type entries (primitives)
 *  count as `false` — i.e. a defaults map containing any plain field
 *  cannot compose K. (A pure primitive default is fine — handled by
 *  `K extends keyof C` returning false, then `defaults: infer D`
 *  matches a non-object D, falling through.) */
type AllDefaultEntriesHave<K extends string, D> =
  D extends object
    ? D extends Function ? false
    : D extends readonly unknown[] ? false
    : keyof D extends never ? false
    : { [F in keyof D]: DefaultEntryHas<K, D[F]> }[keyof D] extends true
      ? true
      : false
    : false;

type DefaultEntryHas<K extends string, F> =
  F extends Type<any, infer SubC> ? EffectivelyHas<K, SubC>
  : F extends FieldSpec<any, infer SubC> ? EffectivelyHas<K, SubC>
  : false;

// ── Surface mixins ──────────────────────────────────────────────────

/** From `methods: { foo: (self, ...args) => R }`, derive
 *  `{ foo: (...args) => RO<R> }`. */
type MethodSurface<T, C> = C extends { methods: infer M }
  ? {
      [K in keyof M]: M[K] extends (self: T, ...args: infer A) => infer R
        ? (...args: A) => RO<R>
        : never;
    }
  : {};

/** From `getters: { foo(): R }`, derive `{ readonly foo: R }`. */
type GetterSurface<C> = C extends { getters: infer G }
  ? { readonly [K in keyof G]: G[K] extends (this: any) => infer R ? R : never }
  : {};

/** All capability-derived methods in one place. Each branch uses
 *  `EffectivelyHas` so composite types (Transform) get the surface
 *  even though they don't declare the capability directly. */
type CapabilitySurface<T, C> =
  (EffectivelyHas<"linear", C> extends true
    ? { add(b: Val<T>): RO<T>; sub(b: Val<T>): RO<T>; scale(k: Val<number>): RO<T> }
    : {})
  & (EffectivelyHas<"lerp", C> extends true
    ? { lerp(target: Val<T>, t: Val<number>): RO<T> }
    : {})
  & (EffectivelyHas<"metric", C> extends true
    ? { distance(b: Val<T>): RO<number> }
    : {});

/** Per-field projection. Each declared field of `T` gets a CellBase.
 *  Bare CellBase (no `C` inference) keeps the surface from blowing up
 *  through nested types; for the nested-type-typed surface, cast: e.g.
 *  `tr.translate as Cell<Vec, typeof Vec>`. */
type FieldSurface<T> = T extends object
  ? T extends Function
    ? {}
    : { readonly [K in keyof T]: CellBase<T[K], StructInput<T[K]>> }
  : {};

// ── Composite capability synthesis (runtime) ────────────────────────
//
// Mirror of the type-level predicate. Walk `nested`, ask each field's
// type for the capability, build the per-field reduction.

function compositeEquals<T>(t: StructInput<T>): (a: T, b: T) => boolean {
  if (t.equals) return t.equals;
  if (typeof t.defaults !== "object" || t.defaults === null) {
    return (a, b) => a === b;
  }
  const keys = Object.keys(t.defaults as object);
  const nested = t.nested ?? {};
  const subs: Record<string, (a: any, b: any) => boolean> = {};
  for (const k of keys) {
    const sub = (nested as any)[k];
    subs[k] = sub ? compositeEquals(sub) : (a, b) => a === b;
  }
  return (a, b) => {
    for (const k of keys) if (!subs[k]((a as any)[k], (b as any)[k])) return false;
    return true;
  };
}

/** Is `t.nested` populated enough to attempt composition? Empty `{}`
 *  (e.g. when defaults entries are all primitives) means "no typed
 *  children, can't compose." */
function hasNestedTypes<T>(t: StructInput<T>): boolean {
  return !!t.nested && Object.keys(t.nested).length > 0;
}

function compositeLerp<T>(t: StructInput<T>): ((a: T, b: T, t: number) => T) | undefined {
  if (t.lerp) return t.lerp;
  if (typeof t.defaults !== "object" || !hasNestedTypes(t)) return undefined;
  const keys = Object.keys(t.nested as object);
  const subs: Record<string, (a: any, b: any, t: number) => any> = {};
  for (const k of keys) {
    const f = compositeLerp((t.nested as any)[k]);
    if (!f) return undefined;
    subs[k] = f;
  }
  return (a, b, alpha) => {
    const out: any = { ...(a as any) };  // preserve untyped fields
    for (const k of keys) out[k] = subs[k]((a as any)[k], (b as any)[k], alpha);
    return out as T;
  };
}

function compositeLinear<T>(t: StructInput<T>): Linear<T> | undefined {
  if (t.linear) return t.linear;
  if (typeof t.defaults !== "object" || !hasNestedTypes(t)) return undefined;
  const keys = Object.keys(t.nested as object);
  const adds: Record<string, any> = {};
  const subs: Record<string, any> = {};
  const scales: Record<string, any> = {};
  for (const k of keys) {
    const a = compositeLinear((t.nested as any)[k]);
    if (!a) return undefined;
    adds[k] = a.add; subs[k] = a.sub; scales[k] = a.scale;
  }
  return {
    add:   (a, b) => { const o: any = { ...(a as any) }; for (const k of keys) o[k] = adds[k]((a as any)[k], (b as any)[k]); return o; },
    sub:   (a, b) => { const o: any = { ...(a as any) }; for (const k of keys) o[k] = subs[k]((a as any)[k], (b as any)[k]); return o; },
    scale: (a, k) => { const o: any = { ...(a as any) }; for (const kk of keys) o[kk] = scales[kk]((a as any)[kk], k); return o; },
  };
}

function compositeMetric<T>(t: StructInput<T>): ((a: T, b: T) => number) | undefined {
  if (t.metric) return t.metric;
  if (typeof t.defaults !== "object" || !hasNestedTypes(t)) return undefined;
  const keys = Object.keys(t.nested as object);
  const subs: Record<string, (a: any, b: any) => number> = {};
  for (const k of keys) {
    const m = compositeMetric((t.nested as any)[k]);
    if (!m) return undefined;
    subs[k] = m;
  }
  return (a, b) => {
    let s = 0;
    for (const k of keys) {
      const d = subs[k]((a as any)[k], (b as any)[k]);
      s += d * d;
    }
    return Math.sqrt(s);
  };
}

// ── Prototype installation — split into focused helpers ────────────

const TYPE = Symbol("type");

const protoCache = new WeakMap<StructInput<any>, { rw: any; ro: any; soa: any }>();

/** Build a per-type prototype (rw or ro flavor). Orchestrator over
 *  the install* helpers; each helper does one thing. */
function makeProto<T>(type: Type<T>, writable: boolean): any {
  const proto = Object.create(Function.prototype);
  installBase(proto, type);
  installCapabilityMethods(proto, type);
  installUserMethods(proto, type);
  installUserGetters(proto, type);
  installFieldGetters(proto, type, writable);
  return proto;
}

/** `peek()`, `.type`, and the framework-internal type tag. */
function installBase<T>(proto: any, type: Type<T>): void {
  Object.defineProperty(proto, "peek", {
    configurable: true, writable: true,
    value(this: SignalFn<T>) {
      const prev = setActiveSub(undefined);
      try { return (this as () => T)(); }
      finally { setActiveSub(prev); }
    },
  });
  Object.defineProperty(proto, "type", { value: type, configurable: true });
  proto[TYPE] = type;
}

/** Capability-derived methods: `.add`, `.sub`, `.scale` from `linear`;
 *  `.lerp` from `lerp`; `.distance` from `metric`. Reads `Type<T>`'s
 *  effective (possibly composite-synthesised) capabilities. */
function installCapabilityMethods<T>(proto: any, type: Type<T>): void {
  if (type.lerp) {
    const fn = type.lerp;
    proto.lerp = function (this: () => T, target: Val<T>, t: Val<number>) {
      const self = this;
      return wrap(computed(() => fn(self(), valOf(target), valOf(t) as number)), type, false);
    };
  }
  if (type.linear) {
    const a = type.linear;
    proto.add = function (this: () => T, b: Val<T>) {
      const self = this;
      return wrap(computed(() => a.add(self(), valOf(b))), type, false);
    };
    proto.sub = function (this: () => T, b: Val<T>) {
      const self = this;
      return wrap(computed(() => a.sub(self(), valOf(b))), type, false);
    };
    proto.scale = function (this: () => T, k: Val<number>) {
      const self = this;
      return wrap(computed(() => a.scale(self(), valOf(k) as number)), type, false);
    };
  }
  if (type.metric) {
    const d = type.metric;
    proto.distance = function (this: () => T, b: Val<T>) {
      const self = this;
      return computed(() => d(self(), valOf(b)));
    };
  }
}

/** User-defined methods (the `methods: {...}` bag). Each is lifted:
 *  args are flattened via `valOf` (so cells/thunks/literals all work),
 *  result is wrapped in a derived cell. */
function installUserMethods<T>(proto: any, type: Type<T>): void {
  if (!type.methods) return;
  for (const name of Object.keys(type.methods)) {
    const m = type.methods[name];
    proto[name] = function (this: () => T, ...args: any[]) {
      const self = this;
      return computed(() => m(self(), ...args.map(valOf)));
    };
  }
}

/** User-defined lazy getters (the `getters: {...}` bag). First read
 *  calls the function and caches the result as an own-property. */
function installUserGetters<T>(proto: any, type: Type<T>): void {
  if (!type.getters) return;
  for (const name of Object.keys(type.getters)) {
    const g = type.getters[name];
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: any) {
        const v = g.call(this);
        Object.defineProperty(this, name, { value: v });
        return v;
      },
    });
  }
}

/** Per-field projections (`v.x`, `tr.translate`, etc). Built lazily
 *  on first access, cached as own-property. For AoS storage these are
 *  lens-callables; for SoA they're own-prop signals installed at
 *  cell construction. */
function installFieldGetters<T>(proto: any, type: Type<T>, writable: boolean): void {
  if (typeof type.defaults !== "object" || type.defaults === null) return;
  const nested = type.nested ?? {};
  for (const k of Object.keys(type.defaults as object)) {
    const childType = (nested as any)[k];
    Object.defineProperty(proto, k, {
      configurable: true,
      get(this: any) {
        const self = this;
        let field: any;
        if (writable) {
          const reader = computed(() => (self() as any)[k]);
          field = function (...args: any[]) {
            if (args.length === 0) return reader();
            const cur = peekValue(self) as any;
            self({ ...cur, [k]: args[0] });
          };
        } else {
          field = computed(() => (self() as any)[k]);
        }
        if (childType) Object.setPrototypeOf(field, protosFor(childType).rw);
        Object.defineProperty(self, k, { value: field, configurable: false });
        return field;
      },
    });
  }
}

/** SoA flavor: per-field signals are eagerly installed as own-props at
 *  construction (in `makeSoaCell`). The proto just chains off the rw
 *  proto so methods are visible, and overrides axes-default behaviour
 *  (it doesn't install lazy fields). */
function makeSoaProto<T>(type: Type<T>): any {
  const rwProto = protosFor(type as any).rw;
  return Object.create(rwProto);
}

function protosFor<T>(type: StructInput<T>): { rw: any; ro: any; soa: any } {
  const cached = protoCache.get(type);
  if (cached) return cached;
  const fullType = type as Type<T>;
  // Insert before computing — makeSoaProto calls back via protosFor.
  const slot: any = { rw: null, ro: null, soa: null };
  protoCache.set(type, slot);
  slot.rw = makeProto(fullType, true);
  slot.ro = makeProto(fullType, false);
  slot.soa = makeSoaProto(fullType);
  return slot;
}

function wrap<T>(fn: SignalFn<T>, type: StructInput<T>, writable: boolean): SignalFn<T> {
  const slot = protosFor(type);
  Object.setPrototypeOf(fn, writable ? slot.rw : slot.ro);
  return fn;
}

function peekValue<T>(fn: () => T): T {
  const prev = setActiveSub(undefined);
  try { return fn(); }
  finally { setActiveSub(prev); }
}

/** Unwrap a `Val<T>` to a `T`. Callables (cells/thunks) are invoked;
 *  literals returned as-is. The universal "give me the current value"
 *  helper used inside lifted methods. */
export function valOf<T>(v: Val<T>): T {
  return typeof v === "function" ? (v as () => T)() : v;
}

/** Is `v` a Type (callable + has .defaults + .cell factory)? Avoids
 *  the more expensive `isSignal` lookup. */
function isType(v: unknown): v is Type<any, any> {
  return typeof v === "function"
    && (v as any).cell !== undefined
    && (v as any).defaults !== undefined;
}

/** Is `v` a FieldSpec produced by `SomeType.with(init)`? Brand check. */
function isFieldSpec(v: unknown): v is FieldSpec<any> {
  return typeof v === "object" && v !== null
    && (v as any).__field === true;
}

/** Walk a `defaults` value. For object-shaped defaults, replace each
 *  entry that is a Type or FieldSpec with its plain default value, and
 *  build the corresponding nested-type map. Primitive entries are
 *  passed through.
 *
 *  Returns the resolved value-shape + the synthesised nested map. */
function walkDefaults(defaults: unknown): {
  values: any;
  nested: Record<string, Type<any, any>>;
} {
  // Primitive default — just return it; no fields, no nested.
  if (typeof defaults !== "object" || defaults === null) {
    return { values: defaults, nested: {} };
  }
  // Object default — walk each entry.
  const values: Record<string, unknown> = {};
  const nested: Record<string, Type<any, any>> = {};
  for (const k of Object.keys(defaults as object)) {
    const v = (defaults as Record<string, unknown>)[k];
    if (isType(v)) {
      // `defaults: { translate: Vec }` — use Vec.defaults as the value.
      values[k] = v.defaults;
      nested[k] = v;
    } else if (isFieldSpec(v)) {
      // `defaults: { scale: Vec.with({x:1, y:1}) }`
      values[k] = v.init;
      nested[k] = v.type;
    } else {
      // Primitive literal — plain field, no type.
      values[k] = v;
    }
  }
  return { values, nested };
}

// ── struct() — the public factory ───────────────────────────────────

/** Type-level: widen a literal primitive (`0` → `number`, `"a"` →
 *  `string`, `true` → `boolean`). For object literals, keep as-is. */
type Widen<T> =
  T extends number ? number
  : T extends string ? string
  : T extends boolean ? boolean
  : T extends bigint ? bigint
  : T;

/** Type-level: resolve one entry in a defaults map to its value type.
 *
 *  - `Vec` (a Type)              → V (Vec's plain value type)
 *  - `Vec.with({x:1, y:1})`      → V
 *  - `0`, `"hello"`, `true`      → number, string, boolean (widened)
 *  - `{ x: 0, y: 0 }`            → { x: number, y: number } (recursive) */
type FieldValue<F> =
  F extends Type<infer X, any> ? X
  : F extends FieldSpec<infer X> ? X
  : Widen<F>;

/** Extract T from a struct-config literal. Handles:
 *  - Primitive defaults: `defaults: 0` → T = number
 *  - Plain-object defaults: `defaults: { x: 0, y: 0 }` → T = {x, y}
 *  - Typed-entry defaults: `defaults: { translate: Vec, rotate: 0 }` →
 *    T = { translate: V, rotate: number } */
type ExtractT<C> =
  C extends { defaults: infer D }
    ? D extends Type<infer X, any> ? X
    : D extends FieldSpec<infer X> ? X
    : D extends object
      ? D extends Function ? D
      : D extends readonly any[] ? D
      : { [K in keyof D]: FieldValue<D[K]> }
    : Widen<D>
  : never;

/** Build a Type<T, C> from a plain config object.
 *
 *  The `const` modifier preserves the literal shape of cfg so
 *  Cell<T, C>'s surface inference (methods, getters, fields, capability
 *  mixins) sees the exact keys the user wrote.
 *
 *  Replaces the old `defineStruct({...}).build()` Builder pattern from
 *  the legacy `signals/` folder. */
export function struct<const C extends StructInput<any>>(
  cfg: C,
): Type<ExtractT<C>, C> {
  type T = ExtractT<C>;

  // ── Reserved-name guard at construction time ────────────────
  if (cfg.methods) {
    for (const k of Object.keys(cfg.methods)) {
      if (RESERVED_NAMES.has(k)) {
        throw new Error(
          `struct(${cfg.name ?? "<unnamed>"}): method name "${k}" is reserved ` +
          `(would shadow Function.prototype.${k} or a minim intrinsic).`,
        );
      }
    }
  }
  if (cfg.getters) {
    for (const k of Object.keys(cfg.getters)) {
      if (RESERVED_NAMES.has(k)) {
        throw new Error(
          `struct(${cfg.name ?? "<unnamed>"}): getter name "${k}" is reserved.`,
        );
      }
    }
  }

  // The callable factory. `Vec({x:1, y:2})` === `Vec.cell({x:1, y:2})`.
  const t: any = function (initial: any, opts?: { storage?: Storage }) {
    return t.cell(initial, opts);
  };

  // ── Walk `defaults` entries: extract typed fields + value shape ──
  //
  // The new style allows `defaults` entries to be Types or FieldSpecs:
  //
  //     defaults: {
  //       translate: Vec,                    // typed shorthand
  //       scale: Vec.with({ x: 1, y: 1 }),   // typed with init override
  //       rotate: 0,                          // primitive default
  //     }
  //
  // Synthesise: (a) the actual value-shape with literal defaults, and
  // (b) the `nested` map of declared field types. Either may be empty;
  // legacy `nested:` config still works as an override.
  const walked = walkDefaults(cfg.defaults);
  const synthDefaults = walked.values;
  const synthNested = walked.nested;

  // Copy config fields verbatim. The function's intrinsic `name` is
  // read-only by assignment but configurable via defineProperty.
  for (const k of Object.keys(cfg) as (keyof StructInput<T>)[]) {
    if (k === "name" || k === "defaults" || k === "nested") continue;
    (t as any)[k] = cfg[k];
  }
  // Defaults: prefer the synthesised value-shape so Types/FieldSpecs
  // in the literal are resolved to their plain values at runtime.
  t.defaults = synthDefaults;
  // Nested: user-supplied `nested:` wins (explicit override); else
  // use the map synthesised from defaults entries.
  t.nested = cfg.nested ?? synthNested;
  if (cfg.name) {
    Object.defineProperty(t, "name", { value: cfg.name, configurable: true });
  }

  // Synthesise composite capabilities from `nested` (don't overwrite
  // user-supplied directs). Use the resolved nested map.
  const effectiveCfg = { ...cfg, defaults: synthDefaults, nested: t.nested };
  const lerpFn = compositeLerp(effectiveCfg);
  const linFn  = compositeLinear(effectiveCfg);
  const metFn  = compositeMetric(effectiveCfg);
  const eqFn   = compositeEquals(effectiveCfg);
  if (lerpFn && !cfg.lerp)   t.lerp   = lerpFn;
  if (linFn  && !cfg.linear) t.linear = linFn;
  if (metFn  && !cfg.metric) t.metric = metFn;
  t.equals = eqFn;

  // Expose linear ops directly for plain math: `Vec.add(a, b)`.
  if (t.linear) {
    t.add   = t.linear.add;
    t.sub   = t.linear.sub;
    t.scale = t.linear.scale;
  }

  // ── Cell factories ─────────────────────────────────────────
  // Storage decision: check the *resolved* nested map (`t.nested`, set
  // above by either user-supplied `cfg.nested` or synthesised from
  // `defaults` entries), and the *resolved* defaults (`t.defaults`).
  t.cell = function (initial: T, opts?: { storage?: Storage }): Cell<T, C> {
    const storage = opts?.storage ?? cfg.storage ?? "aos";
    const hasNested = t.nested && Object.keys(t.nested).length > 0;
    if (storage === "soa" && hasNested && typeof t.defaults === "object") {
      return makeSoaCell(t, initial);
    }
    return wrap(signal(initial), t, true) as Cell<T, C>;
  };
  t.derived = function (fn: () => T): RO<T, C> {
    return wrap(computed(fn), t, false) as unknown as RO<T, C>;
  };
  t.lens = function (read: () => T, write: (v: T) => void): Cell<T, C> {
    const reader = computed(read);
    const fn: any = function (...args: any[]) {
      if (args.length === 0) return reader();
      write(args[0]);
    };
    Object.setPrototypeOf(fn, protosFor(t).rw);
    return fn as Cell<T, C>;
  };
  t.is = function (v: unknown): v is Cell<T, C> | RO<T, C> {
    return typeof v === "function" && (v as any)[TYPE] === t;
  };

  // `.with(init)` — produce a FieldSpec for use in parent's defaults.
  //   Vec.with({x:1, y:1})  →  { __field: true, type: Vec, init: {x:1, y:1} }
  t.with = function (init: T): FieldSpec<T> {
    return { __field: true, type: t, init };
  };

  return t as Type<T, C>;
}

/** Build a SoA-flavor cell: per-field signals installed as own-props,
 *  parent callable fans-in for read, fans-out for write. Reads from the
 *  Type's resolved `.defaults` (post-walkDefaults) and `.nested` map
 *  (synthesised from defaults entries or supplied directly). */
function makeSoaCell<T, C>(type: Type<T, C>, initial: T): Cell<T, C> {
  const keys = Object.keys(type.defaults as object);
  const nested = type.nested as any;

  const inst: any = function (...args: any[]) {
    if (args.length === 0) {
      const out: any = {};
      for (let i = 0; i < keys.length; i++) out[keys[i]] = inst[keys[i]]();
      return out;
    }
    const v = args[0];
    startBatch();
    try {
      for (let i = 0; i < keys.length; i++) inst[keys[i]](v[keys[i]]);
    } finally { endBatch(); }
  };

  const obj = initial as any;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const childCfg = nested[k];
    const childInit = obj?.[k] ?? (type.defaults as any)[k];
    if (childCfg && typeof (childCfg as any).cell === "function") {
      // Already a registered Type — reuse it (don't re-`struct`).
      inst[k] = (childCfg as Type<any>).cell(childInit);
    } else if (childCfg) {
      inst[k] = struct(childCfg as StructInput<any>).cell(childInit);
    } else {
      inst[k] = signal(childInit);
    }
  }
  Object.setPrototypeOf(inst, protosFor(type as Type<T>).soa);
  return inst as Cell<T, C>;
}

// ── Bare cell (no type) ─────────────────────────────────────────────
//
// Bare cells use a single shared prototype carrying `.peek`. Previously
// `.peek` was installed as an own-property per instance (~100 b/cell
// extra); the shared-proto version costs nothing per instance — every
// bare cell is just `Object.setPrototypeOf(alienSignal, bareProto)`,
// matching typed cells' zero-per-instance overhead story.

const bareProto: any = Object.create(Function.prototype);
Object.defineProperty(bareProto, "peek", {
  configurable: true, writable: true,
  value(this: () => unknown) {
    const prev = setActiveSub(undefined);
    try { return this(); }
    finally { setActiveSub(prev); }
  },
});

/** Bare reactive cell — no type attached. `v()` reads, `v(x)` writes,
 *  `v.peek()` reads untracked. No methods, no fields. */
export function cell<T>(initial: T): Cell<T> {
  const fn = signal(initial) as unknown as Cell<T>;
  Object.setPrototypeOf(fn, bareProto);
  return fn;
}
cell.derived = <T>(fn: () => T): RO<T> => {
  const c = computed(fn) as unknown as RO<T>;
  Object.setPrototypeOf(c, bareProto);
  return c;
};
cell.lens = <T>(read: () => T, write: (v: T) => void): Cell<T> => {
  const reader = computed(read);
  const fn: any = function (...args: any[]) {
    if (args.length === 0) return reader();
    write(args[0]);
  };
  Object.setPrototypeOf(fn, bareProto);
  return fn as Cell<T>;
};

// ── Re-exports ──────────────────────────────────────────────────────

export { signal, computed, effect, isSignal, startBatch, endBatch };
