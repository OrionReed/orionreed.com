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

import type { Easing } from "../../core";
import { type Tween, tween } from "../anim";
import {
  type Init,
  reader,
  readNow,
  Signal,
  type Val,
  type Writable,
  type WritableBrand,
} from "../signal";
import type { Linear, Pack, TraitDict } from "../traits";
import { derived, field } from "../writable";
import { Bool } from "./bool";
import { Num, num } from "./num";

type V = { lo: number; hi: number };

export const add = (a: V, b: V): V => ({ lo: a.lo + b.lo, hi: a.hi + b.hi });
export const sub = (a: V, b: V): V => ({ lo: a.lo - b.lo, hi: a.hi - b.hi });
export const scale = (a: V, k: number): V => ({ lo: a.lo * k, hi: a.hi * k });
export const lerp = (a: V, b: V, t: number): V => ({
  lo: a.lo + (b.lo - a.lo) * t,
  hi: a.hi + (b.hi - a.hi) * t,
});
export const equals = (a: V, b: V) => a === b || (a.lo === b.lo && a.hi === b.hi);
/** L2 distance over (lo, hi). Treats a range as a point in 2-space. */
export const metric = (a: V, b: V) => Math.hypot(a.lo - b.lo, a.hi - b.hi);

export const width = (r: V) => r.hi - r.lo;
export const center = (r: V) => (r.lo + r.hi) / 2;
export const contains = (r: V, v: number) => v >= r.lo && v <= r.hi;
export const clamp = (r: V, v: number) => (v < r.lo ? r.lo : v > r.hi ? r.hi : v);

/** Closest value STRICTLY outside `[lo, hi]`, displaced past the
 *  nearest endpoint by `eps`. Used by `Range#contains` as the bwd's
 *  false-side policy. */
export const eject = (r: V, v: number, eps = 1e-6) => {
  if (!contains(r, v)) return v;
  return v - r.lo <= r.hi - v ? r.lo - eps : r.hi + eps;
};

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
  static traits = {
    linear: linearImpl,
    lerp,
    metric,
    equals,
    pack: packImpl,
  } satisfies TraitDict<V>;
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
    const f = reader(by);
    return this.lens(
      v => ({ lo: v.lo + f(), hi: v.hi + f() }),
      n => ({ lo: n.lo - f(), hi: n.hi - f() }),
    );
  }
  /** Scale uniformly about the origin. Iso for `k ≠ 0`. */
  scale(k: Val<number>): this {
    const kf = reader(k);
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
    return Num.derive(() => sample(this.value, readNow(t)));
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
  /** Membership predicate. Conditional return type: when `v` is a
   *  writable `Num`, the result is `Writable<Bool>` and flipping the
   *  view bumps the source — `true` clamps into `[lo, hi]`, `false`
   *  ejects past the nearest endpoint by `eps`. Literal / RO inputs
   *  yield a bare RO `Bool`. The 1-D dual of `Box#contains`. */
  contains<P extends Val<number>>(
    v: P,
  ): P extends WritableBrand ? Writable<Bool> : Bool {
    if (v instanceof Num) {
      const fused = (v as { _fusedOf?: { bwd?: unknown } })._fusedOf;
      const isRO = fused !== undefined && fused.bwd === undefined;
      if (!isRO) {
        return Bool.lens(
          [this, v] as never,
          (vals: readonly [V, number]) => contains(vals[0], vals[1]),
          (target, vals) => {
            const [r, n] = vals as readonly [V, number];
            if (contains(r, n) === target) return [undefined, undefined] as never;
            return [undefined, target ? clamp(r, n) : eject(r, n)] as never;
          },
        ) as never;
      }
    }
    return Bool.derive(() => contains(this.value, readNow(v))) as never;
  }
  /** RO clamp: read `v` into `[lo, hi]`. For a writable clamping lens
   *  on a single Num, see `Num#clamp(lo, hi)`. */
  clampedRead(v: Val<number>): Num {
    return Num.derive(() => clamp(this.value, readNow(v)));
  }
  /** Inverse of `sample`: derive the `t` that would produce `v`. */
  paramOf(v: Val<number>): Num {
    return Num.derive(() => paramOf(this.value, readNow(v)));
  }

  /** Tween-builder, implied by the lerp trait. Animates `{lo, hi}`
   *  jointly between intervals. */
  to(this: Writable<Range>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

/** @internal — bidirectional 2-input lens over two writable `Num`s.
 *  `range()` delegates here after lifting literals. Not part of the
 *  public surface; users always go through `range()`. */
function ends(lo: Writable<Num>, hi: Writable<Num>): Writable<Range> {
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

/** Writable `Range` over `[lo, hi]`. Each endpoint is either a literal
 *  `number` (lifted to a fresh `Writable<Num>` seed) or an existing
 *  `Writable<Num>` (passed through by identity, writes propagate).
 *
 *  RO sources are rejected at the type level — use `Range.derive(...)`
 *  for reactive RO tracking, or `signal.value` to snapshot. Lock an
 *  endpoint with `Num.pin(c)`. */
export function range(lo: Init<Num> = 0, hi: Init<Num> = 1): Writable<Range> {
  if (typeof lo === "number" && typeof hi === "number") {
    return new Range({ lo, hi }) as Writable<Range>;
  }
  return ends(num(lo), num(hi));
}
