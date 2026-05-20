// anim.ts — animator primitives over nominal trait constraints.
//
// All signatures inline `Traits<T, "linear" | …>` — no per-consumer alias.
// Reads as a sentence: "spring takes a signal that has linear + metric."
// Compile error if you pass `spring(box, …)` (no metric) or
// `spring(signal(0), …)` (no traits dict).
//
// Math is verbatim from prod's lerp.ts.

import { Signal, type Val, value as readVal } from "./signal";
import {
  requireLinear, requireLerp, requireMetric,
  type Traits,
} from "./traits";
import {
  drive, type Animator, type Easing, easeOut,
} from "../core";

const defaultEase = easeOut;

// ─── tween ──────────────────────────────────────────────────────────

/** Append-only tween segment over a reactive target. */
export function* tweenStep<T>(
  sig: Traits<T, "lerp">,
  target: T,
  dur: Val<number>,
  ease: Easing = defaultEase,
): Animator<void> {
  const lerp = requireLerp(sig);
  const start = sig.peek();
  const D = valFn(dur);
  yield* drive((tick, t) => {
    const total = D();
    if (total <= 0 || t + tick.dt * 1e-3 >= total) {
      sig.value = target;
      return false;
    }
    sig.value = lerp(start, target, ease(t / total));
  });
}

/** Free-fn form of one-shot tween. */
export function tween<T>(
  sig: Traits<T, "lerp">,
  target: T,
  dur: Val<number>,
  ease?: Easing,
): Animator<void> {
  return tweenStep(sig, target, dur, ease);
}

// ─── spring ─────────────────────────────────────────────────────────

export interface SpringOpts {
  /** Natural angular frequency (rad/s). Default 13 (~0.48 s period). */
  omega?: number;
  /** Damping ratio. <1 underdamped, =1 critical, >1 overdamped. Default 1. */
  zeta?: number;
  /** Settle threshold; snap+complete when both ‖e‖ < eps and ‖v‖ < eps·ω. */
  precision?: number;
}

/** Second-order damped-spring pull. Math unchanged from prod's `spring`. */
export function* spring<T>(
  sig: Traits<T, "linear" | "metric">,
  target: Val<T>,
  opts: SpringOpts = {},
): Animator<void> {
  const lin = requireLinear(sig);
  const met = requireMetric(sig);
  const omega = opts.omega ?? 13;
  const zeta = opts.zeta ?? 1;
  const eps = opts.precision ?? 1e-4;
  const T = valFn(target);

  const zero: T = lin.scale(sig.peek(), 0);
  let vel: T = zero;

  yield* drive((tick) => {
    const dt = tick.dt;
    const t = T();
    const cur = sig.peek();
    const e0 = lin.sub(cur, t);
    const v0 = vel;

    let e1: T, v1: T;
    if (zeta < 1 - 1e-6) {
      const zw = zeta * omega;
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const E = Math.exp(-zw * dt);
      const c = Math.cos(wd * dt);
      const s = Math.sin(wd * dt);
      const B = lin.scale(lin.add(v0, lin.scale(e0, zw)), 1 / wd);
      const inner = lin.add(lin.scale(e0, c), lin.scale(B, s));
      e1 = lin.scale(inner, E);
      const swing = lin.sub(lin.scale(B, c), lin.scale(e0, s));
      v1 = lin.add(lin.scale(e1, -zw), lin.scale(swing, E * wd));
    } else if (zeta > 1 + 1e-6) {
      const r = omega * Math.sqrt(zeta * zeta - 1);
      const r1 = -zeta * omega + r;
      const r2 = -zeta * omega - r;
      const denom = r2 - r1;
      const B = lin.scale(lin.sub(v0, lin.scale(e0, r1)), 1 / denom);
      const A = lin.sub(e0, B);
      const E1 = Math.exp(r1 * dt);
      const E2 = Math.exp(r2 * dt);
      e1 = lin.add(lin.scale(A, E1), lin.scale(B, E2));
      v1 = lin.add(lin.scale(A, r1 * E1), lin.scale(B, r2 * E2));
    } else {
      const E = Math.exp(-omega * dt);
      const B = lin.add(v0, lin.scale(e0, omega));
      const Bt = lin.scale(B, dt);
      e1 = lin.scale(lin.add(e0, Bt), E);
      v1 = lin.sub(lin.scale(B, E), lin.scale(e1, omega));
    }

    vel = v1;
    sig.value = lin.add(t, e1);

    if (eps > 0 && met(e1, zero) < eps && met(v1, zero) < eps * omega) {
      sig.value = t;
      return false;
    }
  });
}

// ─── toward / attract ──────────────────────────────────────────────

/** Constant-speed approach (units-of-T per second). Needs linear+metric. */
export function* toward<T>(
  sig: Traits<T, "linear" | "metric">,
  target: Val<T>,
  speed: Val<number>,
): Animator<void> {
  const lin = requireLinear(sig);
  const met = requireMetric(sig);
  const T = valFn(target);
  const S = valFn(speed);
  yield* drive((tick) => {
    const t = T();
    const cur = sig.peek();
    const dist = met(cur, t);
    const step = S() * tick.dt;
    if (dist <= step) {
      sig.value = t;
      return false;
    }
    const dir = lin.scale(lin.sub(t, cur), 1 / dist);
    sig.value = lin.add(cur, lin.scale(dir, step));
  });
}

/** Exponential pull toward `target` at rate `k`/s (no overshoot). Needs linear. */
export function* attract<T>(
  sig: Traits<T, "linear">,
  target: Val<T>,
  k: Val<number> = 1,
): Animator<void> {
  const lin = requireLinear(sig);
  const T = valFn(target);
  const K = valFn(k);
  yield* drive((tick) => {
    const cur = sig.peek();
    const delta = lin.scale(lin.sub(T(), cur), K() * tick.dt);
    sig.value = lin.add(cur, delta);
  });
}

// ─── helpers ────────────────────────────────────────────────────────

function valFn<T>(v: Val<T>): () => T {
  if (v instanceof Signal) return () => v.value;
  if (typeof v === "function") return v as () => T;
  return () => v as T;
}

/** Re-export with the proto's `value()` so consumers don't reach into core. */
export const value = readVal;
