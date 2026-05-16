// Fluent generator composition + the tween engine.
//
// `Play<R>` is the fluent surface (`.until / .then / .at`)
// over any `Animator`. `play(p)` is the single entry point — it
// accepts a `Playable<R>`, which is "anything yieldable plus reactive
// cells (interpreted as wait-until-truthy)":
//
//   play(spring(width, rest)).until(dragging)
//     "play the spring until dragging fires"
//
//   play([a, b, c]).until(stop)
//     "play a, b, c in parallel, until stop"
//
//   play(0.5).then(fadeIn(shape, 0.3))
//     "play 0.5 seconds, then fade in"
//
//   play(ready).then(work)
//     "after ready becomes truthy, play work"
//
//   play(a, b, c)  // variadic = sequence
//     "play a, then b, then c"
//
// `Tween<T>` extends `Play<void>` with `.to(target, dur, ease?)`
// continuation. They share this file because `TweenImpl` extends
// `PlayImpl`, and `Tween<T>` preserves its narrowed type through
// `.until / .at`.
//
// Tweening is signal-typed: the engine writes `sig.value` each frame
// via a `lerp(start, target, t)` registered on the cell's prototype
// (the struct framework stamps `[LERP]` per writable struct type).
// `cell(0)` (a plain cell) does NOT get `.to` — reach for `num(0)`,
// `Vec.signal(...)`, etc., for tweenable cells.

import {
  suspend,
  isGen,
  drive,
  type Animator,
  type Yieldable,
} from "../core/anim";
import { mapDt } from "../core/composability";
import { easeOut } from "../core/easings";
import { signal, Signal } from "./signal";
import { asReader, toSig, type Val } from "./arg";
import { type ReadonlyCell } from "./cell";
import { race, untilTrue } from "./suspensions";

// ── Playable<R>: the input vocabulary for play() and methods ──────
//
// `Yieldable` lives in `core/anim.ts` and stays signal-free — it's the
// runtime's yield contract. `Playable` is the signals-layer widening
// that adds `ReadonlyCell<unknown>` (interpreted as "wait until truthy").
// `play()` normalizes Cell inputs via `untilTrue(...)` before handing
// the result to the runtime.

/** Anything `play()` and the Play methods accept: a Yieldable (number
 *  sleep, array parallel, Animator, bare suspend-fn, `undefined`)
 *  OR a reactive cell (interpreted as wait-until-truthy). */
export type Playable<R = void> = Yieldable | Animator<R> | ReadonlyCell<unknown>;

/** Normalize a `Playable` to an `Animator`. Cell → `untilTrue` wait;
 *  Animator → `yield*` it (preserves return); other Yieldables (number,
 *  array, undefined, SuspendFn) → just yield them once for the runtime
 *  to interpret. */
function* playableGen<R>(p: Playable<R>): Animator<R> {
  if (p instanceof Signal) {
    return (yield* untilTrue(p as ReadonlyCell<unknown>) as any) as R;
  }
  if (isGen(p)) return yield* p as Animator<R>;
  if (p !== undefined) yield p as Yieldable;
  return undefined as R;
}

// ── Play<R> — fluent generator surface ────────────────────────────

/** A fluent Animator. Implements the iterator protocol identically to
 *  a plain generator, so `yield*` and the runtime treat it the same;
 *  the added methods compose by re-wrapping into a fresh Play around
 *  a `race(...)` or sequencing generator. */
export interface Play<R = void> extends Animator<R> {
  /** End this when `p` fires. Cell → ends when truthy; Animator → ends
   *  when it completes; number → ends after that many seconds; array
   *  → ends when all in the array complete. Read: "this, until p".
   *
   *  For the falsy case (run while sig stays truthy), use
   *  `play(work).until(not(sig))`. */
  until(p: Playable): Play<R>;

  /** Sequence: run this, then `next`. Accepts any Playable. Return-
   *  type widens to `unknown`. */
  then(next: Playable): Play<unknown>;

  /** Scope time for this generator and all its children. `scale` may
   *  be a number, cell, or thunk. Reactive scales are read each frame. */
  at(scale: Val<number>): Play<R>;
}

class PlayImpl<R = void> implements Play<R> {
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

  /** Wrap a transformed generator in the same Play subclass. PlayImpl
   *  wraps as plain Play; subclasses (Tween) override to preserve
   *  their type and carry per-subclass state forward. */
  protected _rewrap(g: Animator<R>): Play<R> {
    return play(g) as Play<R>;
  }

  until(p: Playable): Play<R> {
    const trigger = playableGen(p);
    return this._rewrap(race(this._g, trigger) as Animator<R>);
  }

  then(next: Playable): Play<unknown> {
    const g = this._g;
    // `.then` always exits to plain Play<unknown> — subclasses (Tween)
    // inherit this directly; no override needed.
    return play((function* (): Animator<unknown> {
      yield* g;
      yield* playableGen(next);
      return undefined;
    })());
  }

  at(scale: Val<number>): Play<R> {
    return this._rewrap(scaledChild(this._g, scale));
  }
}

// ── Internal helpers (also used by compose.ts) ─────────────────────
// Exported from the file so the sibling `compose.ts` can import them,
// but NOT re-exported from `signals/index.ts` — not public API.

/** Wrap a gen so its child runs at `scale`. Built from the userland
 *  `mapDt` wrapper — every numeric resume value is multiplied by the
 *  current `scale.value`. Static scales skip the thunk. */
export function scaledChild<R>(
  g: Animator<R>,
  scale: Val<number>,
): Animator<R> {
  if (typeof scale === "number") {
    const k = scale;
    return mapDt((dt) => (typeof dt === "number" ? dt * k : dt), g);
  }
  const get = asReader(scale);
  return mapDt((dt) => (typeof dt === "number" ? dt * get() : dt), g);
}

/** `Val<number>` → a sleep-N generator. Resolves the value once at
 *  construction; reactive durations read through `toSig`. */
export function* sleepGen(n: Val<number>): Animator {
  const v = typeof n === "number" ? n : toSig(n).value;
  if (v > 0) yield v;
}

// ── play() — the one entry point ──────────────────────────────────

/** Lift any `Playable` into the fluent vocabulary.
 *
 *      play(spring(w, rest)).until(dragging)
 *      play(0.5).then(work)              // sleep, then work
 *      play([a, b, c]).until(stop)       // parallel, until stop
 *      play(ready).then(work)            // wait truthy, then work
 *      play(a, b, c)                     // variadic = sequence
 *
 *  Single-arg form preserves the typed return `R`. Variadic form
 *  widens to `Play<unknown>` (the same way `.then` does). */
export function play<R>(p: Playable<R>): Play<R>;
export function play(...ps: Playable[]): Play<unknown>;
export function play(...ps: Playable[]): Play<unknown> {
  if (ps.length === 1) {
    const p = ps[0];
    if (p instanceof PlayImpl) return p as unknown as Play<unknown>;
    return new PlayImpl(playableGen(p));
  }
  return new PlayImpl(
    (function* (): Animator<unknown> {
      for (const p of ps) yield* playableGen(p);
      return undefined;
    })(),
  );
}

// ── Tween<T> — Play<void> + .to() continuation ─────────────────────

export type Easing = (t: number) => number;
const defaultEase: Easing = easeOut;

/** Per-value-type lerp; the struct framework registers via the
 *  `[LERP]` prototype slot. */
export type Lerp<T> = (a: T, b: T, t: number) => T;

/** Hidden prototype slot that carries the value type's lerp.
 *  @internal — exported for the struct framework only. Uses
 *  `Symbol.for` so third-party libraries can recognise "this struct
 *  has a lerp" without coupling to minim's import path. */
export const LERP = Symbol.for("minim.lerp");

/** A tween — `Play<void>` plus `.to(...)` continuation; preserves
 *  itself through `.until / .at`. `.then(y)` returns plain
 *  `Play<unknown>` (leaves the tween world). */
export interface Tween<T> extends Play<void> {
  /** Append another segment that runs after this one. */
  to(target: T, dur: Val<number>, ease?: Easing): Tween<T>;
  // Tween-preserving overrides of the Play methods.
  until(p: Playable): Tween<T>;
  at(scale: Val<number>): Tween<T>;
}

class TweenImpl<T> extends PlayImpl<void> implements Tween<T> {
  // `_sig` + `_lerp` are carried so `.to(...)` can append fresh
  // segments off the same signal with the same lerp.
  constructor(
    private readonly _sig: Signal<T>,
    private readonly _lerp: Lerp<T>,
    g: Animator<void>,
  ) {
    super(g);
  }

  /** Re-wrap into a Tween (instead of plain Play) so all the inherited
   *  `until / at` methods preserve `Tween<T>` automatically. */
  protected override _rewrap(g: Animator<void>): Tween<T> {
    return new TweenImpl(this._sig, this._lerp, g);
  }

  to(target: T, dur: Val<number>, ease?: Easing): Tween<T> {
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

  // ── until/at narrow their return type to `Tween<T>`. The
  //    runtime is fully inherited from PlayImpl — these are type-level
  //    passthroughs. TS can't infer the narrowed return purely from
  //    the `_rewrap` override; we declare the signature here and rely
  //    on the runtime guarantee. ───────────────────────────────────
  override until(p: Playable): Tween<T> {
    return super.until(p) as Tween<T>;
  }
  override at(scale: Val<number>): Tween<T> {
    return super.at(scale) as Tween<T>;
  }
  // `.then(...)` exits to plain Play<unknown> (inherited).
}

// ── The engine: one tween-step on top of `drive` ───────────────────

function tweenStep<T>(
  sig: Signal<T>,
  target: T,
  dur: Val<number>,
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
  dur: Val<number>,
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
  dur: Val<number>,
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
