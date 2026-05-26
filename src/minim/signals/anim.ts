// anim.ts — animator primitives over `Animatable<T, K>` (writable +
// nominal trait constraint), plus the broader signals↔generators bridge.
//
// All animator signatures read as a sentence:
//   "spring takes a writable carrying T that has linear+metric."
// Compile errors:
//   - `spring(box, …)` — Box doesn't declare `metric` trait.
//   - `spring(roVec, …)` — bare RO Vec doesn't carry `WritableBrand`.
//   - `spring(num(0), …)` — works (num() returns Writable<Num>).

import {
  type Animator,
  drive,
  type Easing,
  easeOut,
  isGenerator,
  race,
  suspend,
  type Tick,
  type Yieldable,
} from "../core";
import { computed, effect, type Read, Signal, type Val, valFn, type WritableOf } from "./signal";
import { requireLerp, requireLinear, requireMetric, type TraitKey, type Traits } from "./traits";

const defaultEase = easeOut;

/** Animator-style constraint: a writable reactive carrying `T` whose
 *  class declares the listed traits. Reads as a sentence:
 *
 *      function spring<T>(s: Animatable<T, "linear" | "metric">, …) */
export type Animatable<T, K extends TraitKey = never> = WritableOf<T> & Traits<T, K>;

// ─── Tween chainable builder ────────────────────────────────────────

type Seg<T> =
  | { readonly kind: "pose"; readonly target: T }
  | { readonly kind: "to"; readonly target: T; readonly dur: Val<number>; readonly ease?: Easing };

/** Chainable Animator over a writable signal: `.to(...).to(...).from(start)`
 *  reads naturally. `.to`/`.from` are pure data — segments accumulate at
 *  construction; the executor generator runs them in order on iteration. */
export class Tween<T> implements Animator<void> {
  readonly #sig: Animatable<T, "lerp">;
  readonly #segs: readonly Seg<T>[];
  readonly #gen: Animator<void>;

  /** @internal — use `tween(...)` or `sig.to(...)` to construct. */
  constructor(sig: Animatable<T, "lerp">, segs: readonly Seg<T>[] = []) {
    this.#sig = sig;
    this.#segs = segs;
    this.#gen = (function* () {
      for (const seg of segs) {
        if (seg.kind === "pose") {
          sig.value = seg.target;
          continue;
        }
        yield* tweenStep(sig, seg.target, seg.dur, seg.ease);
      }
    })();
  }

  /** Append a tween segment from current value to `target` over `dur`. */
  to(target: T, dur: Val<number>, ease?: Easing): Tween<T> {
    return new Tween(this.#sig, [...this.#segs, { kind: "to", target, dur, ease }]);
  }

  /** Pose `start` as the first step, then run the rest of the chain. */
  from(start: T): Tween<T> {
    return new Tween(this.#sig, [{ kind: "pose", target: start }, ...this.#segs]);
  }

  next(v?: Tick): IteratorResult<Yieldable, void> {
    return this.#gen.next(v as Tick);
  }
  return(v?: void): IteratorResult<Yieldable, void> {
    return this.#gen.return(v as void);
  }
  throw(e: unknown): IteratorResult<Yieldable, void> {
    return this.#gen.throw(e);
  }
  [Symbol.iterator](): this {
    return this;
  }
}

// ─── tween ──────────────────────────────────────────────────────────

/** Append-only tween segment over a writable reactive target. */
function* tweenStep<T>(
  sig: Animatable<T, "lerp">,
  target: T,
  dur: Val<number>,
  ease: Easing = defaultEase,
): Animator<void> {
  const lerp = requireLerp(sig);
  const start = sig.peek();
  const D = valFn(dur);
  yield* drive((tick, t) => {
    const total = D();
    if (total <= 0 || t + tick.dt * 1e-3 >= total) {
      sig.value = target;
      return false;
    }
    sig.value = lerp(start, target, ease(t / total));
  });
}

/** Free-fn form of one-shot tween — returns a chainable `Tween<T>`. */
export function tween<T>(
  sig: Animatable<T, "lerp">,
  target: T,
  dur: Val<number>,
  ease?: Easing,
): Tween<T> {
  return new Tween(sig, [{ kind: "to", target, dur, ease }]);
}

// ─── spring ─────────────────────────────────────────────────────────

export interface SpringOpts<T = unknown> {
  /** Natural angular frequency (rad/s). Default 13 (~0.48 s period). */
  omega?: number;
  /** Damping ratio. <1 underdamped, =1 critical, >1 overdamped. Default 1. */
  zeta?: number;
  /** Settle threshold; snap+complete when both ‖e‖ < eps and ‖v‖ < eps·ω. */
  precision?: number;
  /** Per-frame rate multiplier on `tick.dt`. 0 freezes evolution; 2× doubles
   *  speed. Reactive — re-read each frame. Default 1. */
  rate?: () => number;
  /** Project each frame's next value into an admissible set (clamp to a
   *  range, snap to a manifold, etc.). If projection moves the value,
   *  velocity is reset to zero — soft absorbing wall, no integrator
   *  fighting the boundary. Pair with `precision: 0` when the target
   *  may lie outside the admissible set (settle never fires there). */
  project?: (v: T) => T;
}

/** Second-order damped-spring pull. Math unchanged from prod's `spring`. */
export function* spring<T>(
  sig: Animatable<T, "linear" | "metric">,
  target: Val<T>,
  opts: SpringOpts<T> = {},
): Animator<void> {
  const lin = requireLinear(sig);
  const met = requireMetric(sig);
  const omega = opts.omega ?? 13;
  const zeta = opts.zeta ?? 1;
  const eps = opts.precision ?? 1e-4;
  const rate = opts.rate;
  const project = opts.project;
  const T = valFn(target);

  const zero: T = lin.scale(sig.peek(), 0);
  let vel: T = zero;

  yield* drive(tick => {
    const dt = rate ? tick.dt * rate() : tick.dt;
    const t = T();
    const cur = sig.peek();
    const e0 = lin.sub(cur, t);
    const v0 = vel;

    let e1: T, v1: T;
    if (zeta < 1 - 1e-6) {
      const zw = zeta * omega;
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const E = Math.exp(-zw * dt);
      const c = Math.cos(wd * dt);
      const s = Math.sin(wd * dt);
      const B = lin.scale(lin.add(v0, lin.scale(e0, zw)), 1 / wd);
      const inner = lin.add(lin.scale(e0, c), lin.scale(B, s));
      e1 = lin.scale(inner, E);
      const swing = lin.sub(lin.scale(B, c), lin.scale(e0, s));
      v1 = lin.add(lin.scale(e1, -zw), lin.scale(swing, E * wd));
    } else if (zeta > 1 + 1e-6) {
      const r = omega * Math.sqrt(zeta * zeta - 1);
      const r1 = -zeta * omega + r;
      const r2 = -zeta * omega - r;
      const denom = r2 - r1;
      const B = lin.scale(lin.sub(v0, lin.scale(e0, r1)), 1 / denom);
      const A = lin.sub(e0, B);
      const E1 = Math.exp(r1 * dt);
      const E2 = Math.exp(r2 * dt);
      e1 = lin.add(lin.scale(A, E1), lin.scale(B, E2));
      v1 = lin.add(lin.scale(A, r1 * E1), lin.scale(B, r2 * E2));
    } else {
      const E = Math.exp(-omega * dt);
      const B = lin.add(v0, lin.scale(e0, omega));
      const Bt = lin.scale(B, dt);
      e1 = lin.scale(lin.add(e0, Bt), E);
      v1 = lin.sub(lin.scale(B, E), lin.scale(e1, omega));
    }

    const raw = lin.add(t, e1);
    const next = project ? project(raw) : raw;
    if (project && met(next, raw) > 0) {
      e1 = lin.sub(next, t);
      v1 = zero;
    }
    vel = v1;
    sig.value = next;

    if (eps > 0 && met(e1, zero) < eps && met(v1, zero) < eps * omega) {
      sig.value = t;
      return false;
    }
  });
}

// ─── toward / attract ──────────────────────────────────────────────

/** Constant-speed approach (units-of-T per second). Needs linear+metric. */
export function* toward<T>(
  sig: Animatable<T, "linear" | "metric">,
  target: Val<T>,
  speed: Val<number>,
): Animator<void> {
  const lin = requireLinear(sig);
  const met = requireMetric(sig);
  const T = valFn(target);
  const S = valFn(speed);
  yield* drive(tick => {
    const t = T();
    const cur = sig.peek();
    const dist = met(cur, t);
    const step = S() * tick.dt;
    if (dist <= step) {
      sig.value = t;
      return false;
    }
    const dir = lin.scale(lin.sub(t, cur), 1 / dist);
    sig.value = lin.add(cur, lin.scale(dir, step));
  });
}

/** Exponential pull toward `target` at rate `k`/s (no overshoot). Needs linear. */
export function* attract<T>(
  sig: Animatable<T, "linear">,
  target: Val<T>,
  k: Val<number> = 1,
): Animator<void> {
  const lin = requireLinear(sig);
  const T = valFn(target);
  const K = valFn(k);
  yield* drive(tick => {
    const cur = sig.peek();
    const delta = lin.scale(lin.sub(T(), cur), K() * tick.dt);
    sig.value = lin.add(cur, delta);
  });
}

// ─── generator-scoped reactive helpers ────────────────────────────

/** Drive `sig` per frame with a pure function `f(t, initial)`. */
export function* wave<T>(sig: WritableOf<T>, fn: (t: number, initial: T) => T): Animator<void> {
  const initial = sig.peek();
  yield* drive((_tick, t) => {
    sig.value = fn(t, initial);
  });
}

/** Escape hatch: drive sig per frame with `step(dt, t, current)`.
 *  Return `false` to terminate. Use `wave` instead for pure `f(t)`. */
export function* driven<T>(
  sig: WritableOf<T>,
  step: (dt: number, t: number, v: T) => T | false,
): Animator<void> {
  yield* drive((tick, t) => {
    const next = step(tick.dt, t, sig.peek());
    if (next === false) return false;
    sig.value = next;
  });
}

// ─── Play / play / when / loop / every ───────────────────────────────

// `Read<unknown>` (covariant) accepts any Signal<T> / value-class signal;
// `Signal<unknown>` doesn't (invariant in T). `playableGen` narrows back
// to Signal at runtime.
type PlayTrigger = Yieldable | Read<unknown>;

export interface Play<R = void> extends Animator<R> {
  /** End when `p` fires (truthy signal / animator completion / sleep). */
  until(p: PlayTrigger): Play<R>;
  /** Sequence: this, then `next`. */
  then(next: PlayTrigger): Play<unknown>;
}

class PlayImpl<R> implements Play<R> {
  constructor(private g: Animator<R>) {}
  next(v?: Tick) {
    return this.g.next(v as Tick);
  }
  return(v?: R) {
    return this.g.return(v as R);
  }
  throw(e: unknown) {
    return this.g.throw(e);
  }
  [Symbol.iterator]() {
    return this;
  }

  until(p: PlayTrigger): Play<R> {
    const trigger = playableGen(p);
    const g = this.g;
    return new PlayImpl<R>(
      (function* () {
        const result = yield* race(g as Animator<unknown>, trigger) as Animator<unknown>;
        return result as R;
      })(),
    );
  }

  then(next: PlayTrigger): Play<unknown> {
    const g = this.g;
    return new PlayImpl(
      (function* () {
        yield* g;
        yield* playableGen(next);
      })(),
    );
  }
}

/** Lift any yieldable / signal-trigger / animator-factory into a Play. */
export function play<R>(g: Animator<R> | (() => Animator<R>)): Play<R>;
export function play(p: PlayTrigger | (() => Animator)): Play<unknown>;
export function play(p: PlayTrigger | (() => Animator)): Play<unknown> {
  if (p instanceof PlayImpl) return p;
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
    return yield* p as Animator<unknown>;
  }
  yield p as Yieldable;
  return undefined;
}

/** Wait until `sig.value` is truthy. Wakes immediately if already true. */
export function when(sig: Read<unknown>): Animator<void> {
  return suspend<void>(wake => {
    let resolved = false;
    return effect(() => {
      if (resolved) return;
      if (sig.value) {
        resolved = true;
        wake();
      }
    });
  });
}

/** Reactive boolean negation as a `Signal<boolean>` (RO). */
export function not(sig: Read<unknown>): Signal<boolean> {
  return computed(() => !sig.value);
}

/** Wait until `sig` changes; resumes with the new value. */
export function untilChange<T>(sig: Signal<T>): Animator<T> {
  return suspend<T>(wake => {
    const initial = sig.peek();
    let resolved = false;
    return effect(() => {
      const v = sig.value;
      if (resolved) return;
      if (v !== initial) {
        resolved = true;
        wake(v);
      }
    });
  });
}

/** Repeat `factory()` forever; bound via `.until(sig)`. */
export function loop(factory: () => Yieldable): Play {
  return play(
    (function* (): Animator {
      while (true) {
        const y = factory();
        if (isGenerator(y)) yield* y;
        else yield y;
      }
    })(),
  );
}

/** Run `fn` every `sec` seconds (drift-corrected, `sec` may be reactive). */
export function every(sec: Val<number>, fn: () => void): Play {
  const getSec = valFn(sec);
  return play(
    (function* (): Animator {
      let tick = yield;
      let nextAt = tick.elapsed + Math.max(0, getSec());
      while (true) {
        tick = yield;
        const period = getSec();
        if (period <= 0) {
          nextAt = tick.elapsed;
          continue;
        }
        while (tick.elapsed >= nextAt) {
          fn();
          nextAt += period;
        }
      }
    })(),
  );
}
