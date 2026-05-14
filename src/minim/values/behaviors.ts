// Continuous behaviors over a single signal — `spring`, `oscillate`,
// `drift`, `attract`. Each is a generator that runs `step(dt, t)` once
// per frame on the `drive` primitive. Generic over any value type whose
// registered struct has a vector-space algebra (add/sub/scale via the
// `[ALGEBRA]` slot); raw `Signal<number>` falls back to scalar.
//
// Reactive args (`target`, `velocity`, `amp`, `freq`, `k`) are read each
// frame, so a moving target makes the follower chase, a reactive `rate`
// can ease the simulation, etc.

import {
  drive,
  toSig,
  type Animator,
  type Val,
} from "@minim/core";
import { type Signal } from "@minim/signals";
import { algebraOf } from "./algebra";

/** Norm for `precision` auto-stop: `|x|` for scalar, hypot for Vec, else 0. */
function normOf<T>(v: T): number {
  if (typeof v === "number") return Math.abs(v);
  if (v != null && typeof v === "object" && "x" in v && "y" in v) {
    const o = v as { x: number; y: number };
    return Math.hypot(o.x, o.y);
  }
  return 0;
}

export interface SpringOpts {
  /** Hooke stiffness; higher → faster pull. Default 170. */
  stiffness?: number;
  /** Velocity damping; higher → less oscillation. Default 26. */
  damping?: number;
  /** Settle threshold: snap+complete when both `|displacement|` and
   *  `|velocity|` drop below this. `0` runs forever. */
  precision?: number;
}

/** Critically-damped spring chase. `target` may be reactive. */
export function spring<T = number>(
  sig: Signal<T>,
  target: Val<T>,
  opts: SpringOpts = {},
): Animator {
  const { add, sub, scale } = algebraOf(sig);
  const stiffness = opts.stiffness ?? 170;
  const damping = opts.damping ?? 26;
  const eps = opts.precision ?? 0;
  const tgt = toSig(target);
  let velocity: T = scale(sub(tgt.peek(), tgt.peek()), 0);
  return drive((dt) => {
    const t = tgt.value;
    const cur = sig.peek();
    const displacement = sub(t, cur);
    const force = scale(displacement, stiffness);
    const drag = scale(velocity, -damping);
    velocity = add(velocity, scale(add(force, drag), dt));
    sig.value = add(cur, scale(velocity, dt));
    if (eps > 0 && normOf(displacement) < eps && normOf(velocity) < eps) {
      sig.value = t;
      return false;
    }
  });
}

/** Sinusoidal oscillation around the signal's initial value. Never returns. */
export function oscillate<T = number>(
  sig: Signal<T>,
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
  sig: Signal<T>,
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
  sig: Signal<T>,
  velocity: Val<T>,
): Animator {
  const { add, scale } = algebraOf(sig);
  const V = toSig(velocity);
  return drive((dt) => {
    sig.value = add(sig.peek(), scale(V.value, dt));
  });
}
