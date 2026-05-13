// Single tween engine. `Signal.prototype.to(target, dur, ease)` is
// generic — it looks up the lerp function via a prototype-chain
// `[LERP]` slot. The struct framework sets that slot per-struct
// prototype with the user's registered `lerp` op. Raw `Signal<number>`
// has no slot → falls back to scalar `numberLerp`.
//
// One engine, one method, one definition. No hardcoded type checks,
// no special cases for Vec / etc. Adding a value type with `lerp`
// registered is enough — the framework wires up `.to` automatically
// via the prototype slot.

import { Signal, computed, signal, type ReadonlySignal } from "./signal";
import { drive } from "./drive";
import type { Animator, Yieldable } from "./anim";

export type Easing = (t: number) => number;
const defaultEase: Easing = (t) => 1 - (1 - t) * (1 - t); // easeOut

/** Seconds, fixed or reactive (read each frame). */
export type Duration = number | ReadonlySignal<number>;

/** A yieldable tween. Chain with `.to` — `sig.to(a, s).to(b, s)` goes
 *  a then b. */
export interface Tween<T> extends Generator<Yieldable, void, number> {
  to(target: T, dur: Duration, ease?: Easing): Tween<T>;
}

/** Per-value-type lerp; the struct framework registers via the `[LERP]`
 *  prototype slot. Default for raw `Signal<number>` is the scalar lerp. */
export type Lerp<T> = (a: T, b: T, t: number) => T;

const numberLerp: Lerp<number> = (a, b, t) => a + (b - a) * t;

/** Hidden prototype slot that carries the value type's lerp.
 *  @internal — exported for the struct framework only. */
export const LERP = Symbol("minim.lerp");

// ── The engine: one tween-step on top of `drive` ────────────────────

function tweenStep<T>(
  sig: Signal<T>,
  target: T,
  dur: Duration,
  ease: Easing,
  lerp: Lerp<T>,
): Animator {
  const start = sig.peek();
  return drive((_dt, t) => {
    const total = typeof dur === "number" ? dur : dur.value;
    if (t >= total) {
      sig.value = target;
      return false;
    }
    const u = total > 0 ? t / total : 1;
    sig.value = lerp(start, target, ease(u));
  });
}

function makeTween<T>(
  sig: Signal<T>,
  target: T,
  dur: Duration,
  ease: Easing,
  lerp: Lerp<T>,
  prior?: Generator<Yieldable, void, number>,
): Tween<T> {
  const gen = (function* (): Animator {
    if (prior) yield* prior;
    yield* tweenStep(sig, target, dur, ease, lerp);
  })() as Tween<T>;
  gen.to = (t, d, e) => makeTween(sig, t, d, e ?? defaultEase, lerp, gen);
  return gen;
}

/** Free-function tween — used internally and exported for callers
 *  that want to tween a signal whose value type doesn't have a
 *  registered struct algebra (passes the lerp explicitly). */
export function tween<T>(
  sig: Signal<T>,
  target: T,
  dur: Duration,
  ease?: Easing,
  lerp?: Lerp<T>,
): Tween<T> {
  const e = ease ?? defaultEase;
  const l = lerp ?? ((sig as any)[LERP] as Lerp<T> | undefined) ??
    (numberLerp as unknown as Lerp<T>);
  return makeTween(sig, target, dur, e, l);
}

/** Plain Signal whose `.to(...)` uses your `lerp` via the `[LERP]` slot.
 *  Escape hatch for value types you don't want to declare as a full struct. */
export function lerpable<T>(initial: T, lerp: Lerp<T>): Signal<T> {
  const s = signal(initial);
  (s as any)[LERP] = lerp;
  return s;
}

// ── Install `.to` and `.derive` on Signal.prototype ────────────────
//
// Runtime install lives here. Type-level declaration-merging (the
// `interface Signal { to, derive }` augmentation) lives in
// `core/signal.ts` for both methods — keeping all the type
// declarations inside the original module file avoids TS getting
// confused by module-augmentation across files vs declaration-merging
// inside the file.

(Signal.prototype as any).to = function <T>(
  this: Signal<T>,
  target: T,
  dur: Duration,
  ease?: Easing,
): Tween<T> {
  const e = ease ?? defaultEase;
  const lerp =
    ((this as any)[LERP] as Lerp<T> | undefined) ??
    (numberLerp as unknown as Lerp<T>);
  return makeTween(this, target, dur, e, lerp);
};

(Signal.prototype as any).derive = function <T, U>(
  this: Signal<T>,
  fn: (v: T) => U,
): ReadonlySignal<U> {
  return computed(() => fn(this.value));
};
