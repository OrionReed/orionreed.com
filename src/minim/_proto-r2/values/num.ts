// num.ts — reactive scalar number.
//
// Eager methods on the class return either a `Num` (writable Lens) when
// the op is invertible, or `RO<Num>` (read-only Computed) when it isn't.
// Chain methods on `NumChain` only carry invertible ops — so
// `n.derive(c => c.add(b).scale(k))` is always a Lens.

import { Signal, computed, value, type Val, type SignalOptions, type RO } from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { type Op, applyOp1, Chain } from "../ops";

// Module-local value alias; not exported. Consumers use `Of<Num>` = number.
type V = number;

export const add = (a: V, b: V) => a + b;
export const sub = (a: V, b: V) => a - b;
export const scale = (a: V, k: number) => a * k;
export const lerp = (a: V, b: V, t: number) => a + (b - a) * t;
export const metric = (a: V, b: V) => Math.abs(a - b);
export const equals = (a: V, b: V) => a === b;

// ─── Invertible ops (shared between eager methods and chain) ────────

const addOp: Op<V, [V]> = { fwd: add, bwd: sub };
const subOp: Op<V, [V]> = { fwd: sub, bwd: add };
const scaleOp: Op<V, [number]> = {
  fwd: scale,
  bwd: (v, k) => scale(v, 1 / k),
};

const linearImpl: Linear<V> = { add, sub, scale };

export class Num extends Signal<V> {
  static traits: Required<TraitDict<V>> = { linear: linearImpl, lerp, metric, equals };

  constructor(v: V = 0, opts?: SignalOptions<V>) { super(v, opts); }

  // ── Invertible (Lens-returning) ──
  add(b: Val<V>): Num { return applyOp1(this, addOp, b, Num); }
  sub(b: Val<V>): Num { return applyOp1(this, subOp, b, Num); }
  scale(k: Val<number>): Num { return applyOp1(this, scaleOp, k, Num); }

  // ── Non-invertible (Computed-returning) ──
  clamp(lo: Val<V>, hi: Val<V>): RO<Num> {
    return computed(() => {
      const v = this.value, l = value(lo), h = value(hi);
      return v < l ? l : v > h ? h : v;
    }, Num) as RO<Num>;
  }

  derive(fn: (c: NumChain) => NumChain): Num {
    return fn(new NumChain()).toLens(this, Num);
  }
}

export interface Num { readonly constructor: typeof Num }

export class NumChain extends Chain<V> {
  add(b: Val<V>): this { return this.push1(addOp, b); }
  sub(b: Val<V>): this { return this.push1(subOp, b); }
  scale(k: Val<number>): this { return this.push1(scaleOp, k); }
}

/** Construct a Num; reactive source follows live via `.bind()`. */
export const num = (v: Val<V> = 0): Num => {
  const n = new Num();
  n.bind(v);
  return n;
};
