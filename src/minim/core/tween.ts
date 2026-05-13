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

/** Lerp function for a value type. The struct framework registers one
 *  per struct via the `[LERP]` prototype slot; integrators read it
 *  via the same slot. The default (used for raw `Signal<number>`)
 *  is the scalar lerp. */
export type Lerp<T> = (a: T, b: T, t: number) => T;

const numberLerp: Lerp<number> = (a, b, t) => a + (b - a) * t;

/** Hidden prototype slot that carries the value type's lerp.
 *  @internal — exported for the struct framework only. */
export const LERP = Symbol("minim.lerp");

// ── The engine: one generator function ──────────────────────────────

function* tweenStep<T>(
  sig: Signal<T>,
  target: T,
  dur: Duration,
  ease: Easing,
  lerp: Lerp<T>,
): Animator {
  const start = sig.peek();
  let elapsed = 0;
  while (true) {
    const total = typeof dur === "number" ? dur : dur.value;
    if (elapsed >= total) break;
    const dt: number = yield;
    elapsed += dt;
    const t = total > 0 ? Math.min(elapsed / total, 1) : 1;
    sig.value = lerp(start, target, ease(t));
  }
  sig.value = target;
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

/** Construct a `Signal<T>` that knows how to tween itself. The value
 *  type can be anything — strings, dates, custom objects — as long as
 *  you provide a `lerp(a, b, t) → T`. The returned signal's `.to(...)`
 *  uses your lerp via the same prototype `[LERP]` slot the struct
 *  framework uses for Vec / Color / etc.
 *
 *  Use when you have a value type that doesn't fit the struct schema
 *  (Schema is `Record<string, number | StructType>` — strings, enums,
 *  arrays, etc. don't qualify) but you still want generic `.to`.
 *
 *  Example:
 *
 *      const text = lerpable("hello", typewriterLerp);
 *      yield* text.to("goodbye", 0.6);
 */
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
