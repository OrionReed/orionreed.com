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
// Why this shape rather than auto-installing methods on Reactive:
//
//  - The algebra a struct exposes (add, sub, scale, lerp, …) names
//    operations on the value type — not capability claims about it.
//    "Has add+sub+scale" doesn't mean "is a vector space" any more
//    than "has push/pop" means "is a stack."
//  - Multiple integrators want the same algebra (spring, oscillate,
//    drift, attract, orbit). One auto-detection would either install
//    all of them or pick favorites — both are wrong.
//  - Integrators are library code. New ones (e.g. user-defined
//    physics) shouldn't require framework changes.
//
// Why the algebra lives on the prototype rather than being passed
// explicitly:
//
//  - The user shouldn't have to know which algebra goes with which
//    struct. `spring(p, target)` reads as cleanly as `p.to(target)`.
//  - Per-call cost is one prototype-chain symbol read at integrator
//    construction (not per frame). Effectively free.

import type { Signal } from "../core/signal";
import type { Animator } from "../core/anim";
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

export interface SpringOpts {
  /** Spring stiffness (Hooke). Higher → faster pull-back. Default 170. */
  stiffness?: number;
  /** Velocity damping. Higher → less oscillation. Default 26. */
  damping?: number;
}

/** Critically-damped spring chase. Works for any value type whose
 *  registered struct has a vector-space algebra (add + sub + scale).
 *  Defaults to scalar.
 *
 *  No built-in stop condition by design — the caller wraps with
 *  `endOn` / `race(...)` to bound the run. This keeps the integrator
 *  pure: the framework doesn't have to know what "close enough" means
 *  for arbitrary value types. */
export function* spring<T = number>(
  sig: Signal<T>,
  target: T,
  opts: SpringOpts = {},
): Animator {
  const { add, sub, scale } = algebraOf(sig);
  const stiffness = opts.stiffness ?? 170;
  const damping = opts.damping ?? 26;
  let velocity: T = scale(sub(target, target), 0);
  while (true) {
    const dt: number = yield;
    const cur = sig.peek();
    const displacement = sub(target, cur);
    const force = scale(displacement, stiffness);
    const drag = scale(velocity, -damping);
    const accel = add(force, drag);
    velocity = add(velocity, scale(accel, dt));
    sig.value = add(cur, scale(velocity, dt));
  }
}

/** Sinusoidal oscillation around the signal's initial value. The
 *  amplitude is a value of type T (component-wise for vectors). */
export function* oscillate<T = number>(
  sig: Signal<T>,
  amp: T,
  freq: number,
): Animator {
  const { add, scale } = algebraOf(sig);
  const base = sig.peek();
  let t = 0;
  while (true) {
    const dt: number = yield;
    t += dt;
    sig.value = add(base, scale(amp, Math.sin(2 * Math.PI * freq * t)));
  }
}

/** Exponential pull toward target with rate `k` per second
 *  (k=1 closes ~63% of distance per second). No overshoot, no
 *  velocity. Same algebra requirements as `spring` but cheaper. */
export function* attract<T = number>(
  sig: Signal<T>,
  target: T,
  k: number = 1,
): Animator {
  const { add, sub, scale } = algebraOf(sig);
  while (true) {
    const dt: number = yield;
    const cur = sig.peek();
    const delta = scale(sub(target, cur), k * dt);
    sig.value = add(cur, delta);
  }
}

/** Constant-velocity advance. Uses just add + scale. */
export function* drift<T = number>(
  sig: Signal<T>,
  velocity: T,
): Animator {
  const { add, scale } = algebraOf(sig);
  while (true) {
    const dt: number = yield;
    sig.value = add(sig.peek(), scale(velocity, dt));
  }
}
