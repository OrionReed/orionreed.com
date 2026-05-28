// num.ts — reactive scalar (merge-prototype variant).
//
// Stripped of anim/tween/Bool predicate-bridges from the canonical
// `signals/values/num.ts` to keep this prototype self-contained.
// The invertible algebra (add/sub/scale/affine/clamp/quantize/cyclic)
// is identical — those are what we test merges against.

import { type Init, reader, Signal, type Val, type Writable } from "./signal";
import type { Linear, Pack, TraitDict } from "./traits";

type V = number;

export const add = (a: V, b: V) => a + b;
export const sub = (a: V, b: V) => a - b;
export const scale = (a: V, k: number) => a * k;
export const lerp = (a: V, b: V, t: number) => a + (b - a) * t;
export const metric = (a: V, b: V) => Math.abs(a - b);
export const equals = (a: V, b: V) => a === b;

const linearImpl: Linear<V> = { add, sub, scale };
const packImpl: Pack<V> = {
  dim: 1,
  read: (v, a, o) => {
    a[o] = v;
  },
  write: (a, o) => a[o]!,
};

export class Num extends Signal<V> {
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
    pack: packImpl,
  } satisfies TraitDict<V>;
  declare readonly _t: typeof Num.traits;

  constructor(v: V = 0) {
    super(v, { equals });
  }

  add(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => v + bf(),
      n => n - bf(),
    );
  }
  sub(b: Val<V>): this {
    const bf = reader(b);
    return this.lens(
      v => v - bf(),
      n => n + bf(),
    );
  }
  scale(k: Val<number>): this {
    const kf = reader(k);
    return this.lens(
      v => v * kf(),
      n => n / kf(),
    );
  }
  affine(k: Val<number>, off: Val<number>): this {
    const kf = reader(k);
    const of = reader(off);
    return this.lens(
      v => v * kf() + of(),
      n => (n - of()) / kf(),
    );
  }
  clamp(lo: Val<V>, hi: Val<V>): this {
    const lf = reader(lo);
    const hf = reader(hi);
    const c = (v: V) => {
      const l = lf(),
        h = hf();
      return v < l ? l : v > h ? h : v;
    };
    return this.lens(c, c);
  }
  quantize(step: Val<number>): this {
    const sf = reader(step);
    const q = (v: V) => {
      const s = sf();
      return Math.round(v / s) * s;
    };
    return this.lens(q, q);
  }
  cyclic(period: Val<number>): this {
    const pf = reader(period);
    return this.lens(
      v => v,
      (v, s) => {
        const p = pf();
        const delta = v - s;
        return s + delta - p * Math.round(delta / p);
      },
    );
  }
}

export function num(v: Init<Num> = 0): Writable<Num> {
  if (v instanceof Num) return v as Writable<Num>;
  return new Num(v) as Writable<Num>;
}
