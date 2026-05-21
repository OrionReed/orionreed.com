// num.ts — reactive scalar.

import {
  Signal, computedCls, lensCls,
  type Val, type SignalOptions,
} from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { applyOp1, type Op } from "../ops";
import { type Writable, invertibles } from "../writable";

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
  // ── class-level config ─────────────────────────────────────────
  static traits: Required<TraitDict<V>> = { linear: linearImpl, lerp, metric, equals };
  static invertibles = invertibles<Num>()("add", "sub", "scale");

  // ── class-level constructors ───────────────────────────────────
  static derive(fn: () => V): Num { return computedCls(Num, fn) }
  static lens(g: () => V, s: (v: V) => void): Writable<Num> {
    return lensCls(Num, g, s) as unknown as Writable<Num>;
  }
  static is(v: unknown): v is Num { return v instanceof Num }

  // ── instance ───────────────────────────────────────────────────
  constructor(v: V = 0, opts?: SignalOptions<V>) { super(v, opts) }

  add(b: Val<V>): Num        { return applyOp1(this, addOp,   b, Num) }
  sub(b: Val<V>): Num        { return applyOp1(this, subOp,   b, Num) }
  scale(k: Val<number>): Num { return applyOp1(this, scaleOp, k, Num) }
  clamp(lo: Val<V>, hi: Val<V>): Num {
    return Num.derive(() => {
      const v = this.value;
      const l = lo instanceof Signal ? lo.value : typeof lo === "function" ? lo() : lo;
      const h = hi instanceof Signal ? hi.value : typeof hi === "function" ? hi() : hi;
      return v < l ? l : v > h ? h : v;
    });
  }
}
export interface Num {
  readonly constructor: typeof Num;
  get value(): V;
}

export function num(v: Val<V> = 0): Writable<Num> {
  const n = new Num() as unknown as Writable<Num>;
  n.bind(v);
  return n;
}
