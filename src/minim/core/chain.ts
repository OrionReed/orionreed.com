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
import { type ReadonlySignal } from "./signal";
import { toSig, type Val } from "./arg";
import { race, untilTrue, untilFalse } from "./suspensions";

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

  /** Run for at most a duration (`Val<number>`) or until `other`
   *  completes (Animator). */
  for(n: Val<number> | Animator): Chained<R>;

  /** Sequence: run this, then `next`. Accepts any Yieldable —
   *  generator, number (sleep), array (parallel), raw suspend-fn,
   *  or another Chained. Return-type widens to `unknown`. */
  then(next: Yieldable): Chained<unknown>;

  /** Scope time for this generator and all its children. `scale` may
   *  be a number, signal, or thunk. Reactive scales are read each
   *  frame. */
  at(scale: Val<number>): Chained<R>;
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

  /** Wrap a transformed generator in the same Chained subclass.
   *  ChainedImpl wraps as plain Chained; subclasses (Tween) override
   *  to preserve their type and carry per-subclass state forward. */
  protected _rewrap(g: Animator<R>): Chained<R> {
    return chain(g);
  }

  until(cond: ReadonlySignal<unknown> | Animator): Chained<R> {
    const trigger = isGen(cond) ? cond : untilTrue(cond);
    return this._rewrap(race(this._g, trigger) as Animator<R>);
  }

  while(sig: ReadonlySignal<unknown>): Chained<R> {
    return this._rewrap(race(this._g, untilFalse(sig)) as Animator<R>);
  }

  for(n: Val<number> | Animator): Chained<R> {
    const bound = isGen(n) ? n : sleepGen(n);
    return this._rewrap(race(this._g, bound) as Animator<R>);
  }

  then(next: Yieldable): Chained<unknown> {
    const g = this._g;
    // `.then` always exits to plain Chained<unknown> — subclasses
    // (Tween) inherit this directly; no override needed.
    return chain((function* (): Animator<unknown> {
      yield* g;
      yield* yieldableGen(next);
      return undefined;
    })());
  }

  at(scale: Val<number>): Chained<R> {
    return this._rewrap(scaledChild(this._g, scale));
  }
}

// ── Internal helpers ──────────────────────────────────────────────

/** Wrap a gen so its child Active runs at `scale`. */
export function scaledChild<R>(
  g: Animator<R>,
  scale: Val<number>,
): Animator<R> {
  // Bridge `Val<number>` to the runtime's `number | () => number`.
  const arg: number | (() => number) =
    typeof scale === "number"
      ? scale
      : typeof scale === "function"
        ? (scale as () => number)
        : (() => toSig(scale).value);
  return suspend<R>((wake, spawn) => {
    // wake's signature varies on `R extends void`. The runtime
    // passes whatever the child returned; cast to a permissive
    // shape for the call.
    const finish = (v: unknown) => (wake as (v?: unknown) => void)(v);
    return spawn(g, finish, arg);
  });
}

/** `Val<number>` → a sleep-N generator. Resolves the value once at
 *  construction; reactive durations read through `toSig`. */
export function* sleepGen(n: Val<number>): Animator {
  const v = typeof n === "number" ? n : toSig(n).value;
  if (v > 0) yield v;
}

/** Yield-dispatch helper used by `.then`, `sequence`, and `after`.
 *  Handles every `Yieldable` shape uniformly. */
export function* yieldableGen(y: Yieldable): Animator<unknown> {
  if (y === undefined) return undefined;
  if (typeof y === "number") {
    if (y > 0) yield y;
    return undefined;
  }
  if (Array.isArray(y)) {
    yield y;
    return undefined;
  }
  if (typeof y === "function" && !isGen(y)) {
    // Bare SuspendFn — yield it for the runtime to subscribe.
    yield y;
    return undefined;
  }
  return yield* y as Animator<unknown>;
}

/** Lift any Animator into the fluent vocabulary. Library factories
 *  in `compose.ts` and `tween.ts` already return Chained; for raw
 *  generators (`orbit`, `spring`, `drive`, …), wrap with `chain()` to
 *  opt in. */
export function chain<R>(g: Animator<R>): Chained<R> {
  if (g instanceof ChainedImpl) return g as unknown as Chained<R>;
  return new ChainedImpl(g);
}

