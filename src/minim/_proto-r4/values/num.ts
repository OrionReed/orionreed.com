// num.ts — reactive scalar.

import {
  Signal, computed, lens as lensFactory,
  type Val, type SignalOptions as NodeOptions,
} from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { applyOp1, type Op } from "../ops";
import { type WritableNum } from "../promote";

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

export class Num extends Signal<V> {
  static traits: Required<TraitDict<V>> = { linear: linearImpl, lerp, metric, equals };
  constructor(v: V = 0, opts?: NodeOptions<V>) { super(v, opts) }

  add(b: Val<V>): Num    { return applyOp1(this, addOp,   b, Num) }
  sub(b: Val<V>): Num    { return applyOp1(this, subOp,   b, Num) }
  scale(k: Val<number>): Num { return applyOp1(this, scaleOp, k, Num) }
  clamp(lo: Val<V>, hi: Val<V>): Num {
    return computed(() => {
      const v = this.value;
      const l = lo instanceof Signal ? lo.value : typeof lo === "function" ? lo() : lo;
      const h = hi instanceof Signal ? hi.value : typeof hi === "function" ? hi() : hi;
      return v < l ? l : v > h ? h : v;
    }, Num);
  }

  static derive(fn: () => V): Num { return computed(fn, Num) }
  static lens(get: () => V, set: (v: V) => void): WritableNum {
    return lensFactory(get, set, Num) as unknown as WritableNum;
  }
  static is(v: unknown): v is Num { return v instanceof Num }
}
// Interface merge: the public Num type is read-only at `.value`. Writes
// require `WritableNum` (the Promote-lifted form). The runtime class
// IS writable — Promote hands back the same instance with the setter
// surfaced — but the bare class type defaults to RO so untyped
// consumers can't accidentally mutate a derived (RO) Num.
export interface Num {
  readonly constructor: typeof Num;
  get value(): V;
}

export function num(v: Val<V> = 0): WritableNum {
  const n = new Num();
  n.bind(v);
  return n as unknown as WritableNum;
}
