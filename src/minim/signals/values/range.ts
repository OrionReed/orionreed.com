// range.ts — reactive numeric interval `[lo, hi]`.
//
// Ranges are the natural home for sliders, scrollbars, clip spans on
// timelines, and any "value bounded between two endpoints" UX. Field
// lenses give you start-knob (`.lo`) and end-knob (`.hi`) drag for
// free; `.start` is the body-drag (read = lo, write shifts both,
// preserving width); `.slider(t)` is the headline bidirectional
// `t ∈ ℝ ↔ lo + t·(hi - lo)` iso, the writable generalisation of
// `Num#affine`.
//
// Trait coverage: `linear` (Minkowski-like add: lo+lo, hi+hi),
// `lerp` (animate between intervals), `equals`, `pack`. Subclasses
// over a Vec-valued lo/hi could come later; today this is scalar-only.

import { type Easing } from "../../core";
import { type Tween, tween } from "../anim";
import { bind } from "../lateral";
import { computed, Signal, type Val, valFn, value, type Writable } from "../signal";
import { type Linear, type Pack, type TraitDict } from "../traits";
import { derived, field } from "../writable";
import { Num } from "./num";

type V = { lo: number; hi: number };

export const add = (a: V, b: V): V => ({ lo: a.lo + b.lo, hi: a.hi + b.hi });
export const sub = (a: V, b: V): V => ({ lo: a.lo - b.lo, hi: a.hi - b.hi });
export const scale = (a: V, k: number): V => ({ lo: a.lo * k, hi: a.hi * k });
export const lerp = (a: V, b: V, t: number): V => ({
  lo: a.lo + (b.lo - a.lo) * t,
  hi: a.hi + (b.hi - a.hi) * t,
});
export const equals = (a: V, b: V) => a === b || (a.lo === b.lo && a.hi === b.hi);

export const width = (r: V) => r.hi - r.lo;
export const center = (r: V) => (r.lo + r.hi) / 2;
export const contains = (r: V, v: number) => v >= r.lo && v <= r.hi;
export const clamp = (r: V, v: number) => (v < r.lo ? r.lo : v > r.hi ? r.hi : v);

/** Sample at parameter `t`: `lo + t·(hi - lo)`. `t ∈ [0, 1]` stays
 *  inside the range; values outside extrapolate linearly. */
export const sample = (r: V, t: number) => r.lo + t * (r.hi - r.lo);

/** Inverse of `sample`: given a value, recover the `t` that would
 *  produce it. Degenerate (zero-width) ranges return 0. */
export const paramOf = (r: V, v: number) => {
  const w = r.hi - r.lo;
  return w === 0 ? 0 : (v - r.lo) / w;
};

const linearImpl: Linear<V> = { add, sub, scale };
const packImpl: Pack<V> = {
  dim: 2,
  read: (v, a, o) => {
    a[o] = v.lo;
    a[o + 1] = v.hi;
  },
  write: (a, o) => ({ lo: a[o]!, hi: a[o + 1]! }),
};

export class Range extends Signal<V> {
  static traits = { linear: linearImpl, lerp, equals, pack: packImpl } satisfies TraitDict<V>;
  declare readonly _t: typeof Range.traits;

  constructor(v: V = { lo: 0, hi: 1 }) {
    super(v, { equals });
  }

  // ── field lenses (independent endpoints) ───────────────────────────
  /** Start endpoint. Writes preserve `hi` (start-knob semantics). */
  get lo() {
    return field(this, "lo", Num);
  }
  /** End endpoint. Writes preserve `lo` (end-knob semantics). */
  get hi() {
    return field(this, "hi", Num);
  }

  // ── derived views ──────────────────────────────────────────────────
  get width() {
    return derived(this, "width", Num, width);
  }
  get center() {
    return derived(this, "center", Num, center);
  }

  // ── invertibles: return `: this`, propagating writability ──────────
  /** Translate by `by`. Reads shift the interval; writes shift back. */
  shift(by: Val<number>): this {
    const f = valFn(by);
    return this.lens(
      v => ({ lo: v.lo + f(), hi: v.hi + f() }),
      n => ({ lo: n.lo - f(), hi: n.hi - f() }),
    );
  }
  /** Scale uniformly about the origin. Iso for `k ≠ 0`. */
  scale(k: Val<number>): this {
    const kf = valFn(k);
    return this.lens(
      v => {
        const k = kf();
        return { lo: v.lo * k, hi: v.hi * k };
      },
      n => {
        const k = kf();
        return { lo: n.lo / k, hi: n.hi / k };
      },
    );
  }

  // ── body-drag: read = lo, write shifts both, preserves width ───────
  /** Body-drag handle: read returns `lo`, write shifts the whole range
   *  so `lo` equals the written value (`hi - lo` preserved). Mirrors
   *  "drag the clip body by its start"; for "edit the start knob, end
   *  pinned" use `.lo` instead. */
  get start(): Writable<Num> {
    return Num.lens(
      this,
      v => v.lo,
      (newLo, src) => ({ lo: newLo, hi: newLo + (src.hi - src.lo) }),
    );
  }

  // ── samplers ───────────────────────────────────────────────────────
  /** RO sample at `t`. `t ∈ [0, 1]` stays inside; outside extrapolates. */
  sample(t: Val<number>): Num {
    return Num.derive(() => sample(this.value, value(t)));
  }
  /** Bidirectional `t ↔ value` slider. Read: `lo + t·(hi - lo)`. Write:
   *  solves `t = (v - lo)/(hi - lo)` and writes back through `t` only;
   *  `lo` and `hi` stay put. Drag-the-thumb UX in one line.
   *
   *  Closure-style 2-arg form: deps on `this` and `t` are captured by
   *  reading them inside the getter; the setter writes only `t`. Same
   *  semantics as a tuple-fan-in lens, but sidesteps the polymorphic
   *  `this` inference around `[this, t] as const`. */
  slider(t: Writable<Num>): Writable<Num> {
    return Num.lens(
      () => sample(this.value, t.value),
      v => {
        const r = this.peek();
        const w = r.hi - r.lo;
        t.value = w === 0 ? 0 : (v - r.lo) / w;
      },
    );
  }

  // ── predicates / clamps ────────────────────────────────────────────
  /** True iff `v` is in `[lo, hi]`. */
  contains(v: Val<number>): Signal<boolean> {
    return computed(() => contains(this.value, value(v)));
  }
  /** RO clamp: read `v` into `[lo, hi]`. For a writable clamping lens
   *  on a single Num, see `Num#clamp(lo, hi)`. */
  clampedRead(v: Val<number>): Num {
    return Num.derive(() => clamp(this.value, value(v)));
  }
  /** Inverse of `sample`: derive the `t` that would produce `v`. */
  paramOf(v: Val<number>): Num {
    return Num.derive(() => paramOf(this.value, value(v)));
  }

  /** Tween-builder, implied by the lerp trait. Animates `{lo, hi}`
   *  jointly between intervals. */
  to(this: Writable<Range>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

/** Range from two writable Num endpoints. Writes propagate to both
 *  source Nums in a single batch — the `axes()` analogue for ranges. */
export function ends(lo: Writable<Num>, hi: Writable<Num>): Writable<Range> {
  return Range.lens(
    [lo, hi] as const,
    (vals): V => ({ lo: vals[0], hi: vals[1] }),
    (target: V) => [target.lo, target.hi] as never,
  );
}

/** Range over `[at, at + dur]`, parameterised by start + duration. The
 *  natural shape for timeline clips: writes to `.lo` slide the start
 *  knob (preserving `hi`); writes to `.hi` slide the end knob
 *  (preserving `lo`); writes to `.start` body-drag (preserving
 *  width = `dur`). Backed by the existing `at`/`dur` Nums; both stay
 *  writable and consistent. */
export function span(at: Writable<Num>, dur: Writable<Num>): Writable<Range> {
  return Range.lens(
    [at, dur] as const,
    (vals): V => ({ lo: vals[0], hi: vals[0] + vals[1] }),
    (target: V) => [target.lo, target.hi - target.lo] as never,
  );
}

/** Writable Range. When both endpoints are `Num` instances, returns
 *  the bidirectional 2-input lens (`ends`); literal / function /
 *  computed endpoints fall back to a fresh source seeded via `bind`. */
export function range(lo: Val<number> = 0, hi: Val<number> = 1): Writable<Range> {
  if (lo instanceof Num && hi instanceof Num) {
    return ends(lo as Writable<Num>, hi as Writable<Num>);
  }
  const r = new Range() as Writable<Range>;
  bind(r.lo, lo);
  bind(r.hi, hi);
  return r;
}
