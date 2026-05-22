// num.ts (spike) — Num authoring story.
//
// The pattern, end-to-end:
//   1. Pure value-space functions
//   2. `class Num extends Signal<V>` — runtime + RO type surface
//   3. `static traits = traits<V>()({ … })` — same as today
//   4. `declare readonly _writable: Wr<Num>` — registry brand
//   5. Methods type as `: this` (invertible, propagates writability)
//      or as `: Foo` (non-invertible — always RO)
//   6. `interface Num { get value(): V }` — RO at type level
//   7. `function num(v): Writable<Num>` — factory; Writable<Num>
//      resolves to `Wr<Num>` = `Num & WritableBrand & { value: V }`
//
// Compared to today: no `static invertibles` list, no per-class
// writable interface, no `Tween.to` `as never` cast, single-hop
// `Writable<R>`.

import { type Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { Signal, type SignalOptions, type Val, valFn } from "../signal";
import { type Linear, traits } from "../traits";
import { bind } from "./bind";
import type { Wr, Writable } from "./writable";

type V = number;

export const add = (a: V, b: V) => a + b;
export const sub = (a: V, b: V) => a - b;
export const scale = (a: V, k: number) => a * k;
export const lerp = (a: V, b: V, t: number) => a + (b - a) * t;
export const metric = (a: V, b: V) => Math.abs(a - b);
export const equals = (a: V, b: V) => a === b;

const linearImpl: Linear<V> = { add, sub, scale };

export class Num extends Signal<V> {
  static traits = traits<V>()({ linear: linearImpl, lerp, metric, equals });

  /** Phantom registry brand — `Writable<Num>` resolves to `Wr<Num>`. */
  declare readonly _writable: Wr<Num>;

  constructor(v: V = 0, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  // ── invertibles: return `this` ──────────────────────────────────
  add(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(v => v + bf(), n => n - bf());
  }
  sub(b: Val<V>): this {
    const bf = valFn(b);
    return this.through(v => v - bf(), n => n + bf());
  }
  scale(k: Val<number>): this {
    const kf = valFn(k);
    return this.through(v => v * kf(), n => n / kf());
  }
  affine(k: Val<number>, off: Val<number>): this {
    const kf = valFn(k);
    const of = valFn(off);
    return this.through(
      v => v * kf() + of(),
      n => (n - of()) / kf(),
    );
  }
  clamp(lo: Val<V>, hi: Val<V>): this {
    const lf = valFn(lo);
    const hf = valFn(hi);
    const c = (v: V) => {
      const l = lf();
      const h = hf();
      return v < l ? l : v > h ? h : v;
    };
    return this.through(c, c);
  }
  quantize(step: Val<number>): this {
    const sf = valFn(step);
    const q = (v: V) => {
      const s = sf();
      return Math.round(v / s) * s;
    };
    return this.through(q, q);
  }
  cyclic(period: Val<number>): this {
    const pf = valFn(period);
    return this.through(
      v => v,
      v => {
        const cur = this.peek();
        const p = pf();
        const delta = v - cur;
        return cur + delta - p * Math.round(delta / p);
      },
    );
  }

  /** Tween — `this: Writable<Num>` constrains the receiver to writable
   *  forms at the type level. Bare RO Num is rejected at compile
   *  time. No `as never` cast needed. (Caveat #3 in today's README
   *  goes away.) */
  to(this: Writable<Num>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

/** Interface merge: declares `value` as RO at the public type level.
 *  Class itself has both get/set inherited from Signal, but TS sees
 *  the merged `get value()` declaration as the canonical type. */
export interface Num {
  readonly constructor: typeof Num;
  get value(): V;
}

export function num(v: Val<V> = 0): Writable<Num> {
  const n = new Num() as Writable<Num>;
  bind(n, v);
  return n;
}
