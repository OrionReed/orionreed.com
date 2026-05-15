// cell3.ts — methods + traits split, no synthesis, no compose.
//
// Two bags, two purposes:
//
//   methods: { foo: (self, ...args) => R }    → lifted cell.foo(...args): RO<R>
//   traits:  { linear: {...}, lerp, metric }  → static on Type for generic dispatch
//
// Same function can appear in both — user references explicitly. Zero
// magic. Composites compose by writing JavaScript:
//
//   const add = (a: Tr, b: Tr): Tr => ({
//     translate: Vec.traits.linear.add(a.translate, b.translate),
//     scale:     Vec.traits.linear.add(a.scale, b.scale),
//     rotate:    a.rotate + b.rotate,
//     opacity:   a.opacity + b.opacity,
//   });
//   const Transform = struct({
//     tag: "Transform",
//     value: { translate: Vec, scale: Vec, rotate: 0, opacity: 1 },
//     traits: { linear: { add, sub, scale }, lerp, metric },
//   });

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

export type Cell<T, Cfg = unknown> = SignalFn<T> & CellBase<T> & CellSurface<T, Cfg>;

interface CellBase<T> {
  peek(): T;
  follow(other: SignalFn<T>): () => void;
  sync(other: SignalFn<T>): () => void;
}

type CellSurface<T, Cfg> = FieldsOf<Cfg> & MethodsOf<Cfg, T> & GettersOf<Cfg>;

type FieldsOf<Cfg> = Cfg extends { value: infer V }
  ? V extends Record<string, any>
    ? V extends Function ? {}
    : { readonly [K in keyof V]: Cell<FieldValueOf<V[K]>> }
  : {}
  : {};

type FieldValueOf<X> =
  X extends Type<infer U> ? U
  : X extends Cell<infer U> ? U
  : X;

type MethodsOf<Cfg, T> = Cfg extends { methods: infer M }
  ? { readonly [K in keyof M]: M[K] extends (self: T, ...args: infer A) => infer R
      ? (...args: A) => RO<R> : never }
  : {};

type GettersOf<Cfg> = Cfg extends { getters: infer G }
  ? { readonly [K in keyof G]: G[K] extends (this: any) => infer R ? R : never }
  : {};

export type RO<T> = (() => T) & { peek(): T };

export type Val<T> = T | (() => T);

export interface Type<T = any, Cfg = unknown> {
  readonly tag: string;
  readonly value: any;
  readonly traits: Cfg extends { traits: infer Tr } ? Tr : {};
  readonly prototype: any;
  (init?: ValueInit<Cfg>): Cell<T, Cfg>;
  is(v: unknown): v is Cell<T, Cfg>;
}

type ValueInit<Cfg> = Cfg extends { value: infer V }
  ? V extends Record<string, any> ? { [K in keyof V]?: FieldValueOf<V[K]> }
    : V
  : any;

type ValueOfRT<Cfg> = Cfg extends { value: infer V }
  ? V extends Record<string, any>
    ? V extends Function ? V : { [K in keyof V]: FieldValueOf<V[K]> }
    : V
  : never;

// ── Config shape ────────────────────────────────────────────────────

export interface StructDef<T = any> {
  tag: string;
  value: any;
  methods?: Record<string, (self: T, ...args: any[]) => any>;
  getters?: Record<string, (this: any) => any>;
  traits?: Record<string, any>;
}

// ── Reserved-name guard ─────────────────────────────────────────────

const RESERVED = new Set([
  "peek", "follow", "sync", "constructor",
  "length", "name", "caller", "arguments", "prototype",
  "call", "apply", "toString", "bind",
]);

function guardReserved(tag: string, kind: string, names: Iterable<string>): void {
  for (const n of names) {
    if (RESERVED.has(n)) throw new Error(`struct(${tag}): ${kind} "${n}" is reserved.`);
  }
}

// ── Brand & detection ───────────────────────────────────────────────

const BRAND = Symbol.for("minim.struct.v3");

function isType(v: unknown): boolean {
  return typeof v === "function" && (v as any)[BRAND] === "type";
}

function isAnyCell(v: unknown): boolean {
  if (typeof v !== "function") return false;
  const p = Object.getPrototypeOf(v);
  return p != null && p[BRAND] === "proto";
}

export function typeOf<T>(c: SignalFn<T>): Type<T> | undefined {
  return (c as any).constructor as Type<T> | undefined;
}

// ── Bare proto for raw signals ──────────────────────────────────────

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

// ── Primitives ──────────────────────────────────────────────────────

export function signal<T>(initial: T): Cell<T> {
  const fn = alienSignal(initial) as unknown as Cell<T>;
  Object.setPrototypeOf(fn, bareProto);
  return fn;
}

export function computed<T>(fn: () => T): RO<T> {
  const c = alienComputed(fn) as unknown as RO<T>;
  Object.setPrototypeOf(c, bareProto);
  return c;
}

export function derived<T>(read: () => T, write: (v: T) => void): Cell<T> {
  const r = alienComputed(read);
  const fn: any = function (...args: any[]) {
    if (args.length === 0) return r();
    write(args[0]);
  };
  Object.setPrototypeOf(fn, bareProto);
  return fn as Cell<T>;
}

export function effect(fn: () => void | (() => void)): () => void {
  return alienEffect(fn);
}

export function batch<R>(fn: () => R): R {
  startBatch();
  try { return fn(); }
  finally { endBatch(); }
}

export function unwrap<T>(v: Val<T>): T {
  return typeof v === "function" ? (v as () => T)() : v;
}

// ── struct() ─────────────────────────────────────────────────────────

export function struct<const Cfg extends StructDef>(
  cfg: Cfg,
): Type<ValueOfRT<Cfg>, Cfg> {
  guardReserved(cfg.tag, "method", Object.keys(cfg.methods ?? {}));
  guardReserved(cfg.tag, "getter", Object.keys(cfg.getters ?? {}));

  const Vec: any = function (init?: any) {
    return constructCell(Vec, init);
  };

  Vec.tag = cfg.tag;
  Vec.value = cfg.value;
  Vec.traits = cfg.traits ?? {};
  Vec[BRAND] = "type";

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
          Object.defineProperty(this, name, { value: v });
          return v;
        },
      });
    }
  }
  Vec.prototype = proto;

  Vec.is = function (v: unknown): boolean {
    return isAnyCell(v) && Object.getPrototypeOf(v) === proto;
  };

  return Vec as Type<ValueOfRT<Cfg>, Cfg>;
}

// ── Cell construction ───────────────────────────────────────────────

function constructCell(Vec: any, init: any): any {
  const valueSpec = Vec.value;
  const fields: Record<string, SignalFn<any>> = {};
  let read: () => any;
  let write: (v: any) => void;

  if (typeof valueSpec === "function" && !isType(valueSpec)) {
    // function-form value: user-built signals
    const built = (valueSpec as () => Record<string, SignalFn<any>>)();
    Object.assign(fields, built);
    if (init && typeof init === "object") {
      for (const k of Object.keys(init)) if (k in fields) fields[k](init[k]);
    }
    const keys = Object.keys(fields);
    read = () => {
      const o: any = {};
      for (const k of keys) o[k] = fields[k]();
      return o;
    };
    write = (v: any) => {
      startBatch();
      try { for (const k of keys) if (k in v) fields[k](v[k]); }
      finally { endBatch(); }
    };
  } else if (valueSpec != null && typeof valueSpec === "object") {
    const keys = Object.keys(valueSpec);
    guardReserved(Vec.tag, "field", keys);
    for (const k of keys) {
      const entry = valueSpec[k];
      const ov = init && typeof init === "object" ? init[k] : undefined;
      if (isType(entry)) {
        fields[k] = (entry as any)(ov);
      } else if (isAnyCell(entry)) {
        const t = typeOf(entry as any) as Type<any>;
        fields[k] = (t as any)(ov ?? (entry as any).peek());
      } else {
        fields[k] = signal(ov !== undefined ? ov : entry);
      }
    }
    read = () => {
      const o: any = {};
      for (const k of keys) o[k] = fields[k]();
      return o;
    };
    write = (v: any) => {
      startBatch();
      try { for (const k of keys) if (k in v) fields[k](v[k]); }
      finally { endBatch(); }
    };
  } else {
    const inner = alienSignal(init !== undefined ? init : valueSpec);
    read = () => inner();
    write = (v: any) => inner(v);
  }

  const cell: any = function (...args: any[]) {
    if (args.length === 0) return read();
    write(args[0]);
  };
  Object.setPrototypeOf(cell, Vec.prototype);
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
