// Fluent generator composition.
//
// `chain(g)` lifts any Animator into a chainable surface; library
// factories in `compose.ts` (and Tween in `tween.ts`) return `Chained`
// directly. The vocabulary reads as English — subject first, temporal
// qualifier after:
//
//   spring(w, rest).until(dragging)
//     "spring the width to rest, until dragging"
//
//   parallel(a, b, c).for(2.0)
//     "run a, b, c in parallel, for 2 seconds"
//
//   sleep(0.5).then(fadeIn(shape, 0.3))
//     "sleep half a second, then fade in"
//
//   orbit(centre, shapes).at(playback).until(rampSequence)
//     "orbit at playback rate, until the ramp sequence completes"
//
// Implementation: each method composes with existing primitives
// (`race` / `untilTrue` / `untilFalse` / suspend-with-scale) and
// returns a fresh Chained around the resulting Animator. The runtime
// is unchanged — Chained is just sugar over yield forms it already
// understands.

import {
  suspend,
  isGen,
  type Animator,
  type Yieldable,
} from "./anim";
import { Signal, type ReadonlySignal } from "./signal";
import { race, untilTrue, untilFalse } from "./suspensions";

/** Local sleep — `compose.ts` exports the public `sleep(n)`; this
 *  file can't import it without a cycle. */
function* _sleepGen(n: number): Animator {
  if (n > 0) yield n;
}

function isSignalLike(v: unknown): v is ReadonlySignal<unknown> {
  return v instanceof Signal;
}

/** A fluent Animator. Implements the iterator protocol identically
 *  to a plain generator, so `yield*` and the runtime treat it the
 *  same; the added methods compose by re-wrapping into a fresh
 *  Chained around a `race(...)` or sequencing generator. */
export interface Chained<R = void> extends Animator<R> {
  /** End this when `cond` fires. Signal → ends when truthy; Animator
   *  → ends when completes. Read: "this, until cond". */
  until(cond: ReadonlySignal<unknown> | Animator): Chained<R>;

  /** Continue while `sig` is truthy; end when it goes falsy.
   *  Read: "this, while sig". */
  while(sig: ReadonlySignal<unknown>): Chained<R>;

  /** Run for at most `n` seconds (number) or until `other` completes
   *  (Animator). */
  for(n: number | Animator): Chained<R>;

  /** Sequence: run this, then `next`. Accepts any Yieldable —
   *  generator, number (sleep), array (parallel), raw suspend-fn,
   *  or another Chained. Return-type widens to `unknown`. */
  then(next: Yieldable): Chained<unknown>;

  /** Scope time for this generator and all its children. `scale` may
   *  be a `number`, a `ReadonlySignal<number>`, or a thunk
   *  `() => number`. Reactive scales are read each frame. */
  at(scale: number | ReadonlySignal<number> | (() => number)): Chained<R>;
}

export class ChainedImpl<R = void> implements Chained<R> {
  constructor(protected _g: Animator<R>) {}

  // ── Iterator protocol — delegate to the wrapped generator so the
  //    runtime advances us identically to a plain generator. ───────
  next(dt?: number): IteratorResult<Yieldable, R> {
    return this._g.next(dt as number);
  }
  return(v?: R): IteratorResult<Yieldable, R> {
    return this._g.return(v as R);
  }
  throw(e: unknown): IteratorResult<Yieldable, R> {
    return this._g.throw(e);
  }
  [Symbol.iterator](): this {
    return this;
  }

  until(cond: ReadonlySignal<unknown> | Animator): Chained<R> {
    const trigger = isGen(cond) ? cond : untilTrue(cond);
    return chain(race(this._g, trigger) as Animator<R>);
  }

  while(sig: ReadonlySignal<unknown>): Chained<R> {
    return chain(race(this._g, untilFalse(sig)) as Animator<R>);
  }

  for(n: number | Animator): Chained<R> {
    const bound = typeof n === "number" ? _sleepGen(n) : n;
    return chain(race(this._g, bound) as Animator<R>);
  }

  then(next: Yieldable): Chained<unknown> {
    const g = this._g;
    return chain((function* (): Animator<unknown> {
      yield* g;
      if (next === undefined) return;
      if (typeof next === "number") {
        if (next > 0) yield next;
        return;
      }
      if (Array.isArray(next)) {
        yield next;
        return;
      }
      if (typeof next === "function" && !isGen(next)) {
        // Bare SuspendFn — yield it for the runtime to subscribe.
        yield next;
        return;
      }
      yield* next as Animator<unknown>;
    })());
  }

  at(scale: number | ReadonlySignal<number> | (() => number)): Chained<R> {
    // Bridge user-facing forms to the runtime's `number | () => number`.
    const arg: number | (() => number) =
      typeof scale === "number"
        ? scale
        : typeof scale === "function"
          ? (scale as () => number)
          : () => (scale as ReadonlySignal<number>).value;
    const g = this._g;
    return chain(
      suspend<R>((wake, spawn) => {
        // wake's signature varies on `R extends void`. The runtime
        // passes whatever the child returned; cast to a permissive
        // shape for the call.
        const finish = (v: unknown) =>
          (wake as (v?: unknown) => void)(v);
        return spawn(g, finish, arg);
      }),
    );
  }
}

/** Lift any Animator into the fluent vocabulary. Library factories
 *  in `compose.ts` and `tween.ts` already return Chained; for raw
 *  generators (`orbit`, `spring`, `drive`, …), wrap with `chain()` to
 *  opt in. */
export function chain<R>(g: Animator<R>): Chained<R> {
  if (g instanceof ChainedImpl) return g as unknown as Chained<R>;
  return new ChainedImpl(g);
}

// Re-exported so tween.ts can extend the chain machinery for `Tween<T>`.
export { isSignalLike };
