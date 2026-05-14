// Continuous behaviors over a single cell — `spring`, `oscillate`,
// `drift`, `attract`. Each is a generator that runs `step(dt, t)` once
// per frame on the `drive` primitive. Generic over any value type with
// a registered vector-space algebra (`[ALGEBRA]` slot). `spring`'s
// precision-stop additionally needs a metric (`[METRIC]` slot) — runs
// forever if precision > 0 and no metric is registered.
//
// Reactive args (`target`, `velocity`, `amp`, `freq`, `k`) are read each
// frame, so a moving target makes the follower chase, a reactive `rate`
// can ease the simulation, etc.

import { drive, type Animator } from "@minim/core";
import { toSig, type Cell, type Val } from "@minim/signals";
import { algebraOf, metricOf } from "./algebra";

export interface SpringOpts {
  /** Hooke stiffness; higher → faster pull. Default 170. */
  stiffness?: number;
  /** Velocity damping; higher → less oscillation. Default 26. */
  damping?: number;
  /** Settle threshold: snap+complete when both
   *  `distance(cur, target)` and `distance(velocity, zero)` fall
   *  below this. `0` runs forever. Requires the cell's struct to
   *  register a `metric` capability (e.g. `Num` / `Vec` do). */
  precision?: number;
}

/** Critically-damped spring chase. `target` may be reactive. */
export function spring<T = number>(
  sig: Cell<T>,
  target: Val<T>,
  opts: SpringOpts = {},
): Animator {
  const { add, sub, scale } = algebraOf(sig);
  const stiffness = opts.stiffness ?? 170;
  const damping = opts.damping ?? 26;
  const eps = opts.precision ?? 0;
  // Auto-settle uses the cell's registered metric. If `eps > 0` but
  // the struct has no metric capability, the spring runs forever
  // (no fallback heuristics — the type tells you what's possible).
  const distance = eps > 0 ? metricOf(sig) : undefined;
  const tgt = toSig(target);
  // Zero of the vector space — `scale(any, 0)` produces the identity.
  const zero: T = scale(sub(tgt.peek(), tgt.peek()), 0);
  let velocity: T = zero;
  return drive((dt) => {
    const t = tgt.value;
    const cur = sig.peek();
    const displacement = sub(t, cur);
    const force = scale(displacement, stiffness);
    const drag = scale(velocity, -damping);
    velocity = add(velocity, scale(add(force, drag), dt));
    sig.value = add(cur, scale(velocity, dt));
    if (
      distance !== undefined &&
      distance(cur, t) < eps &&
      distance(velocity, zero) < eps
    ) {
      sig.value = t;
      return false;
    }
  });
}

/** Sinusoidal oscillation around the signal's initial value. Never returns. */
export function oscillate<T = number>(
  sig: Cell<T>,
  amp: Val<T>,
  freq: Val<number>,
): Animator {
  const { add, scale } = algebraOf(sig);
  const A = toSig(amp);
  const F = toSig(freq);
  const base = sig.peek();
  return drive((_dt, t) => {
    sig.value = add(base, scale(A.value, Math.sin(2 * Math.PI * F.value * t)));
  });
}

/** Exponential pull toward target with rate `k` per second
 *  (k=1 closes ~63% of distance per second). No overshoot. */
export function attract<T = number>(
  sig: Cell<T>,
  target: Val<T>,
  k: Val<number> = 1,
): Animator {
  const { add, sub, scale } = algebraOf(sig);
  const T = toSig(target);
  const K = toSig(k);
  return drive((dt) => {
    const cur = sig.peek();
    const delta = scale(sub(T.value, cur), K.value * dt);
    sig.value = add(cur, delta);
  });
}

/** Constant-velocity advance. `velocity` may be reactive (flip live to reverse). */
export function drift<T = number>(
  sig: Cell<T>,
  velocity: Val<T>,
): Animator {
  const { add, scale } = algebraOf(sig);
  const V = toSig(velocity);
  return drive((dt) => {
    sig.value = add(sig.peek(), scale(V.value, dt));
  });
}
