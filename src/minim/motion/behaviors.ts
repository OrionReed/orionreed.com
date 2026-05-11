// Behaviors: open-ended, frame-driven generators that animate a signal
// without a fixed duration. Each is a thin wrapper around an `Animator`
// that integrates a per-frame `dt` into the signal's value. They never
// pre-allocate samples — the loop body is always proportional to one
// step (a few flops). Pair with `anim.run(...)` (returns a disposer)
// or `until(trigger, behavior)` / `race(...)` for bounded use.
//
// Motion stdlib taxonomy:
//   transitions — bounded, pose → tween (`fadeUp`, `slideIn`, …)
//   tweens      — `sig.to(target, sec)` — explicit duration, easing
//   behaviors   — open-ended dynamics (this file)
//   choreographers — multi-shape coordination (`swap`, `stagger`, …)

import type { Animator, Arg } from "../core";
import { toSig } from "../core";
import type { Signal } from "../core/signal";

export interface SpringOpts {
  /** Stiffness — pull strength (default 170, Framer-style critical). */
  stiffness?: number;
  /** Damping — velocity drag (default 26 for visual critical-damping). */
  damping?: number;
  /** Settle threshold. When `|dx| < precision` and `|v| < precision`
   *  for one frame, snap to target and complete. `0` (default) runs
   *  forever — handy when the target is itself moving. */
  precision?: number;
}

/** Critically-damped spring chase. Each frame, integrate
 *  `a = stiffness · (target − sig) − damping · v` and apply velocity.
 *  Reactive: `target` may be a signal, so the follower keeps chasing
 *  a moving point. Cancel via `anim.run(...)`'s disposer or wrap in
 *  `until(trigger, spring(...))` for bounded use. */
export function* spring(
  sig: Signal<number>,
  target: Arg<number>,
  opts: SpringOpts = {},
): Animator {
  const tgt = toSig(target);
  const k = opts.stiffness ?? 170;
  const c = opts.damping ?? 26;
  const eps = opts.precision ?? 0;
  let v = 0;
  while (true) {
    const dt: number = yield;
    const dx = tgt.value - sig.value;
    v += (k * dx - c * v) * dt;
    sig.value += v * dt;
    if (eps > 0 && Math.abs(dx) < eps && Math.abs(v) < eps) {
      sig.value = tgt.value;
      return;
    }
  }
}

/** Sinusoidal oscillation around `sig`'s value at start. `amp` and
 *  `freq` (Hz) may be reactive — dial them while the loop runs.
 *  Never returns; cancel via the run disposer. */
export function* oscillate(
  sig: Signal<number>,
  amp: Arg<number>,
  freq: Arg<number>,
): Animator {
  const A = toSig(amp);
  const F = toSig(freq);
  const base = sig.peek();
  let t = 0;
  while (true) {
    const dt: number = yield;
    t += dt;
    sig.value = base + A.value * Math.sin(2 * Math.PI * F.value * t);
  }
}

/** Constant-velocity drift; `vel` units per second (reactive). */
export function* drift(sig: Signal<number>, vel: Arg<number>): Animator {
  const V = toSig(vel);
  while (true) {
    const dt: number = yield;
    sig.value += V.value * dt;
  }
}

/** Soft attractor — exponential pull toward `target` with rate `k`
 *  per second (1 = ~63% of distance closed in 1s). Asymmetric with
 *  `spring`: no overshoot, no velocity. Useful for cursor-trail follow,
 *  smoothed inputs, low-pass filters on noisy signals. */
export function* attract(
  sig: Signal<number>,
  target: Arg<number>,
  k: Arg<number> = 1,
): Animator {
  const T = toSig(target);
  const K = toSig(k);
  while (true) {
    const dt: number = yield;
    sig.value += (T.value - sig.value) * K.value * dt;
  }
}
