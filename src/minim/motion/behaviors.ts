// Open-ended, frame-driven dynamics — generators that integrate `dt`
// into a signal. No pre-allocated samples; the loop body is a handful
// of flops per step. Pair with `anim.run(...)` (forever) or
// `until(trigger, …)` / `race(...)` for bounded use.
//
// Motion stdlib taxonomy:
//   transitions   — bounded pose-then-tween (`fadeUp`, `slideIn`, …)
//   tweens        — `sig.to(target, sec)` — explicit duration, easing
//   behaviors     — open-ended dynamics (this file)
//   choreographers — multi-shape coordination (`swap`, `stagger`, …)

import type { Animator, Arg } from "../core";
import { toSig } from "../core";
import type { Signal } from "../core/signal";

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
    const dt = yield;
    const dx = tgt.value - sig.value;
    v += (k * dx - c * v) * dt;
    sig.value += v * dt;
    if (eps > 0 && Math.abs(dx) < eps && Math.abs(v) < eps) {
      sig.value = tgt.value;
      return;
    }
  }
}

/** Sinusoidal oscillation around `sig`'s initial value. `amp` and
 *  `freq` (Hz) may be reactive. Never returns. */
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
    const dt = yield;
    t += dt;
    sig.value = base + A.value * Math.sin(2 * Math.PI * F.value * t);
  }
}

/** Constant-velocity drift; `vel` units per second (reactive). */
export function* drift(sig: Signal<number>, vel: Arg<number>): Animator {
  const V = toSig(vel);
  while (true) {
    const dt = yield;
    sig.value += V.value * dt;
  }
}

/** Exponential pull toward `target` with rate `k` per second (k=1
 *  closes ~63% of distance per second). No overshoot, no velocity —
 *  good for trails, smoothing, low-pass filters. */
export function* attract(
  sig: Signal<number>,
  target: Arg<number>,
  k: Arg<number> = 1,
): Animator {
  const T = toSig(target);
  const K = toSig(k);
  while (true) {
    const dt = yield;
    sig.value += (T.value - sig.value) * K.value * dt;
  }
}
