// lerp.ts — the signals → generators bridge.
//
// Where signals live ON cells (state), this file lives BETWEEN cells
// and the runtime. It contains:
//
//   • The `[LERP]` trait method bundle (`.to()` on cells)
//   • Free-fn temporal animators dispatched by traits:
//       tween (LERP), spring/toward (LINEAR + METRIC),
//       holding/follow/driven (no trait needed)
//   • The `Tween<T>` chainable wrapper for `.to(A).to(B).from(start)`
//   • `play(...)` fluent surface — `.until / .then / .at`
//   • `when(sig)` — wait until cell value is truthy

import { Signal, Computed, computed, effect, type Val, type Read } from "./signal";
import {
  LERP, LINEAR, METRIC, EQUALS,
  type Linear, type Lerp, type Metric, type Equals,
} from "./traits";
import {
  drive, suspend, race, mapDt, type Animator, type Yieldable,
  type Easing, easeOut,
} from "../core";

const defaultEase = easeOut;

// ════════════════════════════════════════════════════════════════════
// Tween<T> — small chainable Animator wrapper for `.to(...).to(...)`.
// NOT a class hierarchy; just an Animator that knows its target sig
// so `.to(...)` can append fresh segments.
// ════════════════════════════════════════════════════════════════════

export class Tween<T> implements Animator<void> {
  constructor(private sig: Signal<T>, private gen: Animator<void>) {}

  /** Append a tween segment from current value to `target` over `dur`. */
  to(target: T, dur: Val<number>, ease?: Easing): Tween<T> {
    const sig = this.sig;
    const prior = this.gen;
    return new Tween(sig, (function* (): Animator<void> {
      yield* prior;
      yield* tweenStep(sig, target, dur, ease);
    })());
  }

  /** Pose-then-tween prefix: write `start` to the cell as the first
   *  step, then run the rest of the chain. Reads as
   *  `opacity.from(0).to(1, 0.5)` → "from 0, to 1 over 0.5s." */
  from(start: T): Tween<T> {
    const sig = this.sig;
    const prior = this.gen;
    return new Tween(sig, (function* (): Animator<void> {
      sig.value = start;
      yield* prior;
    })());
  }

  // Animator protocol — delegate to the wrapped generator.
  next(v?: number): IteratorResult<Yieldable, void> { return this.gen.next(v as number); }
  return(v?: void): IteratorResult<Yieldable, void> { return this.gen.return(v as void); }
  throw(e: unknown): IteratorResult<Yieldable, void> { return this.gen.throw(e); }
  [Symbol.iterator](): this { return this; }
}

// ════════════════════════════════════════════════════════════════════
// Tween primitive — reads [LERP] from the cell, writes per frame
// ════════════════════════════════════════════════════════════════════

/** One tween segment: drive `sig` from current to `target` over `dur` */
function* tweenStep<T>(
  sig: Signal<T>,
  target: T,
  dur: Val<number>,
  ease: Easing = defaultEase,
): Animator<void> {
  const lerpFn = sig[LERP];
  if (!lerpFn) {
    throw new Error(`tween: ${sig.constructor.name} has no [LERP] slot`);
  }
  const start = sig.peek();
  const D = valFn(dur);
  // Epsilon guards against FP imprecision in dt accumulation: e.g. with
  // synthetic dt = 1/60, six frames give clock=0.0999...8, missing the
  // `>= 0.1` exact-equality and pushing tween completion to the 7th frame.
  yield* drive((_dt, t) => {
    const total = D();
    if (t + 1e-9 >= total) { sig.value = target; return false; }
    const u = total > 0 ? t / total : 1;
    sig.value = lerpFn(start, target, ease(u));
  });
}

/** Free-fn tween — useful for ad-hoc third-party types where the
 *  method form isn't installed. Returns a chainable `Tween<T>`. */
export function tween<T>(
  sig: Signal<T>,
  target: T,
  dur: Val<number>,
  ease?: Easing,
): Tween<T> {
  return new Tween(sig, tweenStep(sig, target, dur, ease));
}

// ════════════════════════════════════════════════════════════════════
// Spring / Toward / Oscillate / Drift / Attract
// All need [LINEAR]; spring/toward additionally need [METRIC] for the
// distance-based settle / step.
// ════════════════════════════════════════════════════════════════════

export interface SpringOpts {
  /** Hooke stiffness; higher → faster pull. Default 170. */
  stiffness?: number;
  /** Velocity damping; higher → less oscillation. Default 26. */
  damping?: number;
  /** Settle threshold; snap+complete when distance < precision and
   *  velocity magnitude < precision*100. Default 1e-4. `0` runs forever. */
  precision?: number;
}

/** Pull `sig` toward `target` with critically-damped-ish dynamics.
 *  `target` may be reactive (read each frame). Settles when both
 *  distance and velocity drop below `opts.precision`. */
export function* spring<T>(
  sig: Signal<T>,
  target: Val<T>,
  opts: SpringOpts = {},
): Animator<void> {
  const lin = sig[LINEAR];
  const met = sig[METRIC];
  if (!lin || !met) {
    throw new Error(`spring: ${sig.constructor.name} needs [LINEAR] + [METRIC]`);
  }
  const stiffness = opts.stiffness ?? 170;
  const damping = opts.damping ?? 26;
  const eps = opts.precision ?? 1e-4;
  const T = valFn(target);
  let vel: T | undefined;
  yield* drive((dt) => {
    const t = T();
    const cur = sig.peek();
    const disp = lin.sub(t, cur);                 // target - cur
    const vAccel = lin.scale(disp, stiffness);    // k * disp
    const damp = vel ? lin.scale(vel, damping) : lin.scale(disp, 0);
    const accel = lin.sub(vAccel, damp);          // k*disp - c*v
    vel = vel ? lin.add(vel, lin.scale(accel, dt)) : lin.scale(accel, dt);
    sig.value = lin.add(cur, lin.scale(vel, dt));
    if (eps > 0 && met(cur, t) < eps && met(vel, t) < eps * 100) {
      sig.value = t;
      return false;
    }
  });
}

/** Constant-speed approach. `speed` is units-of-T per second (via metric).
 *  `target` and `speed` may be reactive. */
export function* toward<T>(
  sig: Signal<T>,
  target: Val<T>,
  speed: Val<number>,
): Animator<void> {
  const lin = sig[LINEAR];
  const met = sig[METRIC];
  if (!lin || !met) {
    throw new Error(`toward: ${sig.constructor.name} needs [LINEAR] + [METRIC]`);
  }
  const T = valFn(target);
  const S = valFn(speed);
  yield* drive((dt) => {
    const t = T();
    const cur = sig.peek();
    const dist = met(cur, t);
    const step = S() * dt;
    if (dist <= step) { sig.value = t; return false; }
    const dir = lin.scale(lin.sub(t, cur), 1 / dist);
    sig.value = lin.add(cur, lin.scale(dir, step));
  });
}

/** Sinusoidal oscillation around the signal's value at start. `amp` and
 *  `freq` (Hz) may be reactive. Runs forever — wrap with `race`/`until`
 *  to terminate. */
export function* oscillate<T>(
  sig: Signal<T>,
  amp: Val<T>,
  freq: Val<number>,
): Animator<void> {
  const lin = sig[LINEAR];
  if (!lin) throw new Error(`oscillate: ${sig.constructor.name} needs [LINEAR]`);
  const A = valFn(amp);
  const F = valFn(freq);
  const base = sig.peek();
  yield* drive((_dt, t) => {
    sig.value = lin.add(base, lin.scale(A(), Math.sin(2 * Math.PI * F() * t)));
  });
}

/** Exponential pull toward `target` with rate `k` per second
 *  (k=1 closes ~63% of distance per second). No overshoot. */
export function* attract<T>(
  sig: Signal<T>,
  target: Val<T>,
  k: Val<number> = 1,
): Animator<void> {
  const lin = sig[LINEAR];
  if (!lin) throw new Error(`attract: ${sig.constructor.name} needs [LINEAR]`);
  const T = valFn(target);
  const K = valFn(k);
  yield* drive((dt) => {
    const cur = sig.peek();
    const delta = lin.scale(lin.sub(T(), cur), K() * dt);
    sig.value = lin.add(cur, delta);
  });
}

/** Constant-velocity advance. `velocity` may be reactive — flip live to
 *  reverse, scale to slow. */
export function* drift<T>(
  sig: Signal<T>,
  velocity: Val<T>,
): Animator<void> {
  const lin = sig[LINEAR];
  if (!lin) throw new Error(`drift: ${sig.constructor.name} needs [LINEAR]`);
  const V = valFn(velocity);
  yield* drive((dt) => {
    sig.value = lin.add(sig.peek(), lin.scale(V(), dt));
  });
}

/** Coerce a `Val<T>` into a `() => T` getter (no signal tracking — used
 *  inside `drive` lambdas which are untracked). The `Read<T>` arm of
 *  `Val<T>` is a *type-only* abstraction; at runtime, only `Signal`
 *  instances need detection. Anything else is the plain value. */
function valFn<T>(v: Val<T>): () => T {
  if (v instanceof Signal) return () => v.value;
  if (typeof v === "function") return v as () => T;
  return () => v as T;
}

// ════════════════════════════════════════════════════════════════════
// Universal cell-temporal methods — no trait required
// ════════════════════════════════════════════════════════════════════

/** Set sig to value, wait dur, restore previous. Cancellation restores too. */
export function* holding<T>(
  sig: Signal<T>,
  v: T,
  dur: Val<number>,
): Animator<void> {
  const prev = sig.peek();
  sig.value = v;
  try { yield valFn(dur)(); }
  finally { sig.value = prev; }
}

/** Generator-scoped reactive bind: `sig` follows `source` until the
 *  enclosing generator ends or is cancelled. Sugar over `sig.bind(source)`
 *  with automatic cleanup tied to the parent's lifetime.
 *
 *      yield* race(follow(b, a), untilTrue(stop));   // b follows a until stop
 */
export function follow<T>(sig: Signal<T>, source: Val<T>): Animator<void> {
  return suspend<void>((_wake) => {
    const stop = sig.bind(source);
    return stop;
  });
}

/** Escape hatch: drive sig per frame with `step(dt, t, current)`.
 *  Return `false` to terminate. */
export function* driven<T>(
  sig: Signal<T>,
  step: (dt: number, t: number, v: T) => T | false,
): Animator<void> {
  yield* drive((dt, t) => {
    const next = step(dt, t, sig.peek());
    if (next === false) return false;
    sig.value = next;
  });
}

// ════════════════════════════════════════════════════════════════════
// Method bundle for [LERP] — `.to()` is the only cell method.
//
// Everything else (spring/toward/holding/from/driven) is a free fn that
// dispatches via traits — strictly more general (works on any cell with
// the right traits, including third-party types stamped post-hoc).
// ════════════════════════════════════════════════════════════════════

export interface LerpMethods<T> {
  to(target: T, dur: Val<number>, ease?: Easing): Tween<T>;
}

export const lerpImpl = {
  to<T>(this: Signal<T>, target: T, dur: Val<number>, ease?: Easing): Tween<T> {
    return tween(this, target, dur, ease);
  },
};

// ════════════════════════════════════════════════════════════════════
// defineTrait(Cls, slot, impl)
//
// Stamps `Cls.prototype[slot] = impl` and, if the slot has an associated
// method bundle (e.g. `.to()` for LERP), installs that too. Use in
// value-type files instead of writing the prototype assignments by hand:
//
//   defineTrait(Vec, LINEAR, { add, sub, scale });
//   defineTrait(Vec, LERP,   lerp);     // also installs .to()
//   defineTrait(Vec, METRIC, metric);
//   defineTrait(Vec, EQUALS, equals);
// ════════════════════════════════════════════════════════════════════

const TRAIT_METHODS: Record<symbol, object | undefined> = {
  [LERP]: lerpImpl,
  // future: extra (slot → method-bundle) pairs go here
};

interface ProtoTarget { prototype: object }
export function defineTrait<T>(Cls: ProtoTarget, slot: typeof LERP,   impl: Lerp<T>): void;
export function defineTrait<T>(Cls: ProtoTarget, slot: typeof LINEAR, impl: Linear<T>): void;
export function defineTrait<T>(Cls: ProtoTarget, slot: typeof METRIC, impl: Metric<T>): void;
export function defineTrait<T>(Cls: ProtoTarget, slot: typeof EQUALS, impl: Equals<T>): void;
export function defineTrait(Cls: ProtoTarget, slot: symbol, impl: unknown): void {
  (Cls.prototype as Record<symbol, unknown>)[slot] = impl;
  const methods = TRAIT_METHODS[slot];
  if (methods) Object.assign(Cls.prototype, methods);
}

// ════════════════════════════════════════════════════════════════════
// play() — thin fluent facade for .until/.then/.at over any Animator
// ════════════════════════════════════════════════════════════════════

/** Triggers that bound a `play(...)`. A `Read<unknown>` waits until the
 *  cell's value is truthy; an `Animator` waits for completion; a
 *  number sleeps that many seconds. */
// A play-trigger is either a generator/animator to delegate to, or a
// reactive cell whose truthiness we wait on. We accept `Signal<any>`
// (not `Read<unknown>`) because `playableGen`'s only handling for
// "cell" inputs is `instanceof Signal` + `effect` subscription —
// plain Read-shaped objects (no observer hookup) would silently fall
// through and crash with "unsupported yield object". `any` is the
// intentional bivariance escape: `Signal<T>` is invariant in T (T
// appears in trait slots like `Lerp<T>` which use T in both
// positions), so `Signal<unknown>` would not accept `Signal<boolean>`.
// At this site we don't read the value's type, only its truthiness.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PlayTrigger = Yieldable | Signal<any>;

export interface Play<R = void> extends Animator<R> {
  /** End when `p` fires (truthy cell, animator completion, n-second sleep, etc.) */
  until(p: PlayTrigger): Play<R>;
  /** Sequence: this, then `next`. */
  then(next: PlayTrigger): Play<unknown>;
  /** Time-scale this and its children. */
  at(scale: Val<number>): Play<R>;
}

class PlayImpl<R> implements Play<R> {
  constructor(private g: Animator<R>) {}
  next(v?: number) { return this.g.next(v as number); }
  return(v?: R) { return this.g.return(v as R); }
  throw(e: unknown) { return this.g.throw(e); }
  [Symbol.iterator]() { return this; }

  until(p: PlayTrigger): Play<R> {
    const trigger = playableGen(p);
    const g = this.g;
    return new PlayImpl<R>(
      // race(this, trigger) — first to settle wins, other cancels.
      // We only care about the value if `this` won.
      (function* () {
        const result = yield* (race(g as Animator<unknown>, trigger) as Animator<unknown>);
        return result as R;
      })(),
    );
  }

  then(next: PlayTrigger): Play<unknown> {
    const g = this.g;
    return new PlayImpl(
      (function* () { yield* g; yield* playableGen(next); })(),
    );
  }

  at(scale: Val<number>): Play<R> {
    return new PlayImpl(scaledGen(this.g, scale));
  }
}

/** Lift any yieldable, cell-trigger, or animator-factory into a Play.
 *  Cells become wait-until-truthy. Factories (`() => Animator<R>`) are
 *  invoked here, then the resulting animator is wrapped — passing a
 *  factory is just a convenience that thunks instantiation to the call
 *  site (useful when constructing a play through helpers that build
 *  fresh animators on demand). */
export function play<R>(g: Animator<R> | (() => Animator<R>)): Play<R>;
export function play(p: PlayTrigger | (() => Animator)): Play<unknown>;
export function play(p: PlayTrigger | (() => Animator)): Play<unknown> {
  if (p instanceof PlayImpl) return p;
  // A nullary function is an animator factory — invoke to get a fresh
  // generator. We discriminate from suspend impls (which take
  // `(wake, spawn, anim)` and have `.length === 3`) by arity. Generator
  // instances and Tween are objects, not functions, so they skip this.
  if (typeof p === "function" && (p as Function).length === 0) {
    p = (p as () => Animator)();
  }
  return new PlayImpl(playableGen(p as PlayTrigger));
}

function* playableGen(p: PlayTrigger): Animator<unknown> {
  if (p instanceof Signal) {
    yield* when(p);
    return undefined;
  }
  if (p === undefined || p === null) return undefined;
  if (typeof p === "object" && (p as Animator<unknown>).next) {
    return yield* (p as Animator<unknown>);
  }
  yield p as Yieldable;
  return undefined;
}

/** Wait until `sig.value` is truthy. Wakes immediately if already true.
 *  Requires a real `Signal` — `effect()` only tracks reads on tracked
 *  cells, so a plain Read shape would never re-fire. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function when(sig: Signal<any>): Animator<void> {
  return suspend<void>((wake) => {
    let resolved = false;
    return effect(() => {
      if (resolved) return;
      if (sig.value) { resolved = true; wake(); }
    });
  });
}

/** Reactive boolean negation — `not(sig).value === !sig.value`. Pair
 *  with `when` / `play().until(...)` to wait on falsy conditions.
 *
 *  Returns a `Computed<boolean>` (a real Signal instance), so the
 *  result is `instanceof Signal` and slots into anywhere a reactive
 *  cell is expected — `play(not(active))`, `attr(..., not(hidden))`,
 *  etc. */
export function not(sig: Read<unknown>): Computed<boolean> {
  return computed(() => !sig.value);
}

/** Wait until `sig` changes value (via `===`/`equals` trait). Resumes
 *  with the new value. Useful when you want the *next* update and
 *  don't care about a specific predicate. */
export function untilChange<T>(sig: Signal<T>): Animator<T> {
  return suspend<T>((wake) => {
    const initial = sig.peek();
    let resolved = false;
    return effect(() => {
      const v = sig.value;
      if (resolved) return;
      if (v !== initial) { resolved = true; wake(v); }
    });
  });
}

/** Repeat `factory()` forever — fresh generator each iteration.
 *  Returns a `Play` so you can `.until(sig)` to bound the loop. */
export function loop(factory: () => Animator): Play {
  return play(
    (function* (): Animator {
      while (true) yield* factory();
    })(),
  );
}

/** Run `fn` every `sec` seconds. Drift-corrects (missed firings catch
 *  up on the next frame). `sec` may be reactive. Side-effect only —
 *  for awaited per-cycle work, use `loop(() => play(sec).then(work))`. */
export function every(sec: Val<number>, fn: () => void): Play {
  const getSec = valFn(sec);
  return play((function* (): Animator {
    let acc = 0;
    while (true) {
      const dt = yield;
      acc += dt;
      const period = getSec();
      if (period <= 0) continue;
      while (acc >= period) { fn(); acc -= period; }
    }
  })());
}

/** Wrap a gen so all `dt` flowing through it (yielded sleeps + resumed
 *  per-frame dts) is multiplied by `scale`. Used by `play().at(...)`. */
function scaledGen<R>(g: Animator<R>, scale: Val<number>): Animator<R> {
  const get = valFn(scale);
  return mapDt((dt) => dt * get(), g);
}
