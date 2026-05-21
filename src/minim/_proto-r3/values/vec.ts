// vec.ts — reactive 2D point.
//
// Same shape as num.ts: three concrete classes (VecSignal /
// VecComputed / VecLens) share method bodies through two prototype
// assignments (readable vs writable). Field lenses (`x`, `y`)
// auto-promote to writable when the receiver is writable; they
// return the read-only NumComputed when the receiver is RO.

import { Node, type NodeOptions, type Val } from "../node";
import { Signal, Computed, Lens } from "../signal";
import { type TraitDict, type Linear } from "../traits";
import { applyOp1, applyOp2, type Op } from "../ops";
import { NumComputed, NumLens } from "./num";
import type { Num } from "./num";

// ─── Pure value-space functions ────────────────────────────────────

export type V = { x: number; y: number };

export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
export const lerp = (a: V, b: V, t: number): V => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const metric = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y);
export const equals = (a: V, b: V) => a === b || (a.x === b.x && a.y === b.y);

export const normalize = (v: V): V => {
  const m = Math.hypot(v.x, v.y);
  return m === 0 ? { x: 0, y: 0 } : { x: v.x / m, y: v.y / m };
};
export const perp = (v: V): V => ({ x: v.y, y: -v.x });

const linearImpl: Linear<V> = { add, sub, scale };

const addOp:    Op<V, [V]>              = { fwd: add, bwd: sub };
const subOp:    Op<V, [V]>              = { fwd: sub, bwd: add };
const scaleOp:  Op<V, [number]>         = { fwd: scale, bwd: (v, k) => scale(v, 1 / k) };
const offsetOp: Op<V, [number, number]> = {
  fwd: (v, dx, dy) => ({ x: v.x + dx, y: v.y + dy }),
  bwd: (n, dx, dy) => ({ x: n.x - dx, y: n.y - dy }),
};

// ─── Shared method tables ─────────────────────────────────────────

type AnyVec = VecSignal | VecComputed | VecLens;
type AnyVecWritable = VecSignal | VecLens;

function val<T>(v: Val<T>): T {
  return (v instanceof Node ? v.value : typeof v === "function" ? (v as () => T)() : v) as T;
}

// Shared *methods* (no field-lens getters here — those are defined on
// each concrete class because getters can't carry `this` parameters).
const readable = {
  normalize(this: AnyVec): VecComputed {
    return new VecComputed(() => normalize(this.value));
  },
  perp(this: AnyVec): VecComputed {
    return new VecComputed(() => perp(this.value));
  },
  lerp(this: AnyVec, b: Val<V>, t: Val<number>): VecComputed {
    return new VecComputed(() => lerp(this.value, val(b), val(t)));
  },
  distance(this: AnyVec, other: Val<V>): NumComputed {
    return new NumComputed(() => metric(this.value, val(other)));
  },
};

const writable = {
  ...readable,
  add(this: AnyVecWritable, b: Val<V>): VecLens { return applyOp1(this, addOp, b, VecLens) },
  sub(this: AnyVecWritable, b: Val<V>): VecLens { return applyOp1(this, subOp, b, VecLens) },
  scale(this: AnyVecWritable, k: Val<number>): VecLens { return applyOp1(this, scaleOp, k, VecLens) },
  offset(this: AnyVecWritable, dx: Val<number>, dy: Val<number>): VecLens {
    return applyOp2(this, offsetOp, dx, dy, VecLens);
  },
};

// Field-lens descriptor helpers
const roField = (key: keyof V) => ({
  get(this: AnyVec) { return this.field(key, (g) => new NumComputed(g)) },
  configurable: true, enumerable: false,
});
const rwField = (key: keyof V) => ({
  get(this: AnyVecWritable) { return this.field(key, (g, s) => new NumLens(g, s)) },
  configurable: true, enumerable: false,
});
const magnitudeField = () => ({
  get(this: AnyVec) {
    return this.memo("magnitude", () =>
      new NumComputed(() => Math.hypot(this.value.x, this.value.y)),
    );
  },
  configurable: true, enumerable: false,
});

// ─── Concrete classes ──────────────────────────────────────────────

const TRAITS: Required<TraitDict<V>> = { linear: linearImpl, lerp, metric, equals };

export class VecSignal extends Signal<V> {
  static traits = TRAITS;
  constructor(v: V = { x: 0, y: 0 }, opts?: NodeOptions<V>) { super(v, opts) }
  declare add: (b: Val<V>) => VecLens;
  declare sub: (b: Val<V>) => VecLens;
  declare scale: (k: Val<number>) => VecLens;
  declare offset: (dx: Val<number>, dy: Val<number>) => VecLens;
  declare normalize: () => VecComputed;
  declare perp: () => VecComputed;
  declare lerp: (b: Val<V>, t: Val<number>) => VecComputed;
  declare distance: (other: Val<V>) => NumComputed;
  declare readonly x: NumLens;
  declare readonly y: NumLens;
  declare readonly magnitude: NumComputed;
}
export interface VecSignal { readonly constructor: typeof VecSignal }
Object.assign(VecSignal.prototype, writable);
Object.defineProperties(VecSignal.prototype, {
  x: rwField("x"), y: rwField("y"), magnitude: magnitudeField(),
});

export class VecComputed extends Computed<V> {
  static traits = TRAITS;
  declare normalize: () => VecComputed;
  declare perp: () => VecComputed;
  declare lerp: (b: Val<V>, t: Val<number>) => VecComputed;
  declare distance: (other: Val<V>) => NumComputed;
  declare readonly x: NumComputed;
  declare readonly y: NumComputed;
  declare readonly magnitude: NumComputed;
}
export interface VecComputed { readonly constructor: typeof VecComputed }
Object.assign(VecComputed.prototype, readable);
Object.defineProperties(VecComputed.prototype, {
  x: roField("x"), y: roField("y"), magnitude: magnitudeField(),
});

export class VecLens extends Lens<V> {
  static traits = TRAITS;
  declare add: (b: Val<V>) => VecLens;
  declare sub: (b: Val<V>) => VecLens;
  declare scale: (k: Val<number>) => VecLens;
  declare offset: (dx: Val<number>, dy: Val<number>) => VecLens;
  declare normalize: () => VecComputed;
  declare perp: () => VecComputed;
  declare lerp: (b: Val<V>, t: Val<number>) => VecComputed;
  declare distance: (other: Val<V>) => NumComputed;
  declare readonly x: NumLens;
  declare readonly y: NumLens;
  declare readonly magnitude: NumComputed;
}
export interface VecLens { readonly constructor: typeof VecLens }
Object.assign(VecLens.prototype, writable);
Object.defineProperties(VecLens.prototype, {
  x: rwField("x"), y: rwField("y"), magnitude: magnitudeField(),
});

// ─── Public types & factories ──────────────────────────────────────

export type Vec = VecSignal | VecComputed | VecLens;
export type WritableVec = VecSignal | VecLens;

export function vec(x: Val<number> = 0, y: Val<number> = 0, opts?: NodeOptions<V>): VecSignal {
  const v = new VecSignal({ x: 0, y: 0 }, opts);
  v.x.bind(x);
  v.y.bind(y);
  return v;
}

export const Vec = {
  derive: (fn: () => V, opts?: NodeOptions<V>): VecComputed =>
    new VecComputed(fn, opts),
  lens: (get: () => V, set: (v: V) => void, opts?: NodeOptions<V>): VecLens =>
    new VecLens(get, set, opts),
  [Symbol.hasInstance]: (v: unknown) =>
    v instanceof VecSignal || v instanceof VecComputed || v instanceof VecLens,
};

/** Vec at polar offset from `center`: `center + (r·cos a, r·sin a)`. */
export function polar(center: Val<V>, r: Val<number>, a: Val<number>): VecSignal {
  const out = new VecSignal();
  out.bind(() => {
    const c = val(center);
    const rv = val(r);
    const av = val(a);
    return { x: c.x + rv * Math.cos(av), y: c.y + rv * Math.sin(av) };
  });
  return out;
}
