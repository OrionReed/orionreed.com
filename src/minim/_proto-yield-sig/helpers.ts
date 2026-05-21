// helpers.ts — bridge layer between signals and the engine.
//
// Demonstrates the cascading simplifications when signals are Yieldable:
//   - `playableGen` dispatches on `Symbol.iterator` (no `instanceof Signal` branch).
//   - `untilChange` / `untilEvent` / `untilPromise` collapse to `yield* sig`.
//   - `when(sig)` keeps its truthy-with-immediate semantic (genuinely different).
//   - `not(sig)` stays as a derived signal helper.
//   - For "wait until falsy with immediate," compose: `when(not(sig))`.
//
// The naming question (`when + whenNot` vs `truthy + falsy` vs `when + not`):
// I've kept `when` (truthy-wait) as the primary verb and `not` as a
// derived-signal helper that composes via `when(not(sig))`. Aliases for the
// other two naming options are exported below for comparison.

import {
  type Animator,
  type Yieldable,
  type Tick,
  type Suspend,
  isGenerator,
  isIterableYieldable,
} from "./engine";
import { Signal, type Read, computed, effect } from "./signal";

const toAnimator = (arg: Yieldable): Animator<unknown> => {
  if (isGenerator(arg)) return arg as Animator<unknown>;
  if (isIterableYieldable(arg))
    return (arg as Iterable<Yieldable>)[Symbol.iterator]() as Animator<unknown>;
  // Primitive Yieldable (number/undefined): yield it, drop the engine's
  // tick payload — the meaningful "winner value" for a timer is `undefined`.
  return (function* () {
    yield arg;
    return undefined;
  })() as Animator<unknown>;
};

// ─── Suspend wrapper — generator-shaped ─────────────────────────────

export function suspend<T = void>(impl: Suspend<T>): Animator<T> {
  return (function* () {
    return yield impl as Yieldable;
  })() as Animator<T>;
}

// ─── Drive: per-frame stepping (used by tween/spring/wave/etc.) ─────

export function* drive(
  step: (tick: Tick, t: number) => void | false,
): Animator<void> {
  let t = 0;
  while (true) {
    const tick = (yield) as Tick;
    t += tick.dt;
    if (step(tick, t) === false) return;
  }
}

// ─── Race / All — concurrent yieldables ─────────────────────────────
//
// `concurrent` shape with `cut`-like first-settles semantics is built
// into the engine via array-yield. `race` returns the first result;
// `all` returns the array of all. Both accept Yieldables uniformly —
// because signals are Yieldable, they slot in for free.

export function* race<T>(...args: Yieldable[]): Animator<T> {
  const result = (yield args) as unknown as T[];
  // The engine's array-yield resolves all kids; we want first-finish only.
  // For test simplicity, we fake "first finish" via a wrapper — see below.
  return result[0] as T;
}

// Real `race` — uses the suspend protocol to settle on first.
export function* raceFirst(...args: Yieldable[]): Animator<unknown> {
  const impl: Suspend<unknown> = (wake, spawn) => {
    const cancels: Array<() => void> = [];
    let settled = false;
    const finish = (v: unknown, asThrow: boolean): void => {
      if (settled) return;
      settled = true;
      for (const c of cancels) c();
      if (asThrow) wake.throw(v);
      else wake(v);
    };
    for (const arg of args) {
      const gen = toAnimator(arg);
      const dispose = spawn(
        (function* () {
          try {
            const v = yield* gen;
            finish(v, false);
          } catch (e) {
            finish(e, true);
          }
        })(),
      );
      cancels.push(dispose);
    }
  };
  return yield impl as Yieldable;
}

function* asYieldGen(y: Yieldable): Animator<unknown> {
  return yield y;
}

export function* all(...args: Yieldable[]): Animator<unknown[]> {
  const result = (yield args as Yieldable) as unknown as unknown[];
  return result;
}

// ─── Play: chainable wrapper with .until / .then ────────────────────

export interface Play<R = void> extends Animator<R> {
  until(p: Yieldable): Play<R>;
  then(next: Yieldable): Play<unknown>;
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
  until(p: Yieldable): Play<R> {
    const trigger = playableGen(p);
    const g = this.g;
    return new PlayImpl<R>(
      (function* () {
        const result = (yield* raceFirst(g, trigger)) as R;
        return result;
      })(),
    );
  }
  then(next: Yieldable): Play<unknown> {
    const g = this.g;
    return new PlayImpl(
      (function* () {
        yield* g;
        yield* playableGen(next);
      })(),
    );
  }
}

export function play<R>(g: Animator<R>): Play<R> {
  if (g instanceof PlayImpl) return g as Play<R>;
  return new PlayImpl(g);
}

// `playableGen` simplified — the entire signal-special-case branch is
// gone because signals match the `Symbol.iterator in p` branch via
// their iterator method.
function* playableGen(p: Yieldable): Animator<unknown> {
  if (p === undefined || p === null) return undefined;
  if (typeof p === "object" && Symbol.iterator in (p as object)) {
    return yield* p as Animator<unknown>;
  }
  yield p as Yieldable;
  return undefined;
}

// ─── when / not — truthy-wait and bool negation ─────────────────────

/** Wait until `sig.value` is truthy. Wakes immediately if already true.
 *  Different from `yield* sig` (which is change-wait, not truthy-wait). */
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

/** Reactive boolean negation as a derived `Signal<boolean>`.
 *  `when(not(sig))` is the falsy-wait-with-immediate idiom. */
export function not(sig: Read<unknown>): Signal<boolean> {
  return computed(() => !sig.value);
}

// ─── Naming alternatives (for comparison; pick one in real impl) ────

/** Alias for `when` — fits the `truthy` / `falsy` adjective pair. */
export const truthy = when;

/** Alias for `when(not(sig))` — fits the `truthy` / `falsy` adjective pair. */
export const falsy = (sig: Read<unknown>): Animator<void> => when(not(sig));

/** Alias for `when(not(sig))` — fits the `when` / `whenNot` symmetric pair. */
export const whenNot = falsy;

// ─── Loop / every — convenience for repeated patterns ───────────────

export function loop(factory: () => Yieldable): Animator<never> {
  return (function* () {
    while (true) {
      const y = factory();
      if (isGenerator(y)) yield* y;
      else yield y;
    }
  })() as Animator<never>;
}
