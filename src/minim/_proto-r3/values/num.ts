// num.ts — reactive scalar.
//
// Three concrete classes (NumSignal / NumComputed / NumLens) carry
// the three reactive flavours. A pair of mixin functions defines the
// shared method bodies *once* — `readable` for non-invertible ops
// (clamp, …) and `writable` for invertible ops (add/sub/scale).
//
// Public:
//   - `Num`              — union type: any flavour
//   - `WritableNum`      — union type: signal | lens flavours
//   - `num(v)`           — construct a writable source
//   - `Num.derive(fn)`   — construct a read-only computed Num
//   - `Num.lens(g, s)`   — construct a writable derived Num

import { Node, type NodeOptions, type Val } from "../node";
import { Signal, Computed, Lens } from "../signal";
import { type TraitDict, type Linear } from "../traits";
import { applyOp1, type Op } from "../ops";

// ─── Pure value-space functions (also serve as trait impls) ────────

type V = number;

export const add    = (a: V, b: V) => a + b;
export const sub    = (a: V, b: V) => a - b;
export const scale  = (a: V, k: number) => a * k;
export const lerp   = (a: V, b: V, t: number) => a + (b - a) * t;
export const metric = (a: V, b: V) => Math.abs(a - b);
export const equals = (a: V, b: V) => a === b;

const linearImpl: Linear<V> = { add, sub, scale };

const addOp:   Op<V, [V]>      = { fwd: add,   bwd: sub };
const subOp:   Op<V, [V]>      = { fwd: sub,   bwd: add };
const scaleOp: Op<V, [number]> = { fwd: scale, bwd: (v, k) => scale(v, 1 / k) };

// ─── Shared method tables (typed-pure-function form) ────────────────
//
// Each concrete class assigns these onto its prototype below. Using
// plain functions instead of mixin-class returns keeps V8 shapes
// monomorphic per primitive class and avoids the anonymous-class
// inference quirks that show up with classic mixins.

type AnyNumWritable = NumSignal | NumLens;
type AnyNum = NumSignal | NumComputed | NumLens;

const readable = {
  clamp(this: AnyNum, lo: Val<V>, hi: Val<V>): NumComputed {
    return new NumComputed(() => {
      const v = this.value;
      const l = lo instanceof Node ? lo.value : typeof lo === "function" ? lo() : lo;
      const h = hi instanceof Node ? hi.value : typeof hi === "function" ? hi() : hi;
      return v < l ? l : v > h ? h : v;
    });
  },
};

const writable = {
  ...readable,
  add(this: AnyNumWritable, b: Val<V>): NumLens { return applyOp1(this, addOp,   b, NumLens) },
  sub(this: AnyNumWritable, b: Val<V>): NumLens { return applyOp1(this, subOp,   b, NumLens) },
  scale(this: AnyNumWritable, k: Val<number>): NumLens { return applyOp1(this, scaleOp, k, NumLens) },
};

// ─── Concrete classes ──────────────────────────────────────────────

const TRAITS: Required<TraitDict<V>> = { linear: linearImpl, lerp, metric, equals };

export class NumSignal extends Signal<V> {
  static traits = TRAITS;
  constructor(v: V = 0, opts?: NodeOptions<V>) { super(v, opts) }
  declare add: (b: Val<V>) => NumLens;
  declare sub: (b: Val<V>) => NumLens;
  declare scale: (k: Val<number>) => NumLens;
  declare clamp: (lo: Val<V>, hi: Val<V>) => NumComputed;
}
export interface NumSignal { readonly constructor: typeof NumSignal }
Object.assign(NumSignal.prototype, writable);

export class NumComputed extends Computed<V> {
  static traits = TRAITS;
  declare clamp: (lo: Val<V>, hi: Val<V>) => NumComputed;
}
export interface NumComputed { readonly constructor: typeof NumComputed }
Object.assign(NumComputed.prototype, readable);

export class NumLens extends Lens<V> {
  static traits = TRAITS;
  declare add: (b: Val<V>) => NumLens;
  declare sub: (b: Val<V>) => NumLens;
  declare scale: (k: Val<number>) => NumLens;
  declare clamp: (lo: Val<V>, hi: Val<V>) => NumComputed;
}
export interface NumLens { readonly constructor: typeof NumLens }
Object.assign(NumLens.prototype, writable);

// ─── Public types & factories ──────────────────────────────────────

export type Num = NumSignal | NumComputed | NumLens;
export type WritableNum = NumSignal | NumLens;

/** Construct a writable Num backed by a signal source. */
export function num(v: Val<V> = 0, opts?: NodeOptions<V>): NumSignal {
  const n = new NumSignal(0, opts);
  n.bind(v);
  return n;
}

/** Class-static derive / lens — preferred over the bare `computed`/`lens`
 *  factories when the result should be typed as a Num. */
export const Num = {
  derive: (fn: () => V, opts?: NodeOptions<V>): NumComputed =>
    new NumComputed(fn, opts),
  lens:   (get: () => V, set: (v: V) => void, opts?: NodeOptions<V>): NumLens =>
    new NumLens(get, set, opts),
  /** Type-only marker (use as `v instanceof Num` via Symbol.hasInstance). */
  [Symbol.hasInstance]: (v: unknown) =>
    v instanceof NumSignal || v instanceof NumComputed || v instanceof NumLens,
};
