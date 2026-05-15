// ─────────────────────────────────────────────────────────────────────────
// Prototype: clean reactive struct system
//
// Premises:
//   1. Type IS the prototype object. No separate Type record.
//      `cell.type`, `cell.traits` reachable directly on cells (via proto).
//   2. Fields are signals. `cell.x` IS the x signal, not a lens projection
//      that has to be re-resolved.
//   3. Two `value` forms:
//      (a) literal: `value: {x: 0, y: 0}` — framework synthesizes the signal
//          topology (one signal holding the object, fields as lenses).
//      (b) function: `value: () => ({c, f})` — user constructs the signals
//          themselves (Temp's constraint, custom topologies).
//   4. `bind` is the explicit operation for one-way subscription. `=` on a
//      field is sugar for `.bind(...)` when the RHS is a signal; raw values
//      written via `cell.x = 5` are sugar for `cell.x(5)`.
//   5. Traits are explicit (no auto-synthesis). Composites use helpers.
//   6. Reserved names on cells: `type`, `traits`.
// ─────────────────────────────────────────────────────────────────────────

import {
  signal as alienSignal,
  computed as alienComputed,
  effect as alienEffect,
  startBatch,
  endBatch,
} from "alien-signals";

// ─── Core types ──────────────────────────────────────────────────────────

/** A callable signal: read with `()`, write with `(v)`. */
export interface SignalFn<T> {
  (): T;
  (v: T): void;
}

/** Trait dictionary. Open. */
export interface Traits<T> {
  linear?: {
    add(a: T, b: T): T;
    sub(a: T, b: T): T;
    scale(a: T, k: number): T;
  };
  lerp?(a: T, b: T, t: number): T;
  metric?(a: T, b: T): number;
  equals?(a: T, b: T): boolean;
  [k: string]: unknown;
}

/** A Cell is a callable signal whose prototype is a TypeProto. */
export type Cell<T, P = unknown> = SignalFn<T> & {
  readonly type: string;
  readonly traits: Traits<T>;
  bind(other: SignalFn<T>): () => void;
  mirror(other: SignalFn<T>): () => void;
} & P;

/** A TypeProto IS the type — a callable factory whose own properties form
 *  the prototype attached to its cells. */
export interface TypeProto<T = any> {
  readonly type: string;
  readonly traits: Traits<T>;
  (init?: any): any;
}

// ─── struct() — the only constructor users need ──────────────────────────

export interface StructConfig<T = any> {
  /** Identity name (was `name`). */
  type: string;
  /** Either:
   *   - a literal value (primitive or object) — framework synthesizes signals
   *   - a function returning a record of pre-constructed signals */
  value: T | (() => Record<string, SignalFn<any>>);
  traits?: Traits<T>;
  methods?: Record<string, (this: any, ...args: any[]) => any>;
  getters?: Record<string, (this: any) => any>;
}

const RESERVED = new Set([
  "type",
  "traits",
  "bind",
  "mirror",
  "apply",
  "call",
  "bind", // Function.prototype (note: 'bind' conflict — we shadow it)
  "length",
  "name",
  "prototype",
  "arguments",
  "caller",
]);

/** Built-in prototype for raw signals (no struct wrapper, just `s()` / `s(v)` / s.bind / s.mirror). */
function makeSignalProto(traits: Traits<any> = {}): any {
  const proto: any = function () {}; // a function so cells (callable) can use it as proto
  Object.defineProperty(proto, "type", { value: "Signal", configurable: true });
  proto.traits = traits;
  proto.bind = function (this: SignalFn<any>, other: SignalFn<any>) {
    // One-way subscription: write `other` into `this` whenever `other` changes.
    // Returns dispose. Writing to `this` directly is allowed; the next change of
    // `other` will overwrite (clobber semantics for now — see notes).
    const dispose = alienEffect(() => {
      this(other());
    });
    return dispose;
  };
  proto.mirror = function (this: SignalFn<any>, other: SignalFn<any>) {
    // Two-way: any write to either side propagates to the other.
    // On setup, `this`'s value wins (we write it into `other`).
    other(this());
    let busy = false;
    let lastA = this();
    let lastB = other();
    const dA = alienEffect(() => {
      const v = this();
      if (busy || Object.is(v, lastA)) return;
      lastA = v;
      busy = true;
      try {
        other(v);
        lastB = v;
      } finally {
        busy = false;
      }
    });
    const dB = alienEffect(() => {
      const v = other();
      if (busy || Object.is(v, lastB)) return;
      lastB = v;
      busy = true;
      try {
        this(v);
        lastA = v;
      } finally {
        busy = false;
      }
    });
    return () => {
      dA();
      dB();
    };
  };
  return proto;
}

/** Built-in prototypes for primitive-valued signals. */
const NumProto = makeSignalProto({
  linear: {
    add: (a: number, b: number) => a + b,
    sub: (a: number, b: number) => a - b,
    scale: (a: number, k: number) => a * k,
  },
  lerp: (a: number, b: number, t: number) => a + (b - a) * t,
  metric: (a: number, b: number) => Math.abs(a - b),
  equals: (a: number, b: number) => a === b,
});
Object.defineProperty(NumProto, "type", { value: "Num", configurable: true });

const StrProto = makeSignalProto({ equals: (a: string, b: string) => a === b });
Object.defineProperty(StrProto, "type", { value: "Str", configurable: true });

const BoolProto = makeSignalProto({
  equals: (a: boolean, b: boolean) => a === b,
});
Object.defineProperty(BoolProto, "type", { value: "Bool", configurable: true });

function primitiveProtoFor(v: any): any {
  if (typeof v === "number") return NumProto;
  if (typeof v === "string") return StrProto;
  if (typeof v === "boolean") return BoolProto;
  return null;
}

/** Construct a raw signal with the right primitive prototype attached. */
export function signal<T>(initial: T): Cell<T> {
  const inner = alienSignal(initial);
  const cell: any = function (...args: any[]) {
    if (args.length === 0) return inner();
    inner(args[0]);
    return undefined;
  };
  const proto = primitiveProtoFor(initial) ?? makeSignalProto();
  Object.setPrototypeOf(cell, proto);
  delete cell.name;
  return cell as Cell<T>;
}

/** Construct a writable derived signal: read via getter, write routes through setter. */
export function derived<T>(getter: () => T, setter: (v: T) => void): Cell<T> {
  const c = alienComputed(getter);
  const cell: any = function (...args: any[]) {
    if (args.length === 0) return c();
    setter(args[0]);
    return undefined;
  };
  const proto = makeSignalProto();
  Object.defineProperty(proto, "type", {
    value: "Derived",
    configurable: true,
  });
  Object.setPrototypeOf(cell, proto);
  delete cell.name;
  return cell as Cell<T>;
}

/** Construct a read-only computed signal. */
export function computed<T>(getter: () => T): Cell<T> {
  const c = alienComputed(getter);
  const cell: any = function (...args: any[]) {
    if (args.length === 0) return c();
    throw new Error("cannot write to a computed signal");
  };
  const proto = makeSignalProto();
  Object.defineProperty(proto, "type", {
    value: "Computed",
    configurable: true,
  });
  Object.setPrototypeOf(cell, proto);
  delete cell.name;
  return cell as Cell<T>;
}

/** Convenience: tracked effect. */
export function effect(fn: () => void | (() => void)): () => void {
  return alienEffect(fn);
}

/** Convenience: batch writes. */
export function batch<R>(fn: () => R): R {
  startBatch();
  try {
    return fn();
  } finally {
    endBatch();
  }
}

// ─── struct(cfg) — the main construction ─────────────────────────────────

/** Detect if a value is a TypeProto: a constructor whose OWN properties include `type` and `traits`. */
function isTypeProto(v: any): boolean {
  return (
    typeof v === "function" &&
    Object.prototype.hasOwnProperty.call(v, "traits") &&
    typeof v.type === "string"
  );
}

/** Detect if a value is a cell instance: callable whose PROTOTYPE is a TypeProto. */
function isCell(v: any): boolean {
  if (typeof v !== "function") return false;
  if (isTypeProto(v)) return false; // it's the type itself, not an instance
  const proto = Object.getPrototypeOf(v);
  return proto !== null && isTypeProto(proto);
}

export function struct<C extends StructConfig>(cfg: C): TypeProto<any> {
  const traits = cfg.traits ?? {};
  const valueSpec = cfg.value;

  // The prototype IS the factory.
  const proto: any = function Cell(initial?: any) {
    // ── Build the field signals based on the value form ──
    let fields: Record<string, SignalFn<any>> = {};
    let wholeRead: () => any;
    let wholeWrite: (v: any) => void;

    if (typeof valueSpec === "function" && !isTypeProto(valueSpec)) {
      // ── Form A: function value (user-constructed signals) ──
      fields = (valueSpec as () => Record<string, SignalFn<any>>)();
      if (initial && typeof initial === "object") {
        for (const k of Object.keys(initial)) {
          if (k in fields) fields[k](initial[k]);
        }
      }
      const keys = Object.keys(fields);
      wholeRead = () => {
        const out: any = {};
        for (const k of keys) out[k] = fields[k]();
        return out;
      };
      wholeWrite = (v: any) => {
        for (const k of keys) if (k in v) fields[k](v[k]);
      };
    } else if (
      valueSpec !== null &&
      typeof valueSpec === "object" &&
      Object.keys(valueSpec).some((k) => {
        const v = (valueSpec as any)[k];
        return isTypeProto(v) || isCell(v);
      })
    ) {
      // ── Form B: composite literal — at least one entry is a struct type/instance ──
      // Each entry is one of:
      //   - a TypeProto (Vec): construct a sub-cell with Vec's defaults
      //   - a cell instance (Vec({x:1,y:1})): use this as the default; spec says
      //     "construct a fresh sub-cell of this type with this value as initial"
      //   - a primitive value (1, "hi"): primitive field
      // Each typed entry becomes a sub-cell. Primitive entries become signals.
      const spec = valueSpec as Record<string, any>;
      const keys = Object.keys(spec);
      for (const k of keys) {
        const entry = spec[k];
        const init = initial && k in initial ? initial[k] : undefined;
        if (isTypeProto(entry)) {
          // Use the type's own default; the cell becomes a sub-cell.
          fields[k] = (entry as any)(init);
        } else if (isCell(entry)) {
          // Spec carries a custom default: construct a new sub-cell of the
          // same type, initialized with the spec cell's current value
          // (overridable by `initial`).
          const typeProto = Object.getPrototypeOf(entry);
          const defaultVal = (entry as any)();
          fields[k] = (typeProto as any)(
            init !== undefined ? init : defaultVal,
          );
        } else {
          // Primitive
          fields[k] = signal(init !== undefined ? init : entry);
        }
      }
      wholeRead = () => {
        const out: any = {};
        for (const k of keys) out[k] = fields[k]();
        return out;
      };
      wholeWrite = (v: any) => {
        for (const k of keys) if (k in v) fields[k](v[k]);
      };
    } else if (valueSpec !== null && typeof valueSpec === "object") {
      // ── Form C: pure-primitive literal — synthesize ONE signal with lenses ──
      // This is the Vec case: cheap construction, cheap whole-value reads,
      // per-field writes invalidate the whole signal.
      const defaults = valueSpec as Record<string, any>;
      const keys = Object.keys(defaults);
      const merged = { ...defaults, ...(initial ?? {}) };
      const wholeSig = alienSignal({ ...merged });
      for (const k of keys) {
        // Each field is a writable derived (a lens) over the whole signal.
        fields[k] = derived(
          () => (wholeSig() as any)[k],
          (v: any) => {
            const cur = wholeSig() as any;
            wholeSig({ ...cur, [k]: v });
          },
        );
      }
      wholeRead = () => wholeSig();
      wholeWrite = (v: any) => {
        const cur = wholeSig() as any;
        wholeSig({ ...cur, ...v });
      };
    } else {
      // ── Form D: primitive scalar literal (e.g., value: 0) ──
      const init = initial !== undefined ? initial : valueSpec;
      const sig = signal(init);
      // No named fields; the cell itself is the signal.
      wholeRead = () => sig();
      wholeWrite = (v: any) => sig(v);
    }

    // Build the cell callable.
    const cell: any = function (...args: any[]) {
      if (args.length === 0) return wholeRead();
      wholeWrite(args[0]);
      return undefined;
    };
    Object.setPrototypeOf(cell, proto);
    delete cell.name;

    // Attach the field signals as own properties (per-instance).
    // Setter sugar: cell.x = signal → bind; cell.x = value → write.
    for (const k of Object.keys(fields)) {
      if (RESERVED.has(k)) throw new Error(`field name "${k}" is reserved`);
      const fieldSig = fields[k];
      let activeBind: (() => void) | null = null;
      Object.defineProperty(cell, k, {
        get() {
          return fieldSig;
        },
        set(rhs: any) {
          if (activeBind) {
            activeBind();
            activeBind = null;
          }
          if (typeof rhs === "function" && "type" in (rhs as any)) {
            activeBind = (fieldSig as any).bind(rhs);
          } else {
            fieldSig(rhs);
          }
        },
        enumerable: true,
        configurable: true,
      });
    }

    return cell;
  };

  // Install type identity and traits on the prototype.
  Object.defineProperty(proto, "type", { value: cfg.type, configurable: true });
  proto.traits = traits;

  // Bind/mirror on cells go through field signals; the cell-level bind would
  // be for whole-value sync. Make the cell-level bind a whole-value bind via
  // the cell's call protocol.
  proto.bind = function (this: any, other: any) {
    const dispose = alienEffect(() => {
      this(other());
    });
    return dispose;
  };
  proto.mirror = function (this: any, other: any) {
    let mirroring = false;
    const d1 = alienEffect(() => {
      if (mirroring) return;
      const v = other();
      mirroring = true;
      try {
        this(v);
      } finally {
        mirroring = false;
      }
    });
    const d2 = alienEffect(() => {
      if (mirroring) return;
      const v = this();
      mirroring = true;
      try {
        other(v);
      } finally {
        mirroring = false;
      }
    });
    return () => {
      d1();
      d2();
    };
  };

  // Traits are NOT lifted to method names. Access via cell.traits.linear.add(a, b)
  // or via free-function dispatchers. Keep the surface predictable.

  // User methods.
  if (cfg.methods) {
    for (const [k, fn] of Object.entries(cfg.methods)) {
      if (RESERVED.has(k)) throw new Error(`method name "${k}" is reserved`);
      Object.defineProperty(proto, k, {
        value: fn,
        writable: true,
        configurable: true,
      });
    }
  }

  // User getters.
  if (cfg.getters) {
    for (const [k, fn] of Object.entries(cfg.getters)) {
      if (RESERVED.has(k)) throw new Error(`getter name "${k}" is reserved`);
      Object.defineProperty(proto, k, { get: fn, configurable: true });
    }
  }

  return proto as TypeProto<any>;
}

// ─── Composite trait helpers (explicit derive, not auto-magic) ───────────

export function compositeLerp<T extends Record<string, any>>(
  fields: Record<keyof T, TypeProto<any> | "num">,
): (a: T, b: T, t: number) => T {
  const entries = Object.entries(fields) as [string, TypeProto<any> | "num"][];
  return (a, b, t) => {
    const out: any = {};
    for (const [k, fp] of entries) {
      if (fp === "num") out[k] = a[k] + (b[k] - a[k]) * t;
      else out[k] = (fp as any).traits.lerp(a[k], b[k], t);
    }
    return out;
  };
}

export function compositeLinear<T extends Record<string, any>>(
  fields: Record<keyof T, TypeProto<any> | "num">,
): { add(a: T, b: T): T; sub(a: T, b: T): T; scale(a: T, k: number): T } {
  const entries = Object.entries(fields) as [string, TypeProto<any> | "num"][];
  return {
    add: (a, b) => {
      const out: any = {};
      for (const [k, fp] of entries)
        out[k] =
          fp === "num"
            ? a[k] + b[k]
            : (fp as any).traits.linear.add(a[k], b[k]);
      return out;
    },
    sub: (a, b) => {
      const out: any = {};
      for (const [k, fp] of entries)
        out[k] =
          fp === "num"
            ? a[k] - b[k]
            : (fp as any).traits.linear.sub(a[k], b[k]);
      return out;
    },
    scale: (a, k) => {
      const out: any = {};
      for (const [kk, fp] of entries)
        out[kk] =
          fp === "num" ? a[kk] * k : (fp as any).traits.linear.scale(a[kk], k);
      return out;
    },
  };
}

export function compositeMetric<T extends Record<string, any>>(
  fields: Record<keyof T, TypeProto<any> | "num">,
): (a: T, b: T) => number {
  const entries = Object.entries(fields) as [string, TypeProto<any> | "num"][];
  return (a, b) => {
    let sumSq = 0;
    for (const [k, fp] of entries) {
      const d =
        fp === "num"
          ? Math.abs(a[k] - b[k])
          : (fp as any).traits.metric(a[k], b[k]);
      sumSq += d * d;
    }
    return Math.sqrt(sumSq);
  };
}
