// signals ↔ generators bridge: .to(), spring/toward/attract, play, when.

import {
  Signal,
  Computed,
  computed,
  effect,
  type Val,
  type Read,
} from "./signal";
import {
  LERP,
  LINEAR,
  METRIC,
  EQUALS,
  type Linear,
  type Lerp,
  type Metric,
  type Equals,
} from "./traits";
import {
  drive,
  isGen,
  suspend,
  race,
  withScale,
  type Animator,
  type Tick,
  type Yieldable,
  type Easing,
  easeOut,
} from "../core";

const defaultEase = easeOut;

type Seg<T> =
  | { readonly kind: "pose"; readonly target: T }
  | { readonly kind: "to"; readonly target: T; readonly dur: Val<number>; readonly ease?: Easing };

/** Chainable Animator over a Signal: `.to(...).to(...).from(start)` reads
 *  naturally. `.to`/`.from` are pure data — segments accumulate at
 *  construction; the executor generator runs them in order on iteration. */
export class Tween<T> implements Animator<void> {
  readonly #sig: Signal<T>;
  readonly #segs: readonly Seg<T>[];
  readonly #gen: Animator<void>;

  /** @internal — use `tween(...)` or `sig.to(...)` to construct. */
  constructor(sig: Signal<T>, segs: readonly Seg<T>[] = []) {
    this.#sig = sig;
    this.#segs = segs;
    this.#gen = (function* () {
      for (const seg of segs) {
        if (seg.kind === "pose") { sig.value = seg.target; continue; }
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

  next(v?: Tick): IteratorResult<Yieldable, void> { return this.#gen.next(v as Tick); }
  return(v?: void): IteratorResult<Yieldable, void> { return this.#gen.return(v as void); }
  throw(e: unknown): IteratorResult<Yieldable, void> { return this.#gen.throw(e); }
  [Symbol.iterator](): this { return this; }
}

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
  // `t` is `tick.elapsed - start` each frame (no compounding); the
  // engine clock itself rounds at single-step scale, so a sub-dt
  // tolerance at the boundary handles that one-step error.
  yield* drive((tick, t) => {
    const total = D();
    if (total <= 0 || t + tick.dt * 1e-3 >= total) {
      sig.value = target;
      return false;
    }
    sig.value = lerpFn(start, target, ease(t / total));
  });
}

/** Free-fn form of `.to()` for signals without the method installed. */
export function tween<T>(
  sig: Signal<T>,
  target: T,
  dur: Val<number>,
  ease?: Easing,
): Tween<T> {
  return new Tween(sig, [{ kind: "to", target, dur, ease }]);
}

export interface SpringOpts {
  /** Natural angular frequency (rad/s). Period of unforced oscillation
   *  ≈ 2π/ω. Default 13 (≈ 0.48 s period). Equivalent to the older
   *  Hooke `stiffness = ω²`. */
  omega?: number;
  /** Damping ratio (dimensionless). `<1` underdamped (oscillates),
   *  `=1` critically damped (fastest non-overshooting), `>1` overdamped
   *  (sluggish). Default 1. Equivalent to `damping = 2·ζ·ω`. */
  zeta?: number;
  /** Settle threshold; snap+complete when distance < precision and
   *  velocity magnitude < precision*100. Default 1e-4. `0` runs forever. */
  precision?: number;
}

/** Pull `sig` toward `target` with second-order damped-spring dynamics:
 *  `x'' = ω²·(target - x) - 2ζω·x'`. Closed-form per step — unconditionally
 *  stable at any `dt`, branches by damping regime. `target` may be reactive
 *  (sampled each frame, treated as piecewise constant over `dt`). Settles
 *  when `‖x - target‖ < eps` and `‖v‖ < eps · ω`. */
export function* spring<T>(
  sig: Signal<T>,
  target: Val<T>,
  opts: SpringOpts = {},
): Animator<void> {
  const lin = sig[LINEAR];
  const met = sig[METRIC];
  if (!lin || !met) {
    throw new Error(
      `spring: ${sig.constructor.name} needs [LINEAR] + [METRIC]`,
    );
  }
  const omega = opts.omega ?? 13;
  const zeta = opts.zeta ?? 1;
  const eps = opts.precision ?? 1e-4;
  const T = valFn(target);

  // Zero-vector of the value's algebra; produced by scaling any T by 0.
  const zero: T = lin.scale(sig.peek(), 0);
  let vel: T = zero;

  yield* drive((tick) => {
    const dt = tick.dt;
    const t = T();
    const cur = sig.peek();
    // Solve in displacement-space: e = cur - target (so target ≡ origin).
    // Closed-form for ė = v, v̇ = -ω²·e - 2ζω·v over a step of length dt.
    const e0 = lin.sub(cur, t);
    const v0 = vel;

    let e1: T, v1: T;
    if (zeta < 1 - 1e-6) {
      // Underdamped: oscillating envelope.
      const zw = zeta * omega;
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const E = Math.exp(-zw * dt);
      const c = Math.cos(wd * dt);
      const s = Math.sin(wd * dt);
      // B = (v0 + zw·e0) / wd
      const B = lin.scale(lin.add(v0, lin.scale(e0, zw)), 1 / wd);
      // e1 = E · (e0·c + B·s)
      const inner = lin.add(lin.scale(e0, c), lin.scale(B, s));
      e1 = lin.scale(inner, E);
      // v1 = -zw·e1 + E·wd · (B·c - e0·s)
      const swing = lin.sub(lin.scale(B, c), lin.scale(e0, s));
      v1 = lin.add(lin.scale(e1, -zw), lin.scale(swing, E * wd));
    } else if (zeta > 1 + 1e-6) {
      // Overdamped: two real roots.
      const r = omega * Math.sqrt(zeta * zeta - 1);
      const r1 = -zeta * omega + r;
      const r2 = -zeta * omega - r;
      const denom = r2 - r1;
      // B = (v0 - r1·e0) / (r2 - r1); A = e0 - B
      const B = lin.scale(lin.sub(v0, lin.scale(e0, r1)), 1 / denom);
      const A = lin.sub(e0, B);
      const E1 = Math.exp(r1 * dt);
      const E2 = Math.exp(r2 * dt);
      e1 = lin.add(lin.scale(A, E1), lin.scale(B, E2));
      v1 = lin.add(lin.scale(A, r1 * E1), lin.scale(B, r2 * E2));
    } else {
      // Critically damped (ζ ≈ 1).
      const E = Math.exp(-omega * dt);
      // B = v0 + ω·e0; e(t) = (e0 + B·t)·E
      const B = lin.add(v0, lin.scale(e0, omega));
      const Bt = lin.scale(B, dt);
      e1 = lin.scale(lin.add(e0, Bt), E);
      // v(t) = B·E - ω·e(t)
      v1 = lin.sub(lin.scale(B, E), lin.scale(e1, omega));
    }

    vel = v1;
    sig.value = lin.add(t, e1); // x_new = target + e_new

    // Settle: both displacement and velocity small (dimensionally matched).
    if (eps > 0 && met(e1, zero) < eps && met(v1, zero) < eps * omega) {
      sig.value = t;
      return false;
    }
  });
}

/** Constant-speed approach (units-of-T per second). */
export function* toward<T>(
  sig: Signal<T>,
  target: Val<T>,
  speed: Val<number>,
): Animator<void> {
  const lin = sig[LINEAR];
  const met = sig[METRIC];
  if (!lin || !met) {
    throw new Error(
      `toward: ${sig.constructor.name} needs [LINEAR] + [METRIC]`,
    );
  }
  const T = valFn(target);
  const S = valFn(speed);
  yield* drive((tick) => {
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

/** Exponential pull toward `target` at rate `k`/s (no overshoot). */
export function* attract<T>(
  sig: Signal<T>,
  target: Val<T>,
  k: Val<number> = 1,
): Animator<void> {
  const lin = sig[LINEAR];
  if (!lin) throw new Error(`attract: ${sig.constructor.name} needs [LINEAR]`);
  const T = valFn(target);
  const K = valFn(k);
  yield* drive((tick) => {
    const cur = sig.peek();
    const delta = lin.scale(lin.sub(T(), cur), K() * tick.dt);
    sig.value = lin.add(cur, delta);
  });
}

function valFn<T>(v: Val<T>): () => T {
  if (v instanceof Signal) return () => v.value;
  if (typeof v === "function") return v as () => T;
  return () => v as T;
}

/** Generator-scoped reactive bind; cleans up when the parent ends. */
export function follow<T>(sig: Signal<T>, source: Val<T>): Animator<void> {
  return suspend<void>((_wake) => sig.bind(source));
}

export function* wave<T>(
  sig: Signal<T>,
  fn: (t: number, initial: T) => T,
): Animator<void> {
  const initial = sig.peek();
  yield* drive((_tick, t) => {
    sig.value = fn(t, initial);
  });
}

/** Escape hatch: drive sig per frame with `step(dt, t, current)`.
 *  Return `false` to terminate. Use `wave` instead for pure `f(t)`. */
export function* driven<T>(
  sig: Signal<T>,
  step: (dt: number, t: number, v: T) => T | false,
): Animator<void> {
  yield* drive((tick, t) => {
    const next = step(tick.dt, t, sig.peek());
    if (next === false) return false;
    sig.value = next;
  });
}

export interface LerpMethods<T> {
  to(target: T, dur: Val<number>, ease?: Easing): Tween<T>;
}

export const lerpImpl = {
  to<T>(this: Signal<T>, target: T, dur: Val<number>, ease?: Easing): Tween<T> {
    return tween(this, target, dur, ease);
  },
};

const TRAIT_METHODS: Record<symbol, object | undefined> = {
  [LERP]: lerpImpl,
};

/** Stamp `Cls.prototype[slot] = impl`; installs method bundle if any. */
interface ProtoTarget {
  prototype: object;
}
export function defineTrait<T>(
  Cls: ProtoTarget,
  slot: typeof LERP,
  impl: Lerp<T>,
): void;
export function defineTrait<T>(
  Cls: ProtoTarget,
  slot: typeof LINEAR,
  impl: Linear<T>,
): void;
export function defineTrait<T>(
  Cls: ProtoTarget,
  slot: typeof METRIC,
  impl: Metric<T>,
): void;
export function defineTrait<T>(
  Cls: ProtoTarget,
  slot: typeof EQUALS,
  impl: Equals<T>,
): void;
export function defineTrait(
  Cls: ProtoTarget,
  slot: symbol,
  impl: unknown,
): void {
  (Cls.prototype as Record<symbol, unknown>)[slot] = impl;
  const methods = TRAIT_METHODS[slot];
  if (methods) Object.assign(Cls.prototype, methods);
}

// `Read<unknown>` (covariant) accepts any `Signal<T>` / `Computed<T>`;
// `Signal<unknown>` doesn't (invariant in T) and `Signal<any>` is
// bivariant noise. `playableGen` narrows back to `Signal` at runtime.
export type PlayTrigger = Yieldable | Read<unknown>;

export interface Play<R = void> extends Animator<R> {
  /** End when `p` fires (truthy signal / animator completion / sleep). */
  until(p: PlayTrigger): Play<R>;
  /** Sequence: this, then `next`. */
  then(next: PlayTrigger): Play<unknown>;
  /** Time-scale this and its children. */
  at(scale: Val<number>): Play<R>;
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
        const result = yield* race(
          g as Animator<unknown>,
          trigger,
        ) as Animator<unknown>;
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

  at(scale: Val<number>): Play<R> {
    const get = valFn(scale);
    return new PlayImpl(withScale(() => get(), this.g));
  }
}

/** Lift any yieldable / signal-trigger / animator-factory into a Play. */
export function play<R>(g: Animator<R> | (() => Animator<R>)): Play<R>;
export function play(p: PlayTrigger | (() => Animator)): Play<unknown>;
export function play(p: PlayTrigger | (() => Animator)): Play<unknown> {
  if (p instanceof PlayImpl) return p;
  // Nullary fn = factory; arity-1 `Suspend` impls aren't unwrapped here.
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
  return suspend<void>((wake) => {
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

/** Reactive boolean negation as a `Computed<boolean>`. */
export function not(sig: Read<unknown>): Computed<boolean> {
  return computed(() => !sig.value);
}

/** Wait until `sig` changes; resumes with the new value. */
export function untilChange<T>(sig: Signal<T>): Animator<T> {
  return suspend<T>((wake) => {
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

/** Repeat `factory()` forever; bound via `.until(sig)`. Factories
 *  returning a bare `Animator` delegate via `yield*` (no boundary frame);
 *  arrays / other Yieldables go through `yield` (parallel / spawn). */
export function loop(factory: () => Yieldable): Play {
  return play(
    (function* (): Animator {
      while (true) {
        const y = factory();
        if (isGen(y)) yield* y;
        else yield y;
      }
    })(),
  );
}

/** Run `fn` every `sec` seconds (drift-corrected, `sec` may be reactive).
 *  Schedules against `tick.elapsed` so there's no float accumulation. */
export function every(sec: Val<number>, fn: () => void): Play {
  const getSec = valFn(sec);
  return play(
    (function* (): Animator {
      let tick = yield;
      let nextAt = tick.elapsed + Math.max(0, getSec());
      while (true) {
        tick = yield;
        const period = getSec();
        if (period <= 0) { nextAt = tick.elapsed; continue; }
        while (tick.elapsed >= nextAt) {
          fn();
          nextAt += period;
        }
      }
    })(),
  );
}
