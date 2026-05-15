// Continuous behaviors — generator-flavored integrators that drive a
// cell per frame. Generic over any cell with a registered `linear`
// capability (Num, Vec, Transform, Color, Box). Spring's auto-settle
// additionally requires a `metric`.
//
// Pattern: each behavior returns an `Animator` (a generator) yielding
// once per frame. The runtime (Anim) feeds `dt` each step. Cancellation
// from outside unwinds the loop. Reactive args (target, amp, freq,
// velocity, k) are polled each frame, so a moving target makes the
// follower chase, a reactive `freq` modulates oscillation, etc.
//
// Direct signals2 callable API:
//   sig(x)      — write
//   sig.peek()  — untracked read
//   sig.type    — capability dispatch
//
// The legacy `behaviors.ts` used `.value` setters + `algebraOf`/
// `metricOf` helpers. Same algorithms, less indirection here.

import { drive, type Animator } from "@minim/core";
import type { Cell, Type, Val } from "./cell";
import { valOf } from "./cell";

// ── Capability helpers ──────────────────────────────────────────────

function typeOf<T>(sig: Cell<T, any>): Type<T, any> {
  const t = sig.type;
  if (!t) throw new Error(
    "behavior called on a typeless cell. " +
    "Use a typed cell (e.g. `Vec({...})`, `num(0)`) instead of bare `cell(...)`.",
  );
  return t;
}

function linearOf<T>(sig: Cell<T, any>) {
  const t = typeOf(sig);
  if (!t.linear) {
    throw new Error(
      `behavior on '${(t as any).name ?? "<unnamed>"}': type has no linear ` +
      "capability (add/sub/scale required for spring/oscillate/drift/attract).",
    );
  }
  return t.linear;
}

// ── Spring ──────────────────────────────────────────────────────────

export interface SpringOpts {
  /** Hooke stiffness; higher → faster pull. Default 170. */
  stiffness?: number;
  /** Velocity damping; higher → less oscillation. Default 26. */
  damping?: number;
  /** Settle threshold: complete when both `distance(cur, target)` and
   *  `distance(velocity, zero)` fall below this. `0` (default) runs
   *  forever. Requires the cell's type to register a `metric`. */
  precision?: number;
}

/** Critically-damped-ish spring chase. Target may be reactive. */
export function spring<T>(
  sig: Cell<T, any>,
  target: Val<T>,
  opts: SpringOpts = {},
): Animator {
  const { add, sub, scale } = linearOf(sig);
  const stiffness = opts.stiffness ?? 170;
  const damping = opts.damping ?? 26;
  const eps = opts.precision ?? 0;
  // Auto-settle uses the cell's metric. If eps > 0 but no metric is
  // registered, settle never fires → spring runs forever.
  const distance = eps > 0 ? typeOf(sig).metric : undefined;
  const tgt: () => T = typeof target === "function" ? (target as () => T) : () => target as T;
  // Zero of the vector space — `scale(any, 0)` produces the identity.
  const zero: T = scale(sub(tgt(), tgt()), 0);
  let velocity: T = zero;
  return drive((dt) => {
    const t = tgt();
    const cur = sig.peek();
    const displacement = sub(t, cur);
    const force = scale(displacement, stiffness);
    const drag = scale(velocity, -damping);
    velocity = add(velocity, scale(add(force, drag), dt));
    sig(add(cur, scale(velocity, dt)));
    if (
      distance !== undefined &&
      distance(cur, t) < eps &&
      distance(velocity, zero) < eps
    ) {
      sig(t);
      return false;
    }
  });
}

// ── Oscillate ───────────────────────────────────────────────────────

/** Sinusoidal oscillation around the signal's initial value.
 *  Never returns (cancel externally to stop). */
export function oscillate<T>(
  sig: Cell<T, any>,
  amp: Val<T>,
  freq: Val<number>,
): Animator {
  const { add, scale } = linearOf(sig);
  const base = sig.peek();
  return drive((_dt, t) => {
    sig(add(base, scale(valOf(amp), Math.sin(2 * Math.PI * valOf(freq) * t))));
  });
}

// ── Attract ─────────────────────────────────────────────────────────

/** Exponential pull toward target with rate `k` per second
 *  (k=1 closes ~63% of remaining distance per second). No overshoot. */
export function attract<T>(
  sig: Cell<T, any>,
  target: Val<T>,
  k: Val<number> = 1,
): Animator {
  const { add, sub, scale } = linearOf(sig);
  return drive((dt) => {
    const cur = sig.peek();
    const delta = scale(sub(valOf(target), cur), valOf(k) * dt);
    sig(add(cur, delta));
  });
}

// ── Drift ───────────────────────────────────────────────────────────

/** Constant-velocity advance. Velocity may be reactive (flip live to
 *  reverse direction). */
export function drift<T>(
  sig: Cell<T, any>,
  velocity: Val<T>,
): Animator {
  const { add, scale } = linearOf(sig);
  return drive((dt) => {
    sig(add(sig.peek(), scale(valOf(velocity), dt)));
  });
}
