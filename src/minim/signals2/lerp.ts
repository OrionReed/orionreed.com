// lerp.ts — the signals → generators bridge.
//
// Where signals live ON cells (state), this file lives BETWEEN cells
// and the runtime. It contains:
//
//   • The `[LERP]` trait method bundle (`.to()` on cells)
//   • Free-fn temporal animators dispatched by traits:
//       tween (LERP), spring/toward (LINEAR + METRIC),
//       holding/from/driven (no trait needed)
//   • The `Tween<T>` chainable wrapper for `.to(A).to(B).from(start)`
//   • `play(...)` fluent surface — `.until / .then / .at`
//   • `untilTrue(sig)` — wait until cell value is truthy

import { Signal, effect, type Val } from "./signal";
import {
  LERP, LINEAR, METRIC, EQUALS,
  type Linear, type Lerp, type Metric, type Equals,
} from "./traits";
import {
  drive, suspend, race, type Animator, type Yieldable,
} from "./anim";
import { type Easing, easeOut } from "./easings";
export { type Easing, linear, easeIn, easeOut, easeInOut } from "./easings";

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

/** Scale every dt the gen sees:
 *  • sleep durations (`yield N`) yielded out are passed through f
 *  • dts the runtime resumes us with are passed back to gen as f(dt)
 *
 *  Both directions cover sleep-based pacing AND drive-based per-frame
 *  loops (since drive is now yield-based — the runtime feeds dt via
 *  gen.next(dt)). */
function* mapDt<R>(g: Animator<R>, f: (dt: number) => number): Animator<R> {
  let r = g.next();
  while (!r.done) {
    const v = r.value;
    const out: Yieldable = typeof v === "number" ? f(v) : v;
    const resume = (yield out);
    r = g.next(typeof resume === "number" ? f(resume) : resume);
  }
  return r.value;
}
