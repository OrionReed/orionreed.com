// Fluent generator composition + the tween engine.
//
// `Chained<R>` is the surface (`.until / .while / .for / .then / .at`)
// over any `Animator`. Library factories (`sequence` / `parallel` /
// `loop` / `sleep` / `after` / `every` in `core/compose.ts`) return
// `Chained` directly; for raw generators, opt in with `chain(g)`.
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
// `Tween<T>` is a `Chained<void>` with `.to(target, dur, ease?)`
// continuation segments. Lives in the same file as `Chained` because
// the two are tightly bound: `TweenImpl` extends `ChainedImpl`, and
// `Tween<T>` extends `Chained<void>` while preserving its narrowed
// type through `.until / .while / .for / .at`.
//
// Tweening is signal-typed: the engine writes `sig.value` each frame
// via a `lerp(start, target, t)` registered on the cell's prototype
// (the struct framework stamps `[LERP]` per writable struct type).
// `cell(0)` (a plain cell) does NOT get `.to` — reach for `num(0)`,
// `Vec.signal(...)`, etc., for tweenable cells.

import {
  suspend,
  isGen,
  type Animator,
  type Yieldable,
} from "../core/anim";
import { drive } from "../core/drive";
import { easeOut } from "../core/easings";
import { signal, type Signal, type ReadonlySignal } from "./signal";
import { toSig, type Val } from "./arg";
import { race, untilTrue, untilFalse } from "./suspensions";

// ── Chained<R> — fluent generator surface ─────────────────────────

/** A fluent Animator. Implements the iterator protocol identically to
 *  a plain generator, so `yield*` and the runtime treat it the same;
 *  the added methods compose by re-wrapping into a fresh Chained
 *  around a `race(...)` or sequencing generator. */
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

// ── Internal helpers (also used by compose.ts) ─────────────────────

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
    // wake's signature varies on `R extends void`. The runtime passes
    // whatever the child returned; cast to a permissive shape for the
    // call.
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

/** Lift any Animator into the fluent vocabulary. Library factories in
 *  `core/compose.ts` (and `Tween` below) already return Chained; for
 *  raw generators (`orbit`, `spring`, `drive`, …), wrap with `chain()`
 *  to opt in. */
export function chain<R>(g: Animator<R>): Chained<R> {
  if (g instanceof ChainedImpl) return g as unknown as Chained<R>;
  return new ChainedImpl(g);
}

// ── Tween<T> — Chained<void> + .to() continuation ──────────────────

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

/** A tween — `Chained<void>` plus `.to(...)` continuation; preserves
 *  itself through `.until / .while / .for / .at`. `.then(y)` returns
 *  plain `Chained<unknown>` (leaves the tween world). */
export interface Tween<T> extends Chained<void> {
  /** Append another segment that runs after this one. */
  to(target: T, dur: Duration, ease?: Easing): Tween<T>;
  // Tween-preserving overrides of the Chained methods.
  until(cond: ReadonlySignal<unknown> | Animator): Tween<T>;
  while(sig: ReadonlySignal<unknown>): Tween<T>;
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

  // ── until/while/for/at narrow their return type to `Tween<T>`. The
  //    runtime is fully inherited from ChainedImpl — these are
  //    type-level passthroughs. TS can't infer the narrowed return
  //    purely from the `_rewrap` override; we declare the signature
  //    here and rely on the runtime guarantee. ──────────────────────
  override until(cond: ReadonlySignal<unknown> | Animator): Tween<T> {
    return super.until(cond) as Tween<T>;
  }
  override while(sig: ReadonlySignal<unknown>): Tween<T> {
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

// ── The engine: one tween-step on top of `drive` ───────────────────

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

/** Build a fresh `Tween<T>` for a signal. Called by the struct
 *  framework when installing `.to` on registered writable cell
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
 *  doesn't have a registered struct lerp via `.to`. Either pass
 *  `lerp` explicitly, or attach one to the signal via `lerpable(value,
 *  lerp)` and the prototype-slot lookup picks it up. Throws if
 *  neither path provides a lerp. */
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
 *  `tween(sig, ...)` form to find the lerp via prototype lookup. The
 *  signal itself does NOT gain a `.to` method — minim no longer
 *  patches Signal.prototype. */
export function lerpable<T>(initial: T, lerp: Lerp<T>): Signal<T> {
  const s = signal(initial);
  (s as any)[LERP] = lerp;
  return s;
}
