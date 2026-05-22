// num.ts — reactive scalar.
//
// All invertible methods (`add`, `sub`, `scale`, `affine`, `clamp`,
// `quantize`, `cyclic`) ride on the base `Signal#through(fwd, bwd)`
// primitive. Chained calls auto-fuse to a single lens cell, so
// `.scale(k).add(off).clamp(lo, hi)` is one allocation, one dep-graph
// node.

import { type Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { bind } from "../lateral";
import { computedCls, lensCls, Signal, type SignalOptions, type Val, valFn } from "../signal";
import { type Linear, type TraitDict } from "../traits";
import { invertibles, type Writable } from "../writable";

type V = number;

export const add = (a: V, b: V) => a + b;
export const sub = (a: V, b: V) => a - b;
export const scale = (a: V, k: number) => a * k;
export const lerp = (a: V, b: V, t: number) => a + (b - a) * t;
export const metric = (a: V, b: V) => Math.abs(a - b);
export const equals = (a: V, b: V) => a === b;

const linearImpl: Linear<V> = { add, sub, scale };

export class Num extends Signal<V> {
  // ── class-level config ─────────────────────────────────────────
  static traits: Required<TraitDict<V>> = { linear: linearImpl, lerp, metric, equals };
  // Methods that return a writable lens (whether strict or lossy).
  // `Writable<R>` lifts these to `(...) => Writable<Num>` so chains
  // stay writable. Strict-vs-lossy compliance is a separate concern
  // (eventually tracked in docstrings + types); for now this list is
  // simply "methods you can write back through."
  static invertibles = invertibles<Num>()(
    "add",
    "sub",
    "scale",
    "affine",
    "clamp",
    "quantize",
    "cyclic",
    "through",
  );

  // ── class-level constructors ───────────────────────────────────
  static derive(fn: () => V): Num {
    return computedCls(Num, fn);
  }
  static lens(g: () => V, s: (v: V) => void): Writable<Num> {
    return lensCls(Num, g, s) as unknown as Writable<Num>;
  }
  static is(v: unknown): v is Num {
    return v instanceof Num;
  }

  // ── instance ───────────────────────────────────────────────────
  constructor(v: V = 0, opts?: SignalOptions<V>) {
    super(v, opts);
  }

  add(b: Val<V>): Num {
    const bf = valFn(b);
    return this.through(
      v => v + bf(),
      n => n - bf(),
    );
  }
  sub(b: Val<V>): Num {
    const bf = valFn(b);
    return this.through(
      v => v - bf(),
      n => n + bf(),
    );
  }
  scale(k: Val<number>): Num {
    const kf = valFn(k);
    return this.through(
      v => v * kf(),
      n => n / kf(),
    );
  }
  /** Affine: `v ↦ k·v + off`. Invertible iff k ≠ 0. Equivalent to
   *  `.scale(k).add(off)` — the chain auto-fuses to one cell, so this
   *  is purely a readability alias. Sliders: `t.affine(width, x0)`
   *  maps `t ∈ [0,1]` to screen coords. */
  affine(k: Val<number>, off: Val<number>): Num {
    const kf = valFn(k);
    const of = valFn(off);
    return this.through(
      v => v * kf() + of(),
      n => (n - of()) / kf(),
    );
  }

  /** Lossy lens that clamps reads to `[lo, hi]` and clamps writes
   *  before propagating to source. Compliance: PutGet only (read of a
   *  write outside `[lo, hi]` returns the clamped value, not the
   *  written one). Use for sliders, gauges, anywhere a value
   *  shouldn't escape its range. */
  clamp(lo: Val<V>, hi: Val<V>): Num {
    const lf = valFn(lo);
    const hf = valFn(hi);
    const c = (v: V) => {
      const l = lf(),
        h = hf();
      return v < l ? l : v > h ? h : v;
    };
    return this.through(c, c);
  }

  /** Lossy lens that snaps reads and writes to the nearest multiple
   *  of `step`. For knobs with discrete positions. */
  quantize(step: Val<number>): Num {
    const sf = valFn(step);
    const q = (v: V) => {
      const s = sf();
      return Math.round(v / s) * s;
    };
    return this.through(q, q);
  }

  /** Cyclic-coordinate lens. Reads pass through (the source's
   *  accumulated value); writes pick the representative closest to
   *  the current value modulo `period`. Lets you drag an angle a
   *  small visible amount without jumping a full revolution when the
   *  source has accumulated many. */
  cyclic(period: Val<number>): Num {
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

  /** Tween-builder, implied by the lerp trait. The cast bypasses the
   *  WritableBrand requirement; tweens only make sense on writable
   *  Nums but the runtime tween will fail on a Computed Num anyway. */
  to(target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this as never, target, dur, ease);
  }
}
export interface Num {
  readonly constructor: typeof Num;
  get value(): V;
}

export function num(v: Val<V> = 0): Writable<Num> {
  const n = new Num() as unknown as Writable<Num>;
  bind(n, v);
  return n;
}
