// Frame-driven integrators — generators that step `dt` into one or
// more signals, never returning until cancelled (with the spring-
// precision exception). Built on `drive`. Pair with `anim.run(...)`
// (forever) or `endOn(trigger, …)` / `race(...)` for bounded use.
//
// What unifies this file: every export integrates `dt` into a signal.
// Whether the signal is called a "clock" or a "position" is purely
// naming — the runtime is the same.

import type { Animator, Arg, Vec } from "../core";
import { drive, toSig } from "../core";
import type { Signal } from "../core/signal";
import type { Pointlike, Writable } from "../scene";

// ── Scalar integrators ──────────────────────────────────────────────

export interface SpringOpts {
  /** Stiffness — pull strength. Default 170 (Framer-style critical). */
  stiffness?: number;
  /** Damping — velocity drag. Default 26. */
  damping?: number;
  /** Settle threshold. When `|dx|` and `|v|` are both below this for
   *  one frame, snap to target and complete. `0` (default) runs
   *  forever — handy when the target keeps moving. */
  precision?: number;
}

/** Critically-damped spring chase. `target` may be a signal — the
 *  follower keeps chasing a moving point. */
export function spring(
  sig: Signal<number>,
  target: Arg<number>,
  opts: SpringOpts = {},
): Animator {
  const tgt = toSig(target);
  const k = opts.stiffness ?? 170;
  const c = opts.damping ?? 26;
  const eps = opts.precision ?? 0;
  let v = 0;
  return drive((dt) => {
    const dx = tgt.value - sig.value;
    v += (k * dx - c * v) * dt;
    sig.value += v * dt;
    if (eps > 0 && Math.abs(dx) < eps && Math.abs(v) < eps) {
      sig.value = tgt.value;
      return false;
    }
  });
}

/** Sinusoidal oscillation around `sig`'s initial value. `amp` and
 *  `freq` (Hz) may be reactive. Never returns. */
export function oscillate(
  sig: Signal<number>,
  amp: Arg<number>,
  freq: Arg<number>,
): Animator {
  const A = toSig(amp);
  const F = toSig(freq);
  const base = sig.peek();
  return drive((_, t) => {
    sig.value = base + A.value * Math.sin(2 * Math.PI * F.value * t);
  });
}

/** Advance `sig` at velocity `vel` per second (reactive — negatives
 *  reverse, signal lets you scrub live). Doubles as a clock-speed
 *  modulator: `drift(clock, rate)` runs the clock at `rate`. */
export function drift(sig: Signal<number>, vel: Arg<number>): Animator {
  const V = toSig(vel);
  return drive((dt) => {
    sig.value += V.value * dt;
  });
}

/** Exponential pull toward `target` with rate `k` per second (k=1
 *  closes ~63% of distance per second). No overshoot, no velocity —
 *  good for trails, smoothing, low-pass filters. */
export function attract(
  sig: Signal<number>,
  target: Arg<number>,
  k: Arg<number> = 1,
): Animator {
  const T = toSig(target);
  const K = toSig(k);
  return drive((dt) => {
    sig.value += (T.value - sig.value) * K.value * dt;
  });
}

// ── Multi-shape integrator ──────────────────────────────────────────

/** Continuous orbit around `center`, one revolution per `period`
 *  seconds. Picks up each shape's current radius/angle (no jump). Never
 *  returns. `rate` (default 1) is a reactive multiplier — tween it for
 *  ease-in/out; negatives reverse; 0 pauses. */
export function orbit(
  center: Pointlike,
  shapes: readonly Writable<"translate">[],
  opts: { period?: number; rate?: Arg<number> } = {},
): Animator {
  const period = opts.period ?? 4;
  const rate = toSig(opts.rate ?? 1);
  const omega = (2 * Math.PI) / period;
  const N = shapes.length;
  const c0 = center.value;
  const init = shapes.map((sh) => {
    const v = sh.translate.peek();
    const dx = v.x - c0.x;
    const dy = v.y - c0.y;
    return { angle: Math.atan2(dy, dx), radius: Math.hypot(dx, dy) };
  });
  // Own `t`, not drive's: needs reactive-rate scaling per step.
  let t = 0;
  return drive((dt) => {
    t += dt * rate.value;
    const c = center.value;
    for (let i = 0; i < N; i++) {
      const angle = init[i].angle + omega * t;
      const point: Vec = {
        x: c.x + init[i].radius * Math.cos(angle),
        y: c.y + init[i].radius * Math.sin(angle),
      };
      shapes[i].translate.value = point;
    }
  });
}
