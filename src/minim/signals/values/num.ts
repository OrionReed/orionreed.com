// num.ts — reactive scalar.
//
// All invertible methods (`add`, `sub`, `scale`, `affine`, `clamp`,
// `quantize`, `cyclic`) ride on the base `Signal#lens(fwd, bwd)` primitive
// and return `: this` so chains preserve writability of the receiver.
// Chained calls auto-fuse to a single lens cell.

import type { Easing } from "../../core";
import { type Tween, tween } from "../anim";
import {
  type Init,
  lazy,
  reader,
  Signal,
  type Val,
  type Writable,
  type WritableBrand,
} from "../signal";
import type { Linear, Pack, TraitDict } from "../traits";
import {
  isShare,
  type LensAlgebra,
  lensWithParam,
  type Param,
  paramReader,
  type Share,
} from "../lens-params";
import { Bool } from "./bool";

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

  /** Receiver + offset. Bare `b` (literal or RO signal): receiver absorbs
   *  writes to the result. `share(b)` @experimental: `b` absorbs (with
   *  optional weight); residual flows to receiver. `own(b)` @experimental:
   *  `b` is owned by this lens; parent-edits route through `b`
   *  symmetrically (drift on saturation). */
  add(b: Param<V>): this {
    return lensWithParam(this as unknown as Writable<Num>, b, NUM_ADD_ALG) as unknown as this;
  }
  /** Symmetric to `add`. With `share(b)`/`own(b)`, `b` absorbs the
   *  negated delta. */
  sub(b: Param<V>): this {
    return lensWithParam(this as unknown as Writable<Num>, b, NUM_SUB_ALG) as unknown as this;
  }
  /** Receiver × multiplier. With `share(k)`/`own(k)`, `k` is the handle
   *  (receiver anchored; `k := target/receiver` when receiver ≠ 0). */
  scale(k: Param<number>): this {
    return lensWithParam(this as unknown as Writable<Num>, k, NUM_SCALE_ALG) as unknown as this;
  }
  /** Affine: `v ↦ k·v + off`. Invertible iff k ≠ 0. Equivalent to
   *  `.scale(k).add(off)` — the chain auto-fuses to one cell, so this
   *  is purely a readability alias. Sliders: `t.affine(width, x0)`
   *  maps `t ∈ [0,1]` to screen coords. Any parameter (k, off) may be
   *  wrapped with `share()` to act as a writable handle. */
  affine(k: Param<number>, off: Param<number>): this {
    if (isShare(k) || isShare(off)) return _affineShare(this, k, off) as unknown as this;
    const kf = reader(k as Val<number>);
    const of = reader(off as Val<number>);
    return this.lens(
      v => v * kf() + of(),
      n => (n - of()) / kf(),
    );
  }

  /** Lossy lens that clamps reads to `[lo, hi]` and clamps writes
   *  before propagating to source. Compliance: PutGet only (read of a
   *  write outside `[lo, hi]` returns the clamped value, not the
   *  written one). Use for sliders, gauges, anywhere a value
   *  shouldn't escape its range.
   *
   *  With `share(lo)` and/or `share(hi)` @experimental: the wrapped
   *  bound STRETCHES to admit out-of-range writes instead of projecting
   *  back. `weight` controls how much it absorbs (1 = fully stretch;
   *  0 = behave as RO). PutGet restored for overruns on stretched sides. */
  clamp(lo: Param<V>, hi: Param<V>): this {
    if (isShare(lo) || isShare(hi)) return _clampShare(this, lo, hi) as unknown as this;
    const lf = reader(lo as Val<V>);
    const hf = reader(hi as Val<V>);
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

  // ── Predicate bridges to Bool ────────────────────────────────────
  //
  // Cross-type quotient lenses: project Num through a boolean
  // predicate. The bwd policy is the obvious "snap across the
  // boundary by eps" (for thresholds) or "walk to the nearest
  // satisfying integer" (for divisibility). The Bool cousins of
  // `clamp` / `quantize` — same Foster-style ≈_S = "same boolean
  // class" equivalence.
  //
  // Each method has a conditional return type: writable receiver
  // (Writable<Num>) yields Writable<Bool>; bare RO receiver yields
  // RO Bool. Mirrors `field()`'s writability-propagating shape.

  /** `this > t` as a (writability-propagating) Bool. Flipping the view
   *  bumps the source across the threshold by `eps`. Cross-type analog
   *  of `clamp`: a stateful idempotent projection through a 2-element
   *  quotient. */
  greaterThan<T extends Num>(
    this: T,
    t: Val<V>,
    eps: Val<V> = 1e-6,
  ): T extends WritableBrand ? Writable<Bool> : Bool {
    const tf = reader(t);
    const ef = reader(eps);
    return Bool.lens(
      this,
      v => v > tf(),
      (target, current) => {
        const th = tf();
        if (target === current > th) return current;
        return target ? th + ef() : th - ef();
      },
    ) as never;
  }

  /** `this < t`. Dual of `greaterThan`. */
  lessThan<T extends Num>(
    this: T,
    t: Val<V>,
    eps: Val<V> = 1e-6,
  ): T extends WritableBrand ? Writable<Bool> : Bool {
    const tf = reader(t);
    const ef = reader(eps);
    return Bool.lens(
      this,
      v => v < tf(),
      (target, current) => {
        const th = tf();
        if (target === current < th) return current;
        return target ? th - ef() : th + ef();
      },
    ) as never;
  }

  /** `round(this) ≡ 0 (mod d)`. The source is treated as an integer
   *  (rounded for the test); pair with `quantize(1)` for clean integer
   *  sliders.
   *
   *  Bwd policy:
   *   - `true` (currently non-divisible): snap to the nearer of the
   *     two adjacent multiples of `d`.
   *   - `false` (currently divisible): bump by `+1` (smallest move
   *     guaranteed to flip the class).
   *   - target matches current class: no-op. */
  divisibleBy<T extends Num>(
    this: T,
    d: Val<V>,
  ): T extends WritableBrand ? Writable<Bool> : Bool {
    const df = reader(d);
    return Bool.lens(
      this,
      v => Math.round(v) % df() === 0,
      (target, current) => {
        const dv = df();
        const r = Math.round(current);
        // ((a % b) + b) % b handles negative `r` cleanly.
        const mod = ((r % dv) + dv) % dv;
        const isDiv = mod === 0;
        if (target === isDiv) return current;
        if (target) {
          const down = r - mod;
          const up = r + (dv - mod);
          return Math.abs(current - down) <= Math.abs(current - up) ? down : up;
        }
        return r + 1;
      },
    ) as never;
  }

  /** `divisibleBy(2)` — lazy getter for the common case. */
  get isEven(): this extends WritableBrand ? Writable<Bool> : Bool {
    return lazy(this, "isEven", () => (this as Num).divisibleBy(2)) as never;
  }
  /** `not(divisibleBy(2))` — lazy getter. */
  get isOdd(): this extends WritableBrand ? Writable<Bool> : Bool {
    return lazy(this, "isOdd", () => (this as Num).divisibleBy(2).not()) as never;
  }

  /** Tween-builder, implied by the lerp trait. The `this:` parameter
   *  constraint gates the call site to writable receivers — bare RO
   *  Num is rejected at compile time. */
  to(this: Writable<Num>, target: V, dur: Val<number>, ease?: Easing): Tween<V> {
    return tween(this, target, dur, ease);
  }
}

// ─── @experimental — single-param algebras for `lensWithParam` ──────
//
// Each method's bwd reduces to three closures:
//   fwd     — view = f(receiver, param).
//   solveA  — receiver such that f(receiver, param_actual) = target.
//   solveP  — param such that f(receiver, param) = target.
// The generic `lensWithParam` in `../lens-params` consumes the spec
// and handles RO / share() / own() dispatch, weight blending, residual
// flow, ownership claim, parent-change reaction, and drift-on-
// saturation uniformly. Per-method authoring cost: ~5 lines.

const NUM_ADD_ALG: LensAlgebra<V, V> = {
  fwd: (a, b) => a + b,
  solveA: (v, b) => v - b,
  solveP: (v, a) => v - a,
};

const NUM_SUB_ALG: LensAlgebra<V, V> = {
  fwd: (a, b) => a - b,
  solveA: (v, b) => v + b,
  solveP: (v, a) => a - v,
};

const NUM_SCALE_ALG: LensAlgebra<V, number> = {
  fwd: (a, k) => a * k,
  // Singularity at k=0: leave receiver unchanged (avoids Inf/NaN propagation).
  solveA: (v, k) => (k === 0 ? 0 : v / k),
  // Singularity at a=0: leave param unchanged (k can't be defined).
  solveP: (v, a) => (a === 0 ? 1 : v / a),
};

// `affine` and `clamp` still use bespoke multi-input helpers below.
// They take more than one writable param and the algebra isn't a clean
// 2-input bwd shape, so the generic `lensWithParam` doesn't apply yet.

function _affineShare(self: Num, k: Param<number>, off: Param<number>): Writable<Num> {
  const kWrap = isShare(k) ? (k as Share<number>) : undefined;
  const oWrap = isShare(off) ? (off as Share<number>) : undefined;
  const kRead = paramReader(k);
  const oRead = paramReader(off);
  const kWeight = kWrap ? reader(kWrap.weight) : () => 0;
  const oWeight = oWrap ? reader(oWrap.weight) : () => 0;

  // Parents: receiver always; then wrapped params in fixed order [k, off].
  const parents: unknown[] = [self];
  if (kWrap) parents.push(kWrap.sig);
  if (oWrap) parents.push(oWrap.sig);

  return Num.lens(
    parents as never,
    ((vals: readonly number[]) => {
      const nv = vals[0]!;
      const kv = kWrap ? vals[1]! : kRead();
      const ov = oWrap ? vals[kWrap ? 2 : 1]! : oRead();
      return nv * kv + ov;
    }) as never,
    ((target: number, vals: readonly number[]) => {
      const nv = vals[0]!;
      const kv = kWrap ? vals[1]! : kRead();
      const ov = oWrap ? vals[kWrap ? 2 : 1]! : oRead();
      const cur = nv * kv + ov;
      const delta = target - cur;
      const wk = kWeight();
      const wo = oWeight();
      const wr = 1 - wk - wo;
      const wReceiver = Math.max(0, wr);
      const norm = wReceiver + wk + wo || 1;

      const dn = (delta * wReceiver) / norm;
      const dOff = (delta * wo) / norm;
      const dk = nv === 0 ? 0 : (delta * wk) / norm / nv;

      const out: Array<number | undefined> = [nv + (kv === 0 ? 0 : dn / kv)];
      if (kWrap) out.push(kv + dk);
      if (oWrap) out.push(ov + dOff);
      return out as never;
    }) as never,
  );
}

function _clampShare(self: Num, lo: Param<V>, hi: Param<V>): Writable<Num> {
  const loWrap = isShare(lo) ? (lo as Share<V>) : undefined;
  const hiWrap = isShare(hi) ? (hi as Share<V>) : undefined;
  const loRead = paramReader(lo);
  const hiRead = paramReader(hi);
  const loWeight = loWrap ? reader(loWrap.weight) : () => 0;
  const hiWeight = hiWrap ? reader(hiWrap.weight) : () => 0;

  const parents: unknown[] = [self];
  if (loWrap) parents.push(loWrap.sig);
  if (hiWrap) parents.push(hiWrap.sig);

  return Num.lens(
    parents as never,
    ((vals: readonly number[]) => {
      const tv = vals[0]!;
      const lov = loWrap ? vals[1]! : loRead();
      const hiv = hiWrap ? vals[loWrap ? 2 : 1]! : hiRead();
      if (tv < lov) return lov;
      if (tv > hiv) return hiv;
      return tv;
    }) as never,
    ((target: number, vals: readonly number[]) => {
      const lov = loWrap ? vals[1]! : loRead();
      const hiv = hiWrap ? vals[loWrap ? 2 : 1]! : hiRead();
      const out: Array<number | undefined> = [target];
      if (target < lov) {
        if (loWrap) {
          const w = loWeight();
          const newLo = lov + (target - lov) * w;
          out.push(newLo);
          if (hiWrap) out.push(undefined);
          out[0] = w >= 1 ? target : newLo;
        } else {
          out[0] = lov;
          if (hiWrap) out.push(undefined);
        }
      } else if (target > hiv) {
        if (loWrap) out.push(undefined);
        if (hiWrap) {
          const w = hiWeight();
          const newHi = hiv + (target - hiv) * w;
          out.push(newHi);
          out[0] = w >= 1 ? target : newHi;
        } else {
          out[0] = hiv;
        }
      } else {
        if (loWrap) out.push(undefined);
        if (hiWrap) out.push(undefined);
      }
      return out as never;
    }) as never,
  );
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
