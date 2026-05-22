// hsl.ts (spike) — user-defined value class. Demonstrates the
// authoring story end-to-end: 3 numeric fields, full trait support,
// invertible methods, factory.

import { Signal, type SignalOptions, type Val, valFn } from "../signal";
import { type Linear, traits } from "../traits";
import { Num } from "./num";
import { field, type Wr, type Writable } from "./writable";

type V = { h: number; s: number; l: number };

const hslAdd = (a: V, b: V): V => ({ h: a.h + b.h, s: a.s + b.s, l: a.l + b.l });
const hslSub = (a: V, b: V): V => ({ h: a.h - b.h, s: a.s - b.s, l: a.l - b.l });
const hslScale = (a: V, k: number): V => ({ h: a.h * k, s: a.s * k, l: a.l * k });
const hslLerp = (a: V, b: V, t: number): V => ({
  h: a.h + (b.h - a.h) * t,
  s: a.s + (b.s - a.s) * t,
  l: a.l + (b.l - a.l) * t,
});
const linearImpl: Linear<V> = { add: hslAdd, sub: hslSub, scale: hslScale };

export class Hsl extends Signal<V> {
  static traits = traits<V>()({
    linear: linearImpl,
    lerp: hslLerp,
    metric: (a: V, b: V) => Math.abs(a.h - b.h) + Math.abs(a.s - b.s) + Math.abs(a.l - b.l),
    equals: (a: V, b: V) => a.h === b.h && a.s === b.s && a.l === b.l,
  });

  declare readonly _writable: Wr<Hsl>;

  constructor(v: V = { h: 0, s: 0, l: 0 }, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  add(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(v => hslAdd(v, bf()), n => hslSub(n, bf()));
  }
  scale(k: Val<number>): this {
    const kf = valFn(k);
    return this.through(v => hslScale(v, kf()), n => hslScale(n, 1 / kf()));
  }

  get h() {
    return field(this, "h", Num);
  }
  get s() {
    return field(this, "s", Num);
  }
  get l() {
    return field(this, "l", Num);
  }
}
export interface Hsl {
  readonly constructor: typeof Hsl;
  get value(): V;
}

export function hsl(h = 0, s = 0, l = 0): Writable<Hsl> {
  return new Hsl({ h, s, l }) as Writable<Hsl>;
}
