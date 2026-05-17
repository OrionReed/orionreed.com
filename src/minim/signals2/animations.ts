// animations.ts — temporal cell methods, organised as trait bundles.
//
// Each trait is (slot + impl + interface). Stamping a class with the
// trait installs the methods runtime-side; declaration-merging the
// matching interface installs them type-side. Both sides explicit,
// adjacent in the value-type's file.
//
// Built-in trait bundles:
//
//   [LERP]        → .to(target, dur, ease?)         finite tween
//   [LINEAR]      → .add/.sub/.scale (already in values.ts as methods)
//   [LINEAR]      → no animation methods alone
//   [LINEAR + METRIC] → .spring(), .toward()         (declared on Num/Vec)
//
// Universal cell-temporal methods (no trait required):
//
//   .from(source)       generator-scoped reactive bind
//   .holding(v, dur)    set, wait, restore
//   .driven(stepFn)     escape-hatch frame-driven mutation
//
// Free-function forms exist alongside the methods — they're what the
// methods delegate to and let users animate trait-equipped third-party
// types without subclassing.

import { Signal, effect, type Val } from "./signal";
import { LERP, LINEAR, METRIC } from "./traits";
import {
  drive, suspend, race, type Animator, type Yieldable,
} from "./anim";

// ════════════════════════════════════════════════════════════════════
// Easings — small bundled set; users can pass any (t: number) => number
// ════════════════════════════════════════════════════════════════════

export type Easing = (t: number) => number;

export const linear: Easing  = (t) => t;
export const easeIn: Easing  = (t) => t * t;
export const easeOut: Easing = (t) => 1 - (1 - t) * (1 - t);
export const easeInOut: Easing = (t) =>
  t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);

const defaultEase = easeOut;

// ════════════════════════════════════════════════════════════════════
// Tween<T> — small chainable Animator wrapper for `.to(...).to(...)`.
// NOT a class hierarchy; just an Animator that knows its target sig
// so `.to(...)` can append fresh segments.
// ════════════════════════════════════════════════════════════════════

export class Tween<T> implements Animator<void> {
  constructor(private sig: Signal<T>, private gen: Animator<void>) {}

  to(target: T, dur: Val<number>, ease?: Easing): Tween<T> {
    const sig = this.sig;
    const prior = this.gen;
    const next = (function* (): Animator<void> {
      yield* prior;
      yield* tweenStep(sig, target, dur, ease);
    })();
    return new Tween(sig, next);
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
  // Resolve duration once at start; reactive Val<number> reads via .value/thunk.
  const D = typeof dur === "number"
    ? () => dur
    : (dur instanceof Signal ? () => dur.value : dur);
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
// Spring & Toward — physics-flavoured drives (need [LINEAR] + [METRIC])
// ════════════════════════════════════════════════════════════════════

/** Critically-damped-ish spring. Settles when distance < 1e-4. */
export function* spring<T>(
  sig: Signal<T>,
  target: T,
  stiffness = 100,
  damping = 10,
): Animator<void> {
  const lin = sig[LINEAR];
  const met = sig[METRIC];
  if (!lin || !met) {
    throw new Error(`spring: ${sig.constructor.name} needs [LINEAR] + [METRIC]`);
  }
  // velocity in T-space; maintained by accumulating scaled additions
  let vel: T | undefined;
  const SETTLE = 1e-4;
  yield* drive((dt) => {
    const cur = sig.peek();
    const disp = lin.sub(target, cur);            // target - cur
    const vAccel = lin.scale(disp, stiffness);    // k * disp
    const damp = vel ? lin.scale(vel, damping) : lin.scale(disp, 0);
    const accel = lin.sub(vAccel, damp);          // k*disp - c*v
    vel = vel ? lin.add(vel, lin.scale(accel, dt)) : lin.scale(accel, dt);
    sig.value = lin.add(cur, lin.scale(vel, dt));
    // Settle check: both distance AND velocity small.
    if (met(cur, target) < SETTLE && met(vel, target) < SETTLE * 100) {
      sig.value = target;
      return false;
    }
  });
}

/** Constant-speed approach. `speed` is units-of-T per second (via metric). */
export function* toward<T>(
  sig: Signal<T>,
  target: T,
  speed: Val<number>,
): Animator<void> {
  const lin = sig[LINEAR];
  const met = sig[METRIC];
  if (!lin || !met) {
    throw new Error(`toward: ${sig.constructor.name} needs [LINEAR] + [METRIC]`);
  }
  const speedFn = typeof speed === "number"
    ? () => speed
    : (speed instanceof Signal ? () => speed.value : speed);
  yield* drive((dt) => {
    const cur = sig.peek();
    const dist = met(cur, target);
    const step = speedFn() * dt;
    if (dist <= step) { sig.value = target; return false; }
    // Move `step` units toward target along the line:
    const dir = lin.scale(lin.sub(target, cur), 1 / dist);
    sig.value = lin.add(cur, lin.scale(dir, step));
  });
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
  try { yield typeof dur === "number" ? dur : (dur instanceof Signal ? dur.value : dur()); }
  finally { sig.value = prev; }
}

/** Generator-scoped reactive bind: follows `source` until parent ends.
 *  Equivalent to `try { stop = sig.bind(source); yield* untilForever; } finally { stop(); }`.
 */
export function from<T>(sig: Signal<T>, source: Val<T>): Animator<void> {
  return suspend<void>((_wake) => {
    // Eagerly install the bind; never wake (runs until cancel).
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
// Method-bundle interfaces — for declaration merging on value classes
// ════════════════════════════════════════════════════════════════════

/** Methods that come with `[LERP]`. Merge into a class declaration:
 *      interface Vec extends LerpMethods<Vec.Value> {}
 *  …and call `installLerpMethods(Vec)` after stamping the slot. */
export interface LerpMethods<T> {
  to(target: T, dur: Val<number>, ease?: Easing): Tween<T>;
}

/** Methods that come with `[LINEAR] + [METRIC]`. */
export interface PhysicsMethods<T> {
  spring(target: T, stiffness?: number, damping?: number): Animator<void>;
  toward(target: T, speed: Val<number>): Animator<void>;
}

/** Universal methods — no trait required. */
export interface CellMethods<T> {
  from(source: Val<T>): Animator<void>;
  holding(v: T, dur: Val<number>): Animator<void>;
  driven(step: (dt: number, t: number, v: T) => T | false): Animator<void>;
}

// ════════════════════════════════════════════════════════════════════
// Method bundle implementations — exported for `Object.assign` onto
// value-type prototypes.
//
// Usage in a value-type file:
//
//   class Vec extends Signal<Vec.Value> {}
//   interface Vec extends LerpMethods<Vec.Value>, PhysicsMethods<Vec.Value> {}
//
//   Vec.prototype[LINEAR] = vLinear;
//   Vec.prototype[LERP]   = vLerp;
//   Vec.prototype[METRIC] = vMetric;
//   Vec.prototype[EQUALS] = vEquals;
//
//   Object.assign(Vec.prototype, lerpImpl, physicsImpl);
// ════════════════════════════════════════════════════════════════════

export const lerpImpl = {
  to<T>(this: Signal<T>, target: T, dur: Val<number>, ease?: Easing): Tween<T> {
    return tween(this, target, dur, ease);
  },
};

export const physicsImpl = {
  spring<T>(this: Signal<T>, target: T, k = 100, c = 10): Animator<void> {
    return spring(this, target, k, c);
  },
  toward<T>(this: Signal<T>, target: T, speed: Val<number>): Animator<void> {
    return toward(this, target, speed);
  },
};

const cellImpl = {
  from<T>(this: Signal<T>, source: Val<T>): Animator<void> {
    return from(this, source);
  },
  holding<T>(this: Signal<T>, v: T, dur: Val<number>): Animator<void> {
    return holding(this, v, dur);
  },
  driven<T>(this: Signal<T>, step: (dt: number, t: number, v: T) => T | false): Animator<void> {
    return driven(this, step);
  },
};

// Universal cell-temporal methods are available on every Signal.
Object.assign(Signal.prototype, cellImpl);

// Type-side declaration of the universal methods.
declare module "./signal" {
  interface Signal<T> extends CellMethods<T> {}
}

// ════════════════════════════════════════════════════════════════════
// play() — thin fluent facade for .until/.then/.at over any Animator
// ════════════════════════════════════════════════════════════════════

export interface Play<R = void> extends Animator<R> {
  /** End when `p` fires (truthy cell, animator completion, n-second sleep, etc.) */
  until(p: Yieldable | Signal<unknown>): Play<R>;
  /** Sequence: this, then `next`. */
  then(next: Yieldable | Signal<unknown>): Play<unknown>;
  /** Time-scale this and its children. */
  at(scale: Val<number>): Play<R>;
}

class PlayImpl<R> implements Play<R> {
  constructor(private g: Animator<R>) {}
  next(v?: number) { return this.g.next(v as number); }
  return(v?: R) { return this.g.return(v as R); }
  throw(e: unknown) { return this.g.throw(e); }
  [Symbol.iterator]() { return this; }

  until(p: Yieldable | Signal<unknown>): Play<R> {
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

  then(next: Yieldable | Signal<unknown>): Play<unknown> {
    const g = this.g;
    return new PlayImpl(
      (function* () { yield* g; yield* playableGen(next); })(),
    );
  }

  at(scale: Val<number>): Play<R> {
    return new PlayImpl(scaledGen(this.g, scale));
  }
}

/** Lift any yieldable into a Play. Cells become wait-until-truthy. */
export function play<R>(g: Animator<R>): Play<R>;
export function play(p: Yieldable | Signal<unknown>): Play<unknown>;
export function play(p: Yieldable | Signal<unknown>): Play<unknown> {
  if (p instanceof PlayImpl) return p;
  return new PlayImpl(playableGen(p));
}

function* playableGen(p: Yieldable | Signal<unknown>): Animator<unknown> {
  if (p instanceof Signal) {
    yield* untilTrue(p);
    return undefined;
  }
  if (p === undefined || p === null) return undefined;
  if (typeof p === "object" && (p as Animator<unknown>).next) {
    return yield* (p as Animator<unknown>);
  }
  yield p as Yieldable;
  return undefined;
}

/** Wait until `sig.value` is truthy. */
export function untilTrue(sig: Signal<unknown>): Animator<void> {
  return suspend<void>((wake) => {
    let resolved = false;
    return effect(() => {
      if (resolved) return;
      if (sig.value) { resolved = true; wake(); }
    });
  });
}

/** Wrap a gen so child resume-dts are scaled. Static scale skips the read. */
function scaledGen<R>(g: Animator<R>, scale: Val<number>): Animator<R> {
  if (typeof scale === "number") {
    const k = scale;
    return mapDt(g, (dt) => dt * k);
  }
  const get = scale instanceof Signal ? () => (scale as Signal<number>).value : (scale as () => number);
  return mapDt(g, (dt) => dt * get());
}

function* mapDt<R>(g: Animator<R>, f: (dt: number) => number): Animator<R> {
  let r = g.next();
  let resume: any;
  while (!r.done) {
    const v = r.value;
    if (typeof v === "number") {
      // Numeric resume values (sleep duration) get f-scaled.
      resume = (yield f(v));
      r = g.next(typeof resume === "number" ? resume : 0);
    } else {
      resume = (yield v);
      r = g.next(resume);
    }
  }
  return r.value;
}
