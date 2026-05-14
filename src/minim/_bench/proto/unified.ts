// ── Unified Cell + Type — engine-agnostic ───────────────────────────
//
// Three observations driving the design:
//
//   1. A Type is just a plain JS object describing a value-shape's
//      operations: defaults, lerp, algebra, metric, nested map, ops.
//      No registry, no defineStruct ceremony. The library reads these
//      as direct property access.
//
//   2. Capabilities compose through `nested`. If Transform declares
//      `nested: { translate: Vec, rotate: Num, … }` and never supplies
//      its own algebra/lerp/metric, the composite reductions are
//      derived mechanically. ~70 LOC of Transform vanishes.
//
//   3. The Cell is a thin wrapper over an Engine.Ref<T>. It carries:
//        • a per-type prototype with methods + lazy axes
//        • a `.type` pointer (the source of truth for capabilities)
//        • the engine.Ref (storage)
//      `.value` / `.peek` proxy to the engine. Methods read capability
//      functions off `.type` and dispatch.
//
// The Type<T> object is *callable as a math namespace* — `Vec.lerp(a, b, t)`,
// `Vec.algebra.add(a, b)`. The plain math is reachable without going
// through a cell. Reactive construction is via `Vec.cell({x,y})` /
// `Vec.derived(fn)` / `Vec.lens(r, w)`.

import type { Engine, Ref } from "./engine";

// ── Type<T> — plain config + composite-derived capabilities ─────────

export interface Algebra<T> {
  add: (a: T, b: T) => T;
  sub: (a: T, b: T) => T;
  scale: (a: T, k: number) => T;
}

/** The raw config a user supplies. Everything optional except `defaults`. */
export interface TypeConfig<T> {
  name: string;
  defaults: T;
  equals?: (a: T, b: T) => boolean;
  lerp?: (a: T, b: T, t: number) => T;
  algebra?: Algebra<T>;
  metric?: (a: T, b: T) => number;
  /** Map each field to its own Type for nested composition. Declaring
   *  a field here gives the cell's axis the nested type's surface AND
   *  participates in capability lifting. */
  nested?: { [K in keyof T]?: TypeConfig<T[K]> };
  /** Store each nested field in its own signal (fine-grained writes).
   *  Default false (AoS: one signal, lens-shaped axes). Transform
   *  wants this; Vec doesn't. */
  soa?: boolean;
  /** Extra custom ops. Each is lifted at method-call time. */
  ops?: { [name: string]: (s: T, ...args: any[]) => any };
  /** Lazy property getters (`v.length` → ReadonlyCell<number>). */
  getters?: { [name: string]: (this: { value: T; peek(): T }) => any };
}

/** The library's view of a type. Capabilities are guaranteed populated
 *  (either user-supplied or derived from nested). Cached per config so
 *  composite reductions are built once. */
export interface Type<T> extends TypeConfig<T> {
  /** Auto-derived if absent and `nested` covers all fields. */
  readonly equalsFn: (a: T, b: T) => boolean;
  readonly lerpFn: ((a: T, b: T, t: number) => T) | undefined;
  readonly algebraFn: Algebra<T> | undefined;
  readonly metricFn: ((a: T, b: T) => number) | undefined;
  /** Internal: lazy prototype cache, keyed by (engine → flavor → proto).
   *  Different engines need different baseProtos under the chain, so
   *  the cache MUST be partitioned by engine. */
  readonly protosByEngine: WeakMap<Engine, { rw?: object; ro?: object; soaRw?: object }>;
}

// ── Composite-capability synthesis ──────────────────────────────────
//
// Walk `nested`. If every declared field has the capability (either
// directly or recursively), build the per-field reduction. Otherwise
// return undefined (caller decides how to react).

function compositeEquals<T>(t: TypeConfig<T>): (a: T, b: T) => boolean {
  if (t.equals) return t.equals;
  if (!isObjectShape(t.defaults)) {
    // Scalar default — use === (no algebra; Float-NaN edge ignored).
    return (a, b) => a === b;
  }
  const keys = Object.keys(t.defaults as object);
  const nested = t.nested ?? {};
  const subs: Record<string, (a: any, b: any) => boolean> = {};
  for (const k of keys) {
    const subT = (nested as any)[k];
    subs[k] = subT ? typeFor(subT).equalsFn : (a, b) => a === b;
  }
  return (a, b) => {
    for (const k of keys) {
      if (!subs[k]((a as any)[k], (b as any)[k])) return false;
    }
    return true;
  };
}

function compositeLerp<T>(
  t: TypeConfig<T>,
): ((a: T, b: T, t: number) => T) | undefined {
  if (t.lerp) return t.lerp;
  if (!isObjectShape(t.defaults) || !t.nested) return undefined;
  const keys = Object.keys(t.defaults as object);
  const subs: Record<string, (a: any, b: any, t: number) => any> = {};
  for (const k of keys) {
    const subT = (t.nested as any)[k];
    if (!subT) return undefined; // missing nested entry — can't lift
    const f = typeFor(subT).lerpFn;
    if (!f) return undefined;
    subs[k] = f;
  }
  return (a, b, alpha) => {
    const out: any = {};
    for (const k of keys) {
      out[k] = subs[k]((a as any)[k], (b as any)[k], alpha);
    }
    return out as T;
  };
}

function compositeAlgebra<T>(t: TypeConfig<T>): Algebra<T> | undefined {
  if (t.algebra) return t.algebra;
  if (!isObjectShape(t.defaults) || !t.nested) return undefined;
  const keys = Object.keys(t.defaults as object);
  const adds: Record<string, (a: any, b: any) => any> = {};
  const subs: Record<string, (a: any, b: any) => any> = {};
  const scales: Record<string, (a: any, k: number) => any> = {};
  for (const k of keys) {
    const subT = (t.nested as any)[k];
    if (!subT) return undefined;
    const a = typeFor(subT).algebraFn;
    if (!a) return undefined;
    adds[k] = a.add;
    subs[k] = a.sub;
    scales[k] = a.scale;
  }
  return {
    add: (a, b) => {
      const out: any = {};
      for (const k of keys) out[k] = adds[k]((a as any)[k], (b as any)[k]);
      return out as T;
    },
    sub: (a, b) => {
      const out: any = {};
      for (const k of keys) out[k] = subs[k]((a as any)[k], (b as any)[k]);
      return out as T;
    },
    scale: (a, k) => {
      const out: any = {};
      for (const kk of keys) out[kk] = scales[kk]((a as any)[kk], k);
      return out as T;
    },
  };
}

function compositeMetric<T>(
  t: TypeConfig<T>,
): ((a: T, b: T) => number) | undefined {
  if (t.metric) return t.metric;
  if (!isObjectShape(t.defaults) || !t.nested) return undefined;
  const keys = Object.keys(t.defaults as object);
  const subs: Record<string, (a: any, b: any) => number> = {};
  for (const k of keys) {
    const subT = (t.nested as any)[k];
    if (!subT) return undefined;
    const m = typeFor(subT).metricFn;
    if (!m) return undefined;
    subs[k] = m;
  }
  // Euclidean composition — sqrt(Σ d_i²).
  return (a, b) => {
    let s = 0;
    for (const k of keys) {
      const d = subs[k]((a as any)[k], (b as any)[k]);
      s += d * d;
    }
    return Math.sqrt(s);
  };
}

function isObjectShape(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ── typeFor: hydrate a config into a runnable Type ──────────────────

const typeCache = new WeakMap<TypeConfig<any>, Type<any>>();

export function typeFor<T>(cfg: TypeConfig<T>): Type<T> {
  const cached = typeCache.get(cfg);
  if (cached) return cached as Type<T>;
  const t: Type<T> = Object.assign(Object.create(null) as Type<T>, cfg, {
    equalsFn: compositeEquals(cfg),
    lerpFn: compositeLerp(cfg),
    algebraFn: compositeAlgebra(cfg),
    metricFn: compositeMetric(cfg),
    protosByEngine: new WeakMap<Engine, { rw?: object; ro?: object; soaRw?: object }>(),
  });
  typeCache.set(cfg, t);
  return t;
}

function protoSlot<T>(
  type: Type<T>,
  engine: Engine,
): { rw?: object; ro?: object; soaRw?: object } {
  let slot = type.protosByEngine.get(engine);
  if (!slot) {
    slot = {};
    type.protosByEngine.set(engine, slot);
  }
  return slot;
}

// ── Cell — engine-agnostic, single wrapper class ────────────────────
//
// A Cell holds an engine ref and points at a Type. Methods live on a
// per-type prototype installed lazily.

const TYPE_TAG = Symbol("type");
const REF_TAG = Symbol("ref");
const ENGINE_TAG = Symbol("engine");

export interface Cell<T> {
  readonly value: T;
  peek(): T;
  readonly type?: Type<T>;
  // Plus per-type properties: axes (`.x`, `.y`), methods (`.lerp`,
  // `.add`, `.distance`), getters (`.length`), custom ops.
}

interface CellInternal<T> extends Cell<T> {
  [TYPE_TAG]: Type<T> | undefined;
  [REF_TAG]: Ref<T>;
  [ENGINE_TAG]: Engine;
}

/** Per-engine base prototype — holds the `.value` getter/setter that
 *  routes to the engine, plus a generic `.peek()`. Bare cells use this
 *  directly; typed cells chain a per-type proto off it. */
const baseProtoCache = new WeakMap<Engine, object>();

function baseProto(engine: Engine): object {
  const cached = baseProtoCache.get(engine);
  if (cached) return cached;
  const p: any = Object.create(null);
  Object.defineProperty(p, "value", {
    configurable: true,
    get(this: CellInternal<any>) {
      return engine.read(this[REF_TAG]);
    },
    set(this: CellInternal<any>, v: any) {
      engine.write(this[REF_TAG], v);
    },
  });
  Object.defineProperty(p, "peek", {
    configurable: true,
    writable: true,
    value(this: CellInternal<any>) {
      return engine.peek(this[REF_TAG]);
    },
  });
  baseProtoCache.set(engine, p);
  return p;
}

// ── Per-type prototype installer (lazy axes + capability methods) ──

function rwProtoFor<T>(engine: Engine, type: Type<T>): object {
  const slot = protoSlot(type, engine);
  if (slot.rw) return slot.rw;
  const proto = Object.create(baseProto(engine));
  installMethods(proto, engine, type, true);
  installAxes(proto, engine, type, true);
  installGetters(proto, type);
  slot.rw = proto;
  return proto as object;
}

function roProtoFor<T>(engine: Engine, type: Type<T>): object {
  const slot = protoSlot(type, engine);
  if (slot.ro) return slot.ro;
  const proto = Object.create(baseProto(engine));
  installMethods(proto, engine, type, false);
  installAxes(proto, engine, type, false);
  installGetters(proto, type);
  slot.ro = proto;
  return proto as object;
}

function soaProtoFor<T>(engine: Engine, type: Type<T>): object {
  const slot = protoSlot(type, engine);
  if (slot.soaRw) return slot.soaRw as object;
  // SoA-flavor: axes are own-props (installed eagerly); .value gets
  // composed from them. No lazy-axis getters on proto (they'd shadow).
  const proto = Object.create(null);
  const keys = Object.keys(type.defaults as object);
  Object.defineProperty(proto, "value", {
    configurable: true,
    get(this: any) {
      const out: any = {};
      for (let i = 0; i < keys.length; i++) {
        out[keys[i]] = this[keys[i]].value;
      }
      return out;
    },
    set(this: any, v: any) {
      engine.batch(() => {
        for (let i = 0; i < keys.length; i++) {
          this[keys[i]].value = v[keys[i]];
        }
      });
    },
  });
  Object.defineProperty(proto, "peek", {
    configurable: true,
    writable: true,
    value(this: any) {
      const out: any = {};
      for (let i = 0; i < keys.length; i++) {
        out[keys[i]] = this[keys[i]].peek();
      }
      return out;
    },
  });
  installMethods(proto, engine, type, true);
  installGetters(proto, type);
  slot.soaRw = proto;
  return proto as object;
}

function installMethods<T>(
  proto: any,
  engine: Engine,
  type: Type<T>,
  writable: boolean,
) {
  void writable;
  if (type.lerpFn) {
    const fn = type.lerpFn;
    proto.lerp = function (this: CellInternal<T>, target: any, alpha: any) {
      const self = this;
      return wrapDerived(
        engine,
        engine.computed(() =>
          fn(
            engine.read(self[REF_TAG]),
            valueOf(target, engine),
            scalarOf(alpha, engine),
          ),
        ),
        type,
      );
    };
  }
  if (type.algebraFn) {
    const a = type.algebraFn;
    proto.add = function (this: CellInternal<T>, b: any) {
      const self = this;
      return wrapDerived(
        engine,
        engine.computed(() => a.add(engine.read(self[REF_TAG]), valueOf(b, engine))),
        type,
      );
    };
    proto.sub = function (this: CellInternal<T>, b: any) {
      const self = this;
      return wrapDerived(
        engine,
        engine.computed(() => a.sub(engine.read(self[REF_TAG]), valueOf(b, engine))),
        type,
      );
    };
    proto.scale = function (this: CellInternal<T>, k: any) {
      const self = this;
      return wrapDerived(
        engine,
        engine.computed(() => a.scale(engine.read(self[REF_TAG]), scalarOf(k, engine))),
        type,
      );
    };
  }
  if (type.metricFn) {
    const d = type.metricFn;
    proto.distance = function (this: CellInternal<T>, b: any) {
      const self = this;
      return wrapBare(
        engine,
        engine.computed(() => d(engine.read(self[REF_TAG]), valueOf(b, engine))),
      );
    };
  }
  if (type.ops) {
    for (const name in type.ops) {
      const op = type.ops[name];
      proto[name] = function (this: CellInternal<T>, ...args: any[]) {
        const self = this;
        return wrapBare(
          engine,
          engine.computed(() =>
            op(
              engine.read(self[REF_TAG]),
              ...args.map((a) => valueOf(a, engine)),
            ),
          ),
        );
      };
    }
  }
}

function installAxes<T>(
  proto: any,
  engine: Engine,
  type: Type<T>,
  writable: boolean,
) {
  if (!isObjectShape(type.defaults)) return;
  const nested = type.nested ?? {};
  for (const k of Object.keys(type.defaults as object)) {
    const childType = (nested as any)[k];
    Object.defineProperty(proto, k, {
      configurable: true,
      get(this: CellInternal<T>) {
        const self = this;
        let axisRef: Ref<any>;
        if (writable) {
          axisRef = engine.lens(
            () => (engine.read(self[REF_TAG]) as any)[k],
            (v) => {
              const cur = engine.peek(self[REF_TAG]) as any;
              engine.write(self[REF_TAG], { ...cur, [k]: v });
            },
          );
        } else {
          axisRef = engine.computed(
            () => (engine.read(self[REF_TAG]) as any)[k],
          );
        }
        const axisCell = childType
          ? wrapTypedRef(engine, axisRef, typeFor(childType), writable)
          : wrapBare(engine, axisRef);
        Object.defineProperty(self, k, {
          value: axisCell,
          configurable: false,
          writable: false,
        });
        return axisCell;
      },
    });
  }
}

function installGetters<T>(proto: any, type: Type<T>) {
  if (!type.getters) return;
  for (const name in type.getters) {
    const fn = type.getters[name];
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: any) {
        const v = fn.call(this);
        Object.defineProperty(this, name, { value: v });
        return v;
      },
    });
  }
}

// ── Resolve "value-or-cell-or-thunk" to plain value ──────────────────

function valueOf(a: any, engine: Engine): any {
  if (a == null) return a;
  if (typeof a === "function") return a();
  if (REF_TAG in a) return engine.read(a[REF_TAG]);
  return a;
}

function scalarOf(a: any, engine: Engine): number {
  if (typeof a === "number") return a;
  if (typeof a === "function") return a();
  if (a != null && REF_TAG in a) return engine.read(a[REF_TAG]) as number;
  return a;
}

// ── Wrappers — bare + typed ─────────────────────────────────────────

function wrapBare<T>(engine: Engine, ref: Ref<T>): Cell<T> {
  const inst: any = Object.create(baseProto(engine));
  inst[REF_TAG] = ref;
  inst[ENGINE_TAG] = engine;
  inst[TYPE_TAG] = undefined;
  return inst as Cell<T>;
}

function wrapTypedRef<T>(
  engine: Engine,
  ref: Ref<T>,
  type: Type<T>,
  writable: boolean,
): Cell<T> {
  const proto = writable ? rwProtoFor(engine, type) : roProtoFor(engine, type);
  const inst: any = Object.create(proto);
  inst[REF_TAG] = ref;
  inst[ENGINE_TAG] = engine;
  inst[TYPE_TAG] = type;
  return inst as Cell<T>;
}

function wrapDerived<T>(engine: Engine, ref: Ref<T>, type: Type<T>): Cell<T> {
  return wrapTypedRef(engine, ref, type, false);
}

// ── Public factory ──────────────────────────────────────────────────

export function makeCellFactory(engine: Engine) {
  function cell<T>(initial: T): Cell<T>;
  function cell<T>(initial: T, type: TypeConfig<T>): Cell<T>;
  function cell<T>(initial: T, typeCfg?: TypeConfig<T>): Cell<T> {
    if (typeCfg === undefined) {
      return wrapBare(engine, engine.signal(initial));
    }
    const type = typeFor(typeCfg);
    if (typeCfg.soa && isObjectShape(typeCfg.defaults) && typeCfg.nested) {
      // SoA: per-field signals. Each field is itself a cell of its
      // nested type (or a bare cell if no nested type declared).
      const proto = soaProtoFor(engine, type);
      const inst: any = Object.create(proto);
      const obj = initial as any;
      const keys = Object.keys(typeCfg.defaults as object);
      const nested = typeCfg.nested as any;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const childCfg = nested[k];
        const childInit = obj?.[k] ?? (typeCfg.defaults as any)[k];
        inst[k] = childCfg ? cell(childInit, childCfg) : wrapBare(engine, engine.signal(childInit));
      }
      inst[TYPE_TAG] = type;
      inst[ENGINE_TAG] = engine;
      return inst as Cell<T>;
    }
    // AoS: one signal under a per-type prototype with lazy lens axes.
    return wrapTypedRef(
      engine,
      engine.signal(initial, type.equals ? { equals: type.equals } : undefined),
      type,
      true,
    );
  }

  cell.derived = function <T>(fn: () => T, typeCfg?: TypeConfig<T>): Cell<T> {
    if (typeCfg === undefined) {
      return wrapBare(engine, engine.computed(fn));
    }
    const type = typeFor(typeCfg);
    return wrapTypedRef(engine, engine.computed(fn), type, false);
  };

  cell.lens = function <T>(
    r: () => T,
    w: (v: T) => void,
    typeCfg?: TypeConfig<T>,
  ): Cell<T> {
    const ref = engine.lens(r, w);
    if (typeCfg === undefined) return wrapBare(engine, ref);
    return wrapTypedRef(engine, ref, typeFor(typeCfg), true);
  };

  return cell;
}

// ── Type<T> static math API ─────────────────────────────────────────
//
// Plain math without any cell involvement, available directly on the
// type config. `Vec.add(a, b)` etc.

export function withMath<T, C extends TypeConfig<T>>(cfg: C): C & {
  add?: Algebra<T>["add"];
  sub?: Algebra<T>["sub"];
  scale?: Algebra<T>["scale"];
  lerp_plain?: (a: T, b: T, t: number) => T;
  metric_plain?: (a: T, b: T) => number;
} {
  const t = typeFor(cfg);
  const out: any = cfg;
  if (t.algebraFn) {
    out.add = t.algebraFn.add;
    out.sub = t.algebraFn.sub;
    out.scale = t.algebraFn.scale;
  }
  if (t.lerpFn) out.lerp_plain = t.lerpFn;
  if (t.metricFn) out.metric_plain = t.metricFn;
  return out;
}
