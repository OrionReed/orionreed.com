// Single tween engine — one definition, one `[LERP]` slot, no
// hardcoded type checks and no implicit fallbacks. The struct framework
// installs `.to` on each registered writable Reactive's prototype, so:
//
//   Num.signal(0).to(100, 0.5)        works
//   Vec.signal({x,y}).to({...}, 0.5)  works
//   signal(0).to(...)                 does NOT exist
//
// Plain `signal()` (the bare preact factory) does not get `.to`
// installed — minim no longer patches the signals library at all.
// For value types you don't want to declare as a full struct, either
// pass `lerp` explicitly to `tween()` or use `lerpable(value, lerp)`
// which stamps the `[LERP]` slot on a plain signal. There is NO
// scalar-number fallback — `tween()` throws if neither path provides
// a lerp.
//
// `Tween<T>` extends `Chained<void>`: `.to(...)` chains another
// segment; `.until / .while / .for / .at` preserve `Tween<T>` so
// `x.to(100, 0.5).to(0, 0.5).until(stop)` keeps the typed surface;
// `.then(y)` returns plain `Chained<unknown>` — leaves the tween
// world.

import { type Signal, signal } from "./signal";
import { drive } from "./drive";
import { ChainedImpl, type Chained } from "./chain";
import { type Animator } from "./anim";
import { toSig, type Val } from "./arg";
import { easeOut } from "./easings";

export type Easing = (t: number) => number;
const defaultEase: Easing = easeOut;

/** Tween duration: number, signal, or thunk (read each frame). */
export type Duration = Val<number>;

/** Per-value-type lerp; the struct framework registers via the
 *  `[LERP]` prototype slot. */
export type Lerp<T> = (a: T, b: T, t: number) => T;

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
  // Capture the duration as a signal once at construction; literals
  // get wrapped, signals/thunks pass through. Per-frame is just a
  // `.value` read — no allocation.
  const D = toSig(dur);
  return drive((_dt, t) => {
    const total = D.value;
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
  until(cond: import("./signal").ReadonlySignal<unknown> | Animator): Tween<T>;
  while(sig: import("./signal").ReadonlySignal<unknown>): Tween<T>;
  for(n: Val<number> | Animator): Tween<T>;
  at(scale: Val<number>): Tween<T>;
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

  /** Re-wrap into a Tween (instead of plain Chained) so all the
   *  inherited `until / while / for / at` methods preserve `Tween<T>`
   *  automatically. */
  protected override _rewrap(g: Animator<void>): Tween<T> {
    return new TweenImpl(this._sig, this._lerp, g);
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

  // ── until/while/for/at narrow their return type to `Tween<T>`.
  //    The runtime is fully inherited from ChainedImpl — these are
  //    type-level passthroughs. (TS can't infer the narrowed return
  //    purely from the `_rewrap` override; we declare the signature
  //    here and rely on the runtime guarantee.)
  override until(
    cond: import("./signal").ReadonlySignal<unknown> | Animator,
  ): Tween<T> {
    return super.until(cond) as Tween<T>;
  }
  override while(sig: import("./signal").ReadonlySignal<unknown>): Tween<T> {
    return super.while(sig) as Tween<T>;
  }
  override for(n: Val<number> | Animator): Tween<T> {
    return super.for(n) as Tween<T>;
  }
  override at(scale: Val<number>): Tween<T> {
    return super.at(scale) as Tween<T>;
  }
  // `.then(...)` exits to plain Chained<unknown> (inherited).
}

/** Build a fresh `Tween<T>` for a signal. The struct framework calls
 *  this when installing `.to` on registered writable Reactive
 *  prototypes; users normally just call `cell.to(...)`. */
function makeTween<T>(
  sig: Signal<T>,
  target: T,
  dur: Duration,
  ease: Easing,
  lerp: Lerp<T>,
): Tween<T> {
  return new TweenImpl<T>(sig, lerp, tweenStep(sig, target, dur, ease, lerp));
}

/** Free-function tween — escape hatch for value types whose signal
 *  doesn't have a registered struct lerp via `.to`. Either pass `lerp`
 *  explicitly, or attach one to the signal via `lerpable(value, lerp)`
 *  and the prototype-slot lookup picks it up. Throws if neither path
 *  provides a lerp. */
export function tween<T>(
  sig: Signal<T>,
  target: T,
  dur: Duration,
  ease?: Easing,
  lerp?: Lerp<T>,
): Tween<T> {
  const e = ease ?? defaultEase;
  const l = lerp ?? ((sig as any)[LERP] as Lerp<T> | undefined);
  if (!l) {
    throw new Error(
      "tween: signal has no [LERP] slot and no `lerp` was provided. " +
        "Use a struct cell (e.g. `num(0)`, `Vec.signal({x,y})`) or pass " +
        "`lerp` explicitly / register one via `lerpable(value, lerp)`.",
    );
  }
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
