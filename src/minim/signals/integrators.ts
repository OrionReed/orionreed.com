// Physics-driven motion integrators. Generic over any value type
// whose registered struct exposes `add + sub + scale` (a vector-space
// algebra). The framework installs the algebra on each Reactive's
// prototype as a hidden symbol slot, and integrators read it from
// there — the user just calls `spring(p, target)` and the right
// algebra is found automatically.
//
// Defaults to the scalar (number) algebra for raw `Signal<number>`
// or any signal whose value type doesn't have a registered algebra.
//
// Reactive args: `target`, `velocity`, `amp`, `freq`, `k` are all
// accepted as `Arg<T>` (literal / signal / thunk). The integrator
// reads them each frame, so a reactive target makes the follower
// chase a moving point; a reactive velocity scrubs live; etc.

import type { Signal } from "../core/signal";
import type { Animator } from "../core/anim";
import { toSig, type Arg } from "../core/arg";
import { ALGEBRA } from "./struct";

/** The minimal vector-space algebra used by physics integrators.
 *  Every registered struct that declares `add`/`sub`/`scale` ops
 *  satisfies this structurally — the framework attaches them to the
 *  Reactive's prototype, where integrators find them. */
export interface VectorSpace<T> {
  add: (a: T, b: T) => T;
  sub: (a: T, b: T) => T;
  scale: (a: T, k: number) => T;
}

/** Scalar (number) algebra — the default fallback for raw
 *  `Signal<number>` or signals whose value type doesn't have a
 *  registered struct algebra. */
const NumberVS: VectorSpace<number> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  scale: (a, k) => a * k,
};

/** Resolve the algebra for a signal: prefer the struct-installed one
 *  (via the hidden ALGEBRA prototype slot), fall back to scalar. */
function algebraOf<T>(sig: Signal<T>): VectorSpace<T> {
  const a = (sig as any)[ALGEBRA] as VectorSpace<T> | undefined;
  return a ?? (NumberVS as unknown as VectorSpace<T>);
}

/** Default norm: |x| for scalar, hypot for `{x, y}` Vec. Used by
 *  `precision`-driven auto-stop on `spring`. Any other value type
 *  falls back to `0` (auto-stop disabled — caller terminates). */
function normOf<T>(v: T): number {
  if (typeof v === "number") return Math.abs(v);
  if (v != null && typeof v === "object" && "x" in v && "y" in v) {
    const o = v as { x: number; y: number };
    return Math.hypot(o.x, o.y);
  }
  return 0;
}

export interface SpringOpts {
  /** Spring stiffness (Hooke). Higher → faster pull-back. Default 170. */
  stiffness?: number;
  /** Velocity damping. Higher → less oscillation. Default 26. */
  damping?: number;
  /** Settle threshold. When `|displacement|` AND `|velocity|` are both
   *  below this for one frame, snap to target and complete. `0`
   *  (default) runs forever — handy when the target keeps moving.
   *
   *  For scalar `T = number`, `|·|` is `Math.abs`. For `Vec`, hypot.
   *  For other value types, precision is ignored (no built-in norm). */
  precision?: number;
}

/** Critically-damped spring chase. Works for any value type whose
 *  registered struct has a vector-space algebra (add + sub + scale).
 *  Defaults to scalar.
 *
 *  `target` may be reactive — the follower keeps chasing a moving
 *  point. With `precision > 0`, completes when both displacement and
 *  velocity are below the threshold; otherwise runs until cancelled. */
export function* spring<T = number>(
  sig: Signal<T>,
  target: Arg<T>,
  opts: SpringOpts = {},
): Animator {
  const { add, sub, scale } = algebraOf(sig);
  const stiffness = opts.stiffness ?? 170;
  const damping = opts.damping ?? 26;
  const eps = opts.precision ?? 0;
  const tgt = toSig(target);
  let velocity: T = scale(sub(tgt.peek(), tgt.peek()), 0);
  while (true) {
    const dt: number = yield;
    const t = tgt.value;
    const cur = sig.peek();
    const displacement = sub(t, cur);
    const force = scale(displacement, stiffness);
    const drag = scale(velocity, -damping);
    const accel = add(force, drag);
    velocity = add(velocity, scale(accel, dt));
    sig.value = add(cur, scale(velocity, dt));
    if (eps > 0 && normOf(displacement) < eps && normOf(velocity) < eps) {
      sig.value = t;
      return;
    }
  }
}

/** Sinusoidal oscillation around the signal's initial value. The
 *  amplitude is a value of type T (component-wise for vectors).
 *  `amp` and `freq` may be reactive. Never returns. */
export function* oscillate<T = number>(
  sig: Signal<T>,
  amp: Arg<T>,
  freq: Arg<number>,
): Animator {
  const { add, scale } = algebraOf(sig);
  const A = toSig(amp);
  const F = toSig(freq);
  const base = sig.peek();
  let t = 0;
  while (true) {
    const dt: number = yield;
    t += dt;
    sig.value = add(base, scale(A.value, Math.sin(2 * Math.PI * F.value * t)));
  }
}

/** Exponential pull toward target with rate `k` per second
 *  (k=1 closes ~63% of distance per second). No overshoot, no
 *  velocity. `target` and `k` may be reactive. */
export function* attract<T = number>(
  sig: Signal<T>,
  target: Arg<T>,
  k: Arg<number> = 1,
): Animator {
  const { add, sub, scale } = algebraOf(sig);
  const T = toSig(target);
  const K = toSig(k);
  while (true) {
    const dt: number = yield;
    const cur = sig.peek();
    const delta = scale(sub(T.value, cur), K.value * dt);
    sig.value = add(cur, delta);
  }
}

/** Constant-velocity advance. Uses just add + scale. `velocity` may
 *  be reactive — flip it live to reverse direction. */
export function* drift<T = number>(
  sig: Signal<T>,
  velocity: Arg<T>,
): Animator {
  const { add, scale } = algebraOf(sig);
  const V = toSig(velocity);
  while (true) {
    const dt: number = yield;
    sig.value = add(sig.peek(), scale(V.value, dt));
  }
}
