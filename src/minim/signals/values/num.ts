// num.ts — reactive scalar.
//
// All invertible methods (`add`, `sub`, `scale`, `affine`, `clamp`,
// `quantize`, `cyclic`) ride on the base `Signal#lens(fwd, bwd)` primitive
// and return `: this` so chains preserve writability of the receiver.
// Chained calls auto-fuse to a single lens cell.

import type { Easing } from "../../core";
import { type Tween, tween } from "../anim";
import {
  batch,
  type Init,
  lazy,
  reader,
  Signal,
  type Val,
  type Writable,
  type WritableBrand,
} from "../signal";
import type { Linear, Pack, TraitDict } from "../traits";
import { isW, type Param, paramReader, type W } from "../wrap";
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

  /** Receiver + offset. With a bare `b` (literal or RO signal) the
   *  receiver absorbs writes to the result. With `w(b)`, the wrapped
   *  `b` absorbs instead; weight controls the split (default 1 = b
   *  absorbs all). */
  add(b: Param<V>): this {
    if (isW(b)) return _addW(this, b as W<V>) as unknown as this;
    const bv = b as Val<V>;
    const bf = reader(bv);
    return this.lens(
      v => v + bf(),
      n => n - bf(),
    );
  }
  /** Symmetric to `add`. `w(b)` makes b absorb negated delta. */
  sub(b: Param<V>): this {
    if (isW(b)) return _subW(this, b as W<V>) as unknown as this;
    const bv = b as Val<V>;
    const bf = reader(bv);
    return this.lens(
      v => v - bf(),
      n => n + bf(),
    );
  }
  /** Receiver × multiplier. `w(k)` makes the multiplier the handle
   *  (a anchored; k := target/a, when a ≠ 0). */
  scale(k: Param<number>): this {
    if (isW(k)) return _scaleW(this, k as W<number>) as unknown as this;
    const kv = k as Val<number>;
    const kf = reader(kv);
    return this.lens(
      v => v * kf(),
      n => n / kf(),
    );
  }
  /** Affine: `v ↦ k·v + off`. Invertible iff k ≠ 0. Equivalent to
   *  `.scale(k).add(off)` — the chain auto-fuses to one cell, so this
   *  is purely a readability alias. Sliders: `t.affine(width, x0)`
   *  maps `t ∈ [0,1]` to screen coords. Any parameter (k, off) may be
   *  wrapped with `w()` to act as a writable handle. */
  affine(k: Param<number>, off: Param<number>): this {
    if (isW(k) || isW(off)) return _affineW(this, k, off) as unknown as this;
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
   *  With `w(lo)` and/or `w(hi)`: the wrapped bound STRETCHES to admit
   *  out-of-range writes instead of projecting back. `weight` controls
   *  how much it absorbs (1 = fully stretch; 0 = behave as RO).
   *  PutGet restored for overruns on stretched sides. */
  clamp(lo: Param<V>, hi: Param<V>): this {
    if (isW(lo) || isW(hi)) return _clampW(this, lo, hi) as unknown as this;
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

// ─── Writable-parameter bwd helpers ─────────────────────────────────
//
// Pattern: the wp method's bwd is RESIDUAL-AWARE. It writes the wrapped
// param first, peeks to see what actually landed, computes the residual
// (what the param couldn't absorb), and routes the residual to the
// receiver. For bare-primitive params this collapses to the original
// "weight-only" semantics (residual = 0). For saturating-lens params
// (e.g., `slack.clamp(min, max)`) the residual flows to the receiver,
// giving the natural soft-spring-hard-stop behaviour.
//
// Setters use the closure-style `Cls.lens(g, s)` to write parents in
// sequence inside a batch and peek between writes. The getter uses
// tracked reads (signal.value) so forward propagation establishes
// proper deps; the setter uses peek (untracked) since it isn't a
// reactive context.

function _addW(self: Num, b: W<V>): Writable<Num> {
  const selfRW = self as Writable<Num>;
  const wf = reader(b.weight);
  return Num.lens(
    () => self.value + b.sig.value,
    (target: V) => {
      batch(() => {
        const nv = self.peek();
        const bv = b.sig.peek();
        const w = wf();
        const delta = target - (nv + bv);
        const desired_b_change = delta * w;
        b.sig.value = bv + desired_b_change;
        const actual_b_change = b.sig.peek() - bv;
        const residual = desired_b_change - actual_b_change;
        const receiver_change = delta * (1 - w) + residual;
        if (receiver_change !== 0) selfRW.value = nv + receiver_change;
      });
    },
  );
}

function _subW(self: Num, b: W<V>): Writable<Num> {
  const selfRW = self as Writable<Num>;
  const wf = reader(b.weight);
  return Num.lens(
    () => self.value - b.sig.value,
    (target: V) => {
      batch(() => {
        const nv = self.peek();
        const bv = b.sig.peek();
        const w = wf();
        const delta = target - (nv - bv);
        // For sub: b absorbs negated delta. Desired b change = -delta * w.
        const desired_b_change = -delta * w;
        b.sig.value = bv + desired_b_change;
        const actual_b_change = b.sig.peek() - bv;
        // Residual is the part of desired_b_change b couldn't take.
        // For sub, that part should still affect receiver (with positive sign).
        const residualNegated = desired_b_change - actual_b_change;
        const receiver_change = delta * (1 - w) - residualNegated;
        if (receiver_change !== 0) selfRW.value = nv + receiver_change;
      });
    },
  );
}

function _scaleW(self: Num, k: W<number>): Writable<Num> {
  const wf = reader(k.weight);
  return Num.lens(
    [self, k.sig] as const,
    ([nv, kv]) => nv * kv,
    (target, [nv, kv]) => {
      const wv = wf();
      // Underdetermined system; choose the simplest split.
      // weight=1 → k absorbs: k := target / nv (when nv ≠ 0).
      // weight=0 → receiver absorbs: nv := target / kv (when kv ≠ 0).
      // Between: lerp in log-space would be principled; for now,
      // bias toward k by `weight`.
      if (wv >= 1) {
        if (nv === 0) return [nv, kv] as const;
        return [nv, target / nv] as const;
      }
      if (wv <= 0) {
        if (kv === 0) return [nv, kv] as const;
        return [target / kv, kv] as const;
      }
      // Mixed: distribute multiplicatively. Find r such that
      // (nv*r^(1-w)) * (kv*r^w) = target. Solve: r = target / (nv*kv).
      const cur = nv * kv;
      if (cur === 0) return [nv, kv] as const;
      const r = target / cur;
      return [nv * r ** (1 - wv), kv * r ** wv] as const;
    },
  );
}

function _affineW(self: Num, k: Param<number>, off: Param<number>): Writable<Num> {
  const kWrap = isW(k) ? (k as W<number>) : undefined;
  const oWrap = isW(off) ? (off as W<number>) : undefined;
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

function _clampW(self: Num, lo: Param<V>, hi: Param<V>): Writable<Num> {
  const loWrap = isW(lo) ? (lo as W<V>) : undefined;
  const hiWrap = isW(hi) ? (hi as W<V>) : undefined;
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
