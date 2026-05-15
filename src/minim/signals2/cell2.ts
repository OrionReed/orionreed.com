// cell2.ts — minimal reactive struct system, v3.
//
// Design notes (re-stated cleanly after the notes.md pass):
//
//   • The Type IS the constructor function. There is NO separate Type
//     record. `Vec` is callable as factory; cells inherit from
//     `Vec.prototype`; static ops are own-props on Vec; instance
//     methods live on Vec.prototype. `typeOf(cell) === cell.constructor`.
//
//   • Flat ops, no grouping. `add`, `sub`, `scale`, `lerp`, `metric`,
//     `equals` are top-level config keys (each optional). Generic
//     dispatchers use whatever ops are present.
//
//   • Per-field signals always. `cell.x` is a real own-property
//     signal, stable identity, no lens-via-computed indirection. Avoids
//     the propagation glitch the experiment ran into.
//
//   • `follow` / `sync` are the binding combinators. Both return a
//     dispose function. NO setter sugar — `cell.x.follow(other)` is
//     the only spelling.
//
//   • Composite synthesis is one config line:
//         compose: ["add", "sub", "scale", "lerp", "metric", "equals"]
//     The framework walks `value`, builds each named composite from the
//     field types. User-supplied ops always win.
//
//   • Reserved-name guard is shared util. Brand symbol makes Type/cell
//     detection nominal.
//
//   • No `cell.type` property. Code that needs the type uses
//     `cell.constructor` or `typeOf(cell)` (alias for clarity).

import {
  signal as alienSignal,
  computed as alienComputed,
  effect as alienEffect,
  setActiveSub,
  startBatch,
  endBatch,
  type SignalFn,
} from "./engine";

// ── Public types ────────────────────────────────────────────────────

export type { SignalFn };

/** A reactive cell. `c()` reads (tracking), `c(v)` writes, `peek()`
 *  reads untracked, `follow`/`sync` install bindings. */
export type Cell<T> = SignalFn<T> & {
  peek(): T;
  follow(other: SignalFn<T>): () => void;
  sync(other: SignalFn<T>): () => void;
};

export type RO<T> = {
  (): T;
  peek(): T;
};

export type Val<T> = T | (() => T);

/** Well-known op names. Generics dispatch on these. */
export type OpName = "add" | "sub" | "scale" | "lerp" | "metric" | "equals";

// ── Brand ───────────────────────────────────────────────────────────

const BRAND = Symbol.for("minim.struct");

/** A struct Type: callable factory + capability bag + cell prototype.
 *  Vec/Num/Transform are values of this shape. */
export interface Type<T = any> {
  readonly tag: string;
  readonly value: any;
  readonly add?: (a: T, b: T) => T;
  readonly sub?: (a: T, b: T) => T;
  readonly scale?: (a: T, k: number) => T;
  readonly lerp?: (a: T, b: T, t: number) => T;
  readonly metric?: (a: T, b: T) => number;
  readonly equals?: (a: T, b: T) => boolean;
  readonly prototype: any;
  (init?: Partial<T>): Cell<T>;
  /** Type guard. */
  is(v: unknown): v is Cell<T>;
}

/** What the user passes to `struct({...})`. Plain object literal. */
export interface StructDef<T = any> {
  tag: string;
  /** Either a plain-value spec `{ x: 0, y: 0 }`, a composite spec
   *  `{ translate: Vec, scale: Vec({x:1,y:1}), opacity: 1 }`, or a
   *  function `() => ({ ... })` returning user-built signals. */
  value: any;
  add?: (a: T, b: T) => T;
  sub?: (a: T, b: T) => T;
  scale?: (a: T, k: number) => T;
  lerp?: (a: T, b: T, t: number) => T;
  metric?: (a: T, b: T) => number;
  equals?: (a: T, b: T) => boolean;
  /** Names to synthesize from `value`'s typed fields. */
  compose?: readonly OpName[] | true;
  /** Pure functions `(self: T, ...args) => R`. Lifted as instance
   *  methods `cell.method(...args): RO<R>`. */
  methods?: Record<string, (self: T, ...args: any[]) => any>;
  /** Functions `(this: cell) => R`. Lifted as lazy instance getters
   *  with caching after first read. */
  getters?: Record<string, (this: any) => any>;
}

// ── Reserved-name guard ─────────────────────────────────────────────

/** Names that would clash with Function.prototype intrinsics or
 *  framework methods on cells. Checked at struct definition time AND
 *  at cell construction (for field names). */
export const RESERVED = new Set<string>([
  "peek", "follow", "sync", "constructor",
  "length", "name", "caller", "arguments", "prototype",
  "call", "apply", "toString", "bind",
]);

/** Throw if any key in `names` is in RESERVED. `kind` is for error msg. */
function guardReserved(tag: string, kind: string, names: Iterable<string>): void {
  for (const n of names) {
    if (RESERVED.has(n)) {
      throw new Error(`struct(${tag}): ${kind} "${n}" is reserved.`);
    }
  }
}

// ── Bare proto for raw signals ──────────────────────────────────────
//
// Carries peek/follow/sync. Every reactive cell — bare or typed —
// eventually reaches this proto via its chain.

const bareProto: any = Object.create(Function.prototype);

bareProto.peek = function (this: SignalFn<unknown>) {
  const prev = setActiveSub(undefined);
  try { return (this as () => unknown)(); }
  finally { setActiveSub(prev); }
};

bareProto.follow = function (this: SignalFn<any>, other: SignalFn<any>) {
  const self = this;
  return alienEffect(() => { self(other()); });
};

bareProto.sync = function (this: SignalFn<any>, other: SignalFn<any>) {
  const self = this;
  let busy = false;
  // Read first, then guard — bailing early would drop the alien-signals
  // dep registration and silently break the binding.
  const dA = alienEffect(() => {
    const v = self();
    if (busy) return;
    busy = true;
    try { other(v); } finally { busy = false; }
  });
  const dB = alienEffect(() => {
    const v = other();
    if (busy) return;
    busy = true;
    try { self(v); } finally { busy = false; }
  });
  return () => { dA(); dB(); };
};

/** Raw writable signal. */
export function signal<T>(initial: T): Cell<T> {
  const fn = alienSignal(initial) as unknown as Cell<T>;
  Object.setPrototypeOf(fn, bareProto);
  return fn;
}

/** Read-only computed signal. */
export function computed<T>(fn: () => T): RO<T> {
  const c = alienComputed(fn) as unknown as RO<T>;
  Object.setPrototypeOf(c, bareProto);
  return c;
}

/** Writable derived signal — reads via `read`, writes via `write`. */
export function derived<T>(read: () => T, write: (v: T) => void): Cell<T> {
  const r = alienComputed(read);
  const fn: any = function (...args: any[]) {
    if (args.length === 0) return r();
    write(args[0]);
  };
  Object.setPrototypeOf(fn, bareProto);
  return fn as Cell<T>;
}

/** Tracked effect. Returns dispose. */
export function effect(fn: () => void | (() => void)): () => void {
  return alienEffect(fn);
}

/** Run writes in a single notification batch. */
export function batch<R>(fn: () => R): R {
  startBatch();
  try { return fn(); }
  finally { endBatch(); }
}

// ── Type / cell detection (nominal via brand) ───────────────────────

function isType(v: unknown): v is Type {
  return typeof v === "function" && (v as any)[BRAND] === "type";
}

function isAnyCell(v: unknown): v is Cell<any> {
  if (typeof v !== "function") return false;
  const proto = Object.getPrototypeOf(v);
  return proto != null && proto[BRAND] === "proto";
}

/** Return the Type that built `cell`, or undefined for bare cells. */
export function typeOf<T>(cell: SignalFn<T>): Type<T> | undefined {
  return (cell as any).constructor as Type<T> | undefined;
}

// ── Primitive (number) ops for use inside composite synthesis ───────

const NumOps = {
  add: (a: number, b: number) => a + b,
  sub: (a: number, b: number) => a - b,
  scale: (a: number, k: number) => a * k,
  lerp: (a: number, b: number, t: number) => a + (b - a) * t,
  metric: (a: number, b: number) => Math.abs(a - b),
  equals: (a: number, b: number) => a === b,
} as const;

const ALL_OPS: readonly OpName[] = ["add", "sub", "scale", "lerp", "metric", "equals"];

// ── Composite synthesis ─────────────────────────────────────────────
//
// Walk `value` and, for each requested op name, build a function that
// applies the op per-field. Typed fields delegate to their type's op;
// primitive fields use NumOps. Throws at struct-definition time if a
// field can't supply the requested op.

function synthOps(
  tag: string,
  valueSpec: any,
  cfg: StructDef,
): Partial<Record<OpName, any>> {
  const want = cfg.compose === true ? ALL_OPS : (cfg.compose ?? []);
  if (want.length === 0) return {};
  if (valueSpec == null || typeof valueSpec !== "object") return {};

  const entries = Object.entries(valueSpec);
  // For each field, resolve which op source to use.
  const fieldSources: Array<{ key: string; source: any; isPrim: boolean }> = [];
  for (const [k, entry] of entries) {
    if (isType(entry)) {
      fieldSources.push({ key: k, source: entry, isPrim: false });
    } else if (isAnyCell(entry)) {
      fieldSources.push({ key: k, source: typeOf(entry as Cell<any>), isPrim: false });
    } else {
      fieldSources.push({ key: k, source: NumOps, isPrim: true });
    }
  }

  const out: Partial<Record<OpName, any>> = {};
  for (const opName of want) {
    if (cfg[opName] !== undefined) continue;  // user-supplied wins

    // Check every field can supply this op.
    for (const fs of fieldSources) {
      if (fs.source[opName] === undefined) {
        throw new Error(
          `struct(${tag}): cannot compose "${opName}" — field "${fs.key}" ` +
          `has no ${opName}.`,
        );
      }
    }

    // Build the composite function based on op shape.
    out[opName] = buildComposite(opName, fieldSources);
  }
  return out;
}

function buildComposite(
  opName: OpName,
  fields: Array<{ key: string; source: any }>,
): any {
  const ks = fields.map(f => f.key);
  const fns = fields.map(f => f.source[opName]);
  switch (opName) {
    case "add":
    case "sub":
      return (a: any, b: any) => {
        const o: any = {};
        for (let i = 0; i < ks.length; i++) o[ks[i]] = fns[i](a[ks[i]], b[ks[i]]);
        return o;
      };
    case "scale":
      return (a: any, k: number) => {
        const o: any = {};
        for (let i = 0; i < ks.length; i++) o[ks[i]] = fns[i](a[ks[i]], k);
        return o;
      };
    case "lerp":
      return (a: any, b: any, t: number) => {
        const o: any = {};
        for (let i = 0; i < ks.length; i++) o[ks[i]] = fns[i](a[ks[i]], b[ks[i]], t);
        return o;
      };
    case "metric":
      return (a: any, b: any) => {
        let s = 0;
        for (let i = 0; i < ks.length; i++) {
          const d = fns[i](a[ks[i]], b[ks[i]]);
          s += d * d;
        }
        return Math.sqrt(s);
      };
    case "equals":
      return (a: any, b: any) => {
        for (let i = 0; i < ks.length; i++) {
          if (!fns[i](a[ks[i]], b[ks[i]])) return false;
        }
        return true;
      };
  }
}

// ── struct() — the factory ──────────────────────────────────────────

export function struct<C extends StructDef>(cfg: C): Type<any> {
  guardReserved(cfg.tag, "method", Object.keys(cfg.methods ?? {}));
  guardReserved(cfg.tag, "getter", Object.keys(cfg.getters ?? {}));

  // Type IS the constructor function. Callable as factory; carries
  // static ops as own-props; has its own `.prototype` for instance
  // methods that cells inherit.
  const Vec: any = function (init?: any): any {
    return constructCell(Vec, init);
  };

  // ── Static slots: identity, value-shape, ops ────────────────
  Vec.tag = cfg.tag;
  Vec.value = cfg.value;
  Vec[BRAND] = "type";
  // Copy user-supplied ops; fill from synthesis afterwards.
  for (const k of ALL_OPS) {
    if (cfg[k] !== undefined) Vec[k] = cfg[k];
  }
  // Synthesize composite ops from `value` where requested. Doesn't
  // overwrite user-supplied (synthOps already guards via `continue`).
  const synth = synthOps(cfg.tag, cfg.value, cfg);
  for (const k of Object.keys(synth) as OpName[]) {
    if (Vec[k] === undefined) Vec[k] = synth[k];
  }
  // Auto-default `equals` for object-valued types if not declared.
  // Important for change-detection on whole-value writes. For typed
  // fields, recursively compare via the field type's equals.
  if (Vec.equals === undefined && cfg.value && typeof cfg.value === "object") {
    Vec.equals = synthOps(cfg.tag, cfg.value, { ...cfg, compose: ["equals"] }).equals
      ?? defaultStructuralEquals(cfg.value);
  }

  // ── Instance prototype: peek/follow/sync, lifted methods/getters ──
  const proto: any = Object.create(bareProto);
  proto[BRAND] = "proto";
  proto.constructor = Vec;

  if (cfg.methods) {
    for (const [name, fn] of Object.entries(cfg.methods)) {
      proto[name] = function (this: () => any, ...args: any[]) {
        const self = this;
        return computed(() => fn(self(), ...args.map(unwrap)));
      };
    }
  }
  if (cfg.getters) {
    for (const [name, getter] of Object.entries(cfg.getters)) {
      Object.defineProperty(proto, name, {
        configurable: true,
        get(this: any) {
          const v = getter.call(this);
          // Cache as own-prop so subsequent reads are direct.
          Object.defineProperty(this, name, { value: v });
          return v;
        },
      });
    }
  }
  Vec.prototype = proto;

  // ── Type guard ──────────────────────────────────────────────
  Vec.is = function (v: unknown): v is Cell<any> {
    return isAnyCell(v) && Object.getPrototypeOf(v) === proto;
  };

  return Vec as Type<any>;
}

/** Default structural equals for an object value-shape: walks declared
 *  keys, compares with `===` (no nested type info). Used as final
 *  fallback when no `equals` declared and synthesis can't recurse. */
function defaultStructuralEquals(value: any): (a: any, b: any) => boolean {
  const keys = Object.keys(value);
  return (a, b) => {
    for (const k of keys) if (a[k] !== b[k]) return false;
    return true;
  };
}

// ── Cell construction ──────────────────────────────────────────────

function constructCell(Vec: any, init: any): any {
  const valueSpec = Vec.value;
  const fields: Record<string, SignalFn<any>> = {};
  let wholeRead: () => any;
  let wholeWrite: (v: any) => void;

  if (typeof valueSpec === "function" && !isType(valueSpec)) {
    // Form: function value — user-built signals.
    const built = (valueSpec as () => Record<string, SignalFn<any>>)();
    Object.assign(fields, built);
    if (init && typeof init === "object") {
      for (const k of Object.keys(init)) {
        if (k in fields) fields[k](init[k]);
      }
    }
    const keys = Object.keys(fields);
    wholeRead = () => {
      const out: any = {};
      for (const k of keys) out[k] = fields[k]();
      return out;
    };
    wholeWrite = (v: any) => {
      startBatch();
      try { for (const k of keys) if (k in v) fields[k](v[k]); }
      finally { endBatch(); }
    };
  } else if (valueSpec !== null && typeof valueSpec === "object") {
    // Form: object value — primitive and/or typed entries.
    const keys = Object.keys(valueSpec);
    guardReserved(Vec.tag, "field", keys);
    for (const k of keys) {
      const entry = valueSpec[k];
      const override = init && typeof init === "object" ? init[k] : undefined;
      if (isType(entry)) {
        fields[k] = (entry as any)(override);
      } else if (isAnyCell(entry)) {
        const subType = typeOf(entry) as Type<any>;
        if (!subType) throw new Error(`field "${k}": untyped cell as default`);
        fields[k] = subType(override ?? (entry as any).peek());
      } else {
        fields[k] = signal(override !== undefined ? override : entry);
      }
    }
    wholeRead = () => {
      const out: any = {};
      for (const k of keys) out[k] = fields[k]();
      return out;
    };
    wholeWrite = (v: any) => {
      startBatch();
      try { for (const k of keys) if (k in v) fields[k](v[k]); }
      finally { endBatch(); }
    };
  } else {
    // Scalar primitive — single signal under the hood. (Form D from
    // notes.md: kept because Num is useful as a typed scalar.)
    const inner = alienSignal(init !== undefined ? init : valueSpec);
    wholeRead = () => inner();
    wholeWrite = (v: any) => inner(v);
  }

  const cell: any = function (...args: any[]) {
    if (args.length === 0) return wholeRead();
    wholeWrite(args[0]);
  };
  Object.setPrototypeOf(cell, Vec.prototype);

  // Field signals as own-props.
  for (const k of Object.keys(fields)) {
    Object.defineProperty(cell, k, {
      value: fields[k],
      writable: false,
      configurable: false,
      enumerable: true,
    });
  }

  return cell;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Unwrap `Val<T>` to `T`. Callables (cells/thunks) invoked; literals
 *  returned as-is. */
export function unwrap<T>(v: Val<T>): T {
  return typeof v === "function" ? (v as () => T)() : v;
}
