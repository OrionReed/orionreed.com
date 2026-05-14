// ── minim v2 — the cell IS the callable, no .value ───────────────────
//
// Design intent:
//
//   • One reactive primitive: Cell<T>. It's a callable function.
//     `v()` reads, `v(x)` writes. No `.value` getter — call IS read.
//
//   • One config shape: Type<T>. Plain JS object. No defineStruct, no
//     Builder, no `[ALGEBRA]` symbols. Capabilities are direct
//     properties (`Vec.lerp`, `Vec.algebra`, `Vec.metric`).
//
//   • Two bags: `methods` (cell methods, auto-lifted) and `getters`
//     (lazy properties, cached). No ops/scalars/getters/methods/
//     construct distinction.
//
//   • Capabilities compose through `nested`. Transform declares no
//     algebra/lerp/metric; they're synthesised from per-field
//     reductions through Vec/Num. Same for `equals`.
//
//   • `Val<T> = T | (() => T)`. Cells ARE callables, so a cell is
//     already a `() => T` and slots into Val<T> with no special case.
//
//   • Types know writability per-axis. `Cell<T>` is writable;
//     `Cell.RO<T>` is read-only; lenses bridge from RO to writable.

import {
  signal,
  computed,
  effect,
  setActiveSub,
  isSignal,
  startBatch,
  endBatch,
  type SignalFn,
} from "./alien-trim";

// ── Public types ────────────────────────────────────────────────────

/** A writable reactive value. Callable: `v()` reads, `v(x)` writes.
 *  Inherits axes + methods from its Type via prototype. */
export interface Cell<T> extends SignalFn<T> {
  /** Untracked read — doesn't subscribe the current effect. */
  peek(): T;
  /** The Type this cell is attached to (or undefined for bare cells). */
  readonly type?: Type<T>;
}

/** A read-only reactive value. Same callable shape; writes are no-ops
 *  (typed). */
export interface RO<T> {
  (): T;
  peek(): T;
  readonly type?: Type<T>;
  readonly __t?: T;
}

/** Anywhere a value-or-source is accepted: literal, thunk, or cell.
 *  Because Cell<T> is `() => T`, cells already satisfy `(() => T)`. */
export type Val<T> = T | (() => T);

/** Vector-space algebra. */
export interface Algebra<T> {
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  scale(a: T, k: number): T;
}

/** Names reserved by the host: function-prototype members + framework
 *  intrinsics. Putting a `methods` or `getters` entry under any of these
 *  would silently shadow built-in behaviour (e.g. `cell.length` would
 *  return Function.prototype.length, not the user's getter). Checked
 *  at runtime in `defineType` — throws with the offending name. */
export const RESERVED_NAMES = new Set<string>([
  // Function.prototype intrinsics
  "length", "name", "caller", "arguments", "prototype",
  "bind", "call", "apply", "toString",
  // minim framework keys
  "type", "peek",
]);

/** Plain config object for a value type. Pass to `defineType()` to get
 *  a Type<T> with synthesized capabilities + factory call signature.
 *  Method / getter names that clash with Function.prototype are
 *  rejected at construction with a clear error. */
export interface TypeConfig<T> {
  readonly name?: string;
  readonly defaults: T;
  readonly equals?: (a: T, b: T) => boolean;
  readonly lerp?: (a: T, b: T, t: number) => T;
  readonly algebra?: Algebra<T>;
  readonly metric?: (a: T, b: T) => number;
  /** Field-type map. Declaring a field here gives that axis the
   *  nested type's surface AND participates in capability lifting. */
  readonly nested?: { [K in keyof T]?: TypeConfig<T[K]> };
  /** SoA storage (per-field signals). Default false (AoS lens axes). */
  readonly soa?: boolean;
  /** Methods on cells. `(self, ...args) => R`. Framework auto-wraps R
   *  in a derived cell if non-function. */
  readonly methods?: Record<string, (self: T, ...args: any[]) => any>;
  /** Lazy getters — read-once, cache as own-property. */
  readonly getters?: Record<string, (this: Cell<T>) => any>;
}

/** A registered type: callable as factory + carries plain math + cell
 *  factory variants + type guard. */
export interface Type<T> extends TypeConfig<T> {
  // Callable as factory: `Vec(1, 2)` → Cell<Vec>. Positional → record
  // shape only if `nested` is set (per-field positional from nested
  // keys). Otherwise: `Vec({x:1, y:2})` only.
  (this: void, ...args: any[]): Cell<T>;

  /** Build a writable cell from initial value. */
  cell(initial: T): Cell<T>;
  /** Build a read-only cell from a getter. */
  derived(fn: () => T): RO<T>;
  /** Build a writable lens from a read fn + write fn. */
  lens(read: () => T, write: (v: T) => void): Cell<T>;

  /** Type guard: any flavor of this type's cell. */
  is(v: unknown): v is Cell<T> | RO<T>;

  // Plain math, derived/copied from capabilities for direct use:
  add: T extends never ? undefined : (a: T, b: T) => T;
  sub: T extends never ? undefined : (a: T, b: T) => T;
  scale: T extends never ? undefined : (a: T, k: number) => T;
  // (lerp/metric exposed as type.lerp / type.metric — already there)
}

// ── Capability composition (lifting through `nested`) ───────────────

function compositeEquals<T>(t: TypeConfig<T>): (a: T, b: T) => boolean {
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

function compositeLerp<T>(t: TypeConfig<T>): ((a: T, b: T, t: number) => T) | undefined {
  if (t.lerp) return t.lerp;
  if (typeof t.defaults !== "object" || !t.nested) return undefined;
  const keys = Object.keys(t.defaults as object);
  const subs: Record<string, (a: any, b: any, t: number) => any> = {};
  for (const k of keys) {
    const f = compositeLerp((t.nested as any)[k]);
    if (!f) return undefined;
    subs[k] = f;
  }
  return (a, b, alpha) => {
    const out: any = {};
    for (const k of keys) out[k] = subs[k]((a as any)[k], (b as any)[k], alpha);
    return out as T;
  };
}

function compositeAlgebra<T>(t: TypeConfig<T>): Algebra<T> | undefined {
  if (t.algebra) return t.algebra;
  if (typeof t.defaults !== "object" || !t.nested) return undefined;
  const keys = Object.keys(t.defaults as object);
  const adds: Record<string, any> = {};
  const subs: Record<string, any> = {};
  const scales: Record<string, any> = {};
  for (const k of keys) {
    const a = compositeAlgebra((t.nested as any)[k]);
    if (!a) return undefined;
    adds[k] = a.add; subs[k] = a.sub; scales[k] = a.scale;
  }
  return {
    add: (a, b) => { const out: any = {}; for (const k of keys) out[k] = adds[k]((a as any)[k], (b as any)[k]); return out; },
    sub: (a, b) => { const out: any = {}; for (const k of keys) out[k] = subs[k]((a as any)[k], (b as any)[k]); return out; },
    scale: (a, k) => { const out: any = {}; for (const kk of keys) out[kk] = scales[kk]((a as any)[kk], k); return out; },
  };
}

function compositeMetric<T>(t: TypeConfig<T>): ((a: T, b: T) => number) | undefined {
  if (t.metric) return t.metric;
  if (typeof t.defaults !== "object" || !t.nested) return undefined;
  const keys = Object.keys(t.defaults as object);
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

// ── Prototype installation ──────────────────────────────────────────

const TYPE = Symbol("type");

const protoCache = new WeakMap<TypeConfig<any>, { rw: any; ro: any; soa: any }>();

function makeProto<T>(type: Type<T>, writable: boolean): any {
  // Chain off Function.prototype so the cell remains callable.
  const proto = Object.create(Function.prototype);

  // ── peek: untracked read. We don't expose .value, but peek() is
  //    explicit "I don't want to subscribe right now."
  Object.defineProperty(proto, "peek", {
    configurable: true,
    writable: true,
    value(this: SignalFn<T>) {
      const prev = setActiveSub(undefined);
      try { return (this as () => T)(); }
      finally { setActiveSub(prev); }
    },
  });

  // .type — the canonical access for generic capability dispatch.
  // `cell.type === Vec`. `cell.type.algebra` works in `mean<T>`,
  // `cell.type.metric` in `spring<T>`, etc. Replaces the symbol-keyed
  // [ALGEBRA] / [LERP] / [METRIC] slots from the current minim. Reads
  // are one prototype-chain hop (same as old).
  Object.defineProperty(proto, "type", { value: type, configurable: true });
  proto[TYPE] = type;  // keep symbol slot for `Vec.is(v)` fast path

  // ── Capability methods ────────────────────────────────────────
  if (type.lerp) {
    const fn = type.lerp;
    proto.lerp = function (this: () => T, target: Val<T>, t: Val<number>) {
      const self = this;
      return wrap(computed(() => fn(self(), valOf(target), valOf(t) as number)), type, false);
    };
  }
  if (type.algebra) {
    const a = type.algebra;
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

  // ── User methods (auto-lifted). Each becomes a method that wraps
  //    its result in a derived cell of `type` (if the result is T) or
  //    a bare computed (if scalar).
  if (type.methods) {
    for (const name of Object.keys(type.methods)) {
      const m = type.methods[name];
      proto[name] = function (this: () => T, ...args: any[]) {
        const self = this;
        // Args may be Val<X>. Pre-flatten on call.
        const resolved = args;
        return computed(() => m(self(), ...resolved.map(valOf)));
      };
    }
  }

  // ── Getters: lazy, cached as own-prop on first read.
  if (type.getters) {
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

  // ── Lazy axes (AoS lens-style for non-SoA types).
  if (typeof type.defaults === "object" && type.defaults !== null) {
    const nested = type.nested ?? {};
    for (const k of Object.keys(type.defaults as object)) {
      const childType = (nested as any)[k];
      Object.defineProperty(proto, k, {
        configurable: true,
        get(this: any) {
          const self = this;
          let axis: any;
          if (writable) {
            const reader = computed(() => (self() as any)[k]);
            axis = function (...args: any[]) {
              if (args.length === 0) return reader();
              const cur = peekValue(self) as any;
              self({ ...cur, [k]: args[0] });
            };
          } else {
            axis = computed(() => (self() as any)[k]);
          }
          if (childType) {
            Object.setPrototypeOf(axis, protosFor(childType).rw);
          }
          Object.defineProperty(self, k, { value: axis, configurable: false });
          return axis;
        },
      });
    }
  }

  return proto;
}

function makeSoaProto<T>(type: Type<T>): any {
  // SoA proto: composed call dispatch (read fans-in, write fans-out).
  // Chains off the rw proto so methods are available.
  const rwProto = protosFor(type as any).rw;
  const proto = Object.create(rwProto);
  // No need to install axes — they're own-props on SoA instances.
  return proto;
}

function protosFor<T>(type: TypeConfig<T>): { rw: any; ro: any; soa: any } {
  const cached = protoCache.get(type);
  if (cached) return cached;
  const fullType = type as Type<T>;
  // Insert the slot BEFORE computing its prototypes — `makeSoaProto`
  // calls back into `protosFor(type)` to fetch the rw proto, so we
  // must avoid an infinite recursion.
  const slot: any = { rw: null, ro: null, soa: null };
  protoCache.set(type, slot);
  slot.rw = makeProto(fullType, true);
  slot.ro = makeProto(fullType, false);
  slot.soa = makeSoaProto(fullType);
  return slot;
}

function wrap<T>(fn: SignalFn<T>, type: TypeConfig<T>, writable: boolean): SignalFn<T> {
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
 *  literals returned as-is. The framework's universal "give me the
 *  current value" function. */
export function valOf<T>(v: Val<T>): T {
  return typeof v === "function" ? (v as () => T)() : v;
}

// ── Public factory ──────────────────────────────────────────────────

/** Turn a TypeConfig into a callable Type. The returned object is BOTH
 *  the factory (call as `Vec({x:1, y:2})` → Cell<Vec>) AND the
 *  namespace (`Vec.lerp`, `Vec.cell(...)`, `Vec.derived(...)`,
 *  `Vec.is(...)`, etc).
 *
 *  All capabilities (lerp/algebra/metric/equals) are pre-composed
 *  from `nested` if not user-supplied. */
export function defineType<T>(cfg: TypeConfig<T>): Type<T> {
  // Validate at construction — reject names that would shadow built-in
  // function-prototype properties.
  if (cfg.methods) {
    for (const k of Object.keys(cfg.methods)) {
      if (RESERVED_NAMES.has(k)) {
        throw new Error(
          `defineType(${cfg.name ?? "<unnamed>"}): method name "${k}" is reserved ` +
          `(would shadow Function.prototype.${k} or a minim intrinsic).`,
        );
      }
    }
  }
  if (cfg.getters) {
    for (const k of Object.keys(cfg.getters)) {
      if (RESERVED_NAMES.has(k)) {
        throw new Error(
          `defineType(${cfg.name ?? "<unnamed>"}): getter name "${k}" is reserved.`,
        );
      }
    }
  }

  // Build a callable. Vec({x:1, y:2}) === Vec.cell({x:1, y:2}).
  const t: any = function (initial: any) {
    return t.cell(initial);
  };

  // Copy config fields. The function's intrinsic `name` is read-only
  // by assignment but configurable via defineProperty — use that so
  // `Vec.name === "Vec"` (debugger / instanceof / serialisation all
  // benefit). Other fields copied directly.
  for (const k of Object.keys(cfg) as (keyof TypeConfig<T>)[]) {
    if (k === "name") continue;
    (t as any)[k] = cfg[k];
  }
  if (cfg.name) {
    Object.defineProperty(t, "name", { value: cfg.name, configurable: true });
  }

  // Synthesize composite capabilities (don't overwrite user-provided).
  const lerpFn = compositeLerp(cfg);
  const alg = compositeAlgebra(cfg);
  const metricFn = compositeMetric(cfg);
  const equalsFn = compositeEquals(cfg);
  if (lerpFn && !cfg.lerp) t.lerp = lerpFn;
  if (alg && !cfg.algebra) t.algebra = alg;
  if (metricFn && !cfg.metric) t.metric = metricFn;
  t.equals = equalsFn;

  // Expose algebra functions directly on the type for plain math.
  if (t.algebra) {
    t.add = t.algebra.add;
    t.sub = t.algebra.sub;
    t.scale = t.algebra.scale;
  }

  // Cell factories. The `peek` method lives on the per-type prototype
  // (see makeProto), so wrapping is enough — no per-instance install.
  t.cell = function (initial: T): Cell<T> {
    if (cfg.soa && cfg.nested && typeof cfg.defaults === "object") {
      return makeSoaCell(t, initial);
    }
    return wrap(signal(initial), t, true) as Cell<T>;
  };
  t.derived = function (fn: () => T): RO<T> {
    return wrap(computed(fn), t, false) as unknown as RO<T>;
  };
  t.lens = function (read: () => T, write: (v: T) => void): Cell<T> {
    const reader = computed(read);
    const fn: any = function (...args: any[]) {
      if (args.length === 0) return reader();
      write(args[0]);
    };
    Object.setPrototypeOf(fn, protosFor(t).rw);
    return fn as Cell<T>;
  };
  t.is = function (v: unknown): v is Cell<T> | RO<T> {
    return typeof v === "function" && (v as any)[TYPE] === t;
  };

  return t as Type<T>;
}

function makeSoaCell<T>(type: Type<T>, initial: T): Cell<T> {
  const cfg = type as TypeConfig<T>;
  const keys = Object.keys(cfg.defaults as object);
  const nested = cfg.nested as any;

  // The cell is a callable that fans-in for read, fans-out for write.
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
  // Per-field cells installed as own-props. If the child is already a
  // Type (has .cell), use it directly — calling `defineType(Vec)`
  // every Transform construction would create 5 new types and cost
  // ~24 µs per Transform. Use the existing Type if it's callable.
  const obj = initial as any;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const childCfg = nested[k];
    const childInit = obj?.[k] ?? (cfg.defaults as any)[k];
    if (childCfg && typeof (childCfg as any).cell === "function") {
      // Already a registered Type — reuse it.
      inst[k] = (childCfg as Type<any>).cell(childInit);
    } else if (childCfg) {
      // Raw TypeConfig — promote to Type once. Subsequent constructions
      // hit the WeakMap cache in `defineType` (TODO: add such caching).
      inst[k] = defineType(childCfg as TypeConfig<any>).cell(childInit);
    } else {
      inst[k] = signal(childInit);
    }
  }
  Object.setPrototypeOf(inst, protosFor(type).soa);
  return inst as Cell<T>;
}

// ── Bare cell (no type) ─────────────────────────────────────────────

/** Bare reactive cell — no type attached, just `v()` / `v(x)` / `v.peek()`. */
export function cell<T>(initial: T): Cell<T> {
  const fn = signal(initial) as unknown as Cell<T>;
  // Bare cells still need `.peek()` for ergonomic untracked reads.
  (fn as any).peek = function (this: () => T) {
    const prev = setActiveSub(undefined);
    try { return this(); }
    finally { setActiveSub(prev); }
  };
  return fn;
}
cell.derived = <T>(fn: () => T): RO<T> => {
  const c = computed(fn) as unknown as RO<T>;
  (c as any).peek = function (this: () => T) {
    const prev = setActiveSub(undefined);
    try { return this(); }
    finally { setActiveSub(prev); }
  };
  return c;
};
cell.lens = <T>(read: () => T, write: (v: T) => void): Cell<T> => {
  const reader = computed(read);
  const fn: any = function (...args: any[]) {
    if (args.length === 0) return reader();
    write(args[0]);
  };
  return fn as Cell<T>;
};

// ── Re-exports ──────────────────────────────────────────────────────

export { signal, computed, effect, isSignal, startBatch, endBatch };
