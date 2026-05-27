// num.ts — reactive scalar.
//
// All invertible methods (`add`, `sub`, `scale`, `affine`, `clamp`,
// `quantize`, `cyclic`) ride on the base `Signal#lens(fwd, bwd)` primitive
// and return `: this` so chains preserve writability of the receiver.
// Chained calls auto-fuse to a single lens cell.

import type { Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { type Init, reader, Signal, type Val, type Writable } from "../signal";
import type { Linear, Pack, TraitDict } from "../traits";

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
  /** Affine: `v ↦ k·v + off`. Invertible iff k ≠ 0. Equivalent to
   *  `.scale(k).add(off)` — the chain auto-fuses to one cell, so this
   *  is purely a readability alias. Sliders: `t.affine(width, x0)`
   *  maps `t ∈ [0,1]` to screen coords. */
  affine(k: Val<number>, off: Val<number>): this {
    const kf = reader(k);
    const of = reader(off);
    return this.lens(
      v => v * kf() + of(),
      n => (n - of()) / kf(),
    );
  }

  /** Lossy lens that clamps reads to `[lo, hi]` and clamps writes
   *  before propagating to source. Compliance: PutGet only (read of a
   *  write outside `[lo, hi]` returns the clamped value, not the
   *  written one). Use for sliders, gauges, anywhere a value
   *  shouldn't escape its range. */
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

  /** Lossy lens that snaps reads and writes to the nearest multiple
   *  of `step`. For knobs with discrete positions. */
  quantize(step: Val<number>): this {
    const sf = reader(step);
    const q = (v: V) => {
      const s = sf();
      return Math.round(v / s) * s;
    };
    return this.lens(q, q);
  }

  /** Cyclic-coordinate lens. Reads pass through (the source's
   *  accumulated value); writes pick the representative closest to
   *  the current value modulo `period`. Lets you drag an angle a
   *  small visible amount without jumping a full revolution when the
   *  source has accumulated many.
   *
   *  The 2-arg bwd `(v, s) => …` is arity-detected as stateful by
   *  the engine, which threads the genuine receiver-input value
   *  (the current accumulated angle) through `s` even across
   *  composed chains. No `this.peek()` side-channel needed. */
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

  /** Tween-builder, implied by the lerp trait. The `this:` parameter
   *  constraint gates the call site to writable receivers — bare RO
   *  Num is rejected at compile time. */
  to(this: Writable<Num>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

/** Writable `Num`. Strict factory: `number | Writable<Num>` in,
 *  `Writable<Num>` out. Literal seeds a fresh cell; existing
 *  `Writable<Num>` passes through by identity (same reference, no
 *  allocation, no effect).
 *
 *  RO sources (computed views, RO field lenses, thunks) are rejected
 *  at the type level — reach for `Num.derive(...)` to track an RO
 *  source reactively, or `Num.from(...)` for the permissive
 *  consumer-layer lift that handles any `Val<number>`. */
export function num(v: Init<Num> = 0): Writable<Num> {
  if (v instanceof Num) return v as Writable<Num>;
  return new Num(v) as Writable<Num>;
}
