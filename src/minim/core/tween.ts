// Single tween engine — one definition, one `[LERP]` slot, no
// hardcoded type checks. The struct framework installs `.to` on each
// registered writable Reactive's prototype, so:
//
//   Num.signal(0).to(100, 0.5)        works
//   Vec.signal({x,y}).to({...}, 0.5)  works
//   signal(0).to(...)                 does NOT exist
//
// Plain `signal()` (the bare preact factory) does not get `.to`
// installed — minim no longer patches the signals library at all.
// For value types you don't want to declare as a full struct, use the
// standalone `tween(sig, target, dur, ease, lerp)` form.
//
// `Tween<T>` extends `Chained<void>`: `.to(...)` chains another
// segment; `.until / .while / .for / .at` preserve `Tween<T>` so
// `x.to(100, 0.5).to(0, 0.5).until(stop)` keeps the typed surface;
// `.then(y)` returns plain `Chained<unknown>` — leaves the tween
// world.

import { Signal, computed, signal, type ReadonlySignal } from "./signal";
import { drive } from "./drive";
import { ChainedImpl, type Chained } from "./chain";
import { race, untilTrue, untilFalse } from "./suspensions";
import { suspend, isGen, type Animator } from "./anim";

export type Easing = (t: number) => number;
const defaultEase: Easing = (t) => 1 - (1 - t) * (1 - t); // easeOut

/** Seconds, fixed or reactive (read each frame). */
export type Duration = number | ReadonlySignal<number>;

/** Per-value-type lerp; the struct framework registers via the
 *  `[LERP]` prototype slot. Default for raw `Signal<number>` (used
 *  only by standalone `tween()`) is the scalar lerp. */
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

// ── Tween<T>: Chained<void> + .to() continuation + Tween-preserving overrides ─

/** A tween — a Chained<void> that adds `.to(...)` for continuation
 *  segments and preserves itself through `.until / .while / .for / .at`.
 *  `.then(y)` returns plain `Chained<unknown>` (leaves the tween world). */
export interface Tween<T> extends Chained<void> {
  /** Append another segment that runs after this one. */
  to(target: T, dur: Duration, ease?: Easing): Tween<T>;
  // Tween-preserving overrides of the Chained methods.
  until(cond: ReadonlySignal<unknown> | Animator): Tween<T>;
  while(sig: ReadonlySignal<unknown>): Tween<T>;
  for(n: number | Animator): Tween<T>;
  at(scale: number | ReadonlySignal<number> | (() => number)): Tween<T>;
}

class TweenImpl<T> extends ChainedImpl<void> implements Tween<T> {
  // `_sig` + `_lerp` are carried so `.to(...)` can append fresh
  // segments off the same signal with the same lerp.
  constructor(
    private readonly _sig: Signal<T>,
    private readonly _lerp: Lerp<T>,
    g: Animator<void>,
  ) {
    super(g);
  }

  to(target: T, dur: Duration, ease?: Easing): Tween<T> {
    const prior = this._g;
    const sig = this._sig;
    const lerp = this._lerp;
    const e = ease ?? defaultEase;
    const next = (function* (): Animator {
      yield* prior;
      yield* tweenStep(sig, target, dur, e, lerp);
    })();
    return new TweenImpl(sig, lerp, next);
  }

  // ── Tween-preserving overrides ───────────────────────────────────
  override until(cond: ReadonlySignal<unknown> | Animator): Tween<T> {
    const trigger = isGen(cond) ? cond : untilTrue(cond);
    return new TweenImpl(
      this._sig,
      this._lerp,
      race(this._g, trigger) as Animator<void>,
    );
  }
  override while(sig: ReadonlySignal<unknown>): Tween<T> {
    return new TweenImpl(
      this._sig,
      this._lerp,
      race(this._g, untilFalse(sig)) as Animator<void>,
    );
  }
  override for(n: number | Animator): Tween<T> {
    const bound =
      typeof n === "number"
        ? (function* (): Animator {
            if (n > 0) yield n;
          })()
        : n;
    return new TweenImpl(
      this._sig,
      this._lerp,
      race(this._g, bound) as Animator<void>,
    );
  }
  override at(
    scale: number | ReadonlySignal<number> | (() => number),
  ): Tween<T> {
    const arg: number | (() => number) =
      typeof scale === "number"
        ? scale
        : typeof scale === "function"
          ? (scale as () => number)
          : () => (scale as ReadonlySignal<number>).value;
    const g = this._g;
    const scaled = suspend<void>((wake, spawn) => {
      const finish = () => (wake as () => void)();
      return spawn(g, finish, arg);
    });
    return new TweenImpl(this._sig, this._lerp, scaled);
  }

  // `.then(...)` leaves the tween world (inherited from ChainedImpl).
}

/** Build a fresh `Tween<T>` for a signal. The struct framework calls
 *  this when installing `.to` on registered writable Reactive
 *  prototypes; users normally just call `cell.to(...)`. */
export function makeTween<T>(
  sig: Signal<T>,
  target: T,
  dur: Duration,
  ease: Easing,
  lerp: Lerp<T>,
): Tween<T> {
  return new TweenImpl<T>(sig, lerp, tweenStep(sig, target, dur, ease, lerp));
}

/** Free-function tween — escape hatch for value types whose signal
 *  doesn't have a registered struct algebra. Without `lerp`, looks up
 *  `[LERP]` on the signal's prototype; falls back to `numberLerp`. */
export function tween<T>(
  sig: Signal<T>,
  target: T,
  dur: Duration,
  ease?: Easing,
  lerp?: Lerp<T>,
): Tween<T> {
  const e = ease ?? defaultEase;
  const l =
    lerp ??
    ((sig as any)[LERP] as Lerp<T> | undefined) ??
    (numberLerp as unknown as Lerp<T>);
  return makeTween(sig, target, dur, e, l);
}

/** Plain Signal with `[LERP]` stamped — used by the standalone
 *  `tween(sig, ...)` form to find the lerp via prototype lookup.
 *  The signal itself does NOT gain a `.to` method — minim no longer
 *  patches Signal.prototype. */
export function lerpable<T>(initial: T, lerp: Lerp<T>): Signal<T> {
  const s = signal(initial);
  (s as any)[LERP] = lerp;
  return s;
}

// ── `.derive` is the only Signal.prototype patch that remains ──────
//
// Convenience for "compute a derived signal from this one in-place".
// Used widely. Independent of the tween machinery; lives here only by
// historical accident. Kept as a Signal.prototype install for now —
// when we exit preact-signals entirely, this moves to a wrapper.

(Signal.prototype as any).derive = function <T, U>(
  this: Signal<T>,
  fn: (v: T) => U,
): ReadonlySignal<U> {
  return computed(() => fn(this.value));
};
