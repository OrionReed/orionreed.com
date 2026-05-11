// Suspension adapters and combinators. Each adapter is a generator
// function returning `Animator<R>`; `yield* aw(...)` resumes with the
// typed payload at the call site.
//
//     const evt = yield* onceEvent(el, "click");   // Event
//     const v   = yield* untilChange(sig);         // T (sig's new value)
//
// Sync-resolve (calling `wake` before returning) is fine.

import {
  asGen,
  isGen,
  suspend,
  type Animator,
  type SpawnFn,
  type Yieldable,
} from "./anim";
import { effect, type ReadonlySignal } from "./signal";

// ── Adapters ────────────────────────────────────────────────────────

/** Wake on the next change of `sig`; resume with the new value. The
 *  baseline read is ignored. */
export function* untilChange<T>(sig: ReadonlySignal<T>): Animator<T> {
  return yield* suspend<T>((wake) => {
    let first = true;
    return effect(() => {
      const v = sig.value;
      if (first) {
        first = false;
        return;
      }
      wake(v);
    });
  });
}

/** Wake when `sig` is truthy. Wakes immediately if already truthy. No
 *  payload — `true` is the only thing it would ever carry. For
 *  "becomes falsy," pass `sig.derive(v => !v)`. */
export function* untilTrue(sig: ReadonlySignal<unknown>): Animator<void> {
  return yield* suspend((wake) => {
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

/** Wake on one DOM event; resume with the event. Listener auto-removes
 *  on fire or cancel. */
export function* onceEvent(
  target: EventTarget,
  name: string,
  opts?: AddEventListenerOptions,
): Animator<Event> {
  return yield* suspend<Event>((wake) => {
    const handler = (e: Event): void => wake(e);
    target.addEventListener(name, handler, { ...opts, once: true });
    return () => target.removeEventListener(name, handler);
  });
}

/** Wake when `p` settles; resume with the resolved value. Cancel
 *  suppresses `wake` (the promise itself can't be cancelled). */
export function* fromPromise<T>(p: Promise<T>): Animator<T> {
  return yield* suspend<T>((wake) => {
    let cancelled = false;
    p.then((v) => {
      if (!cancelled) wake(v);
    });
    return () => {
      cancelled = true;
    };
  });
}

// ── Combinators ─────────────────────────────────────────────────────

/** Extract the payload type from a `Yieldable`. Generators carry their
 *  return value in `R`; raw `SuspendFn<T>` lambdas (rare in user code)
 *  carry `T`; everything else (numbers, arrays, undefined) is `void`. */
type PayloadOf<Y> = Y extends Generator<any, infer R, any>
  ? R
  : Y extends (wake: (value: infer T) => void, spawn: SpawnFn) => () => void
    ? T
    : Y extends (wake: () => void, spawn: SpawnFn) => () => void
      ? void
      : void;

/** First-completion race; resume with the winning child's payload.
 *  Children may be any `Yieldable` (generator, raw suspend-fn, number
 *  sleep, array parallel, `undefined` one frame). First to finish
 *  wakes the parent with its payload; the rest are cancelled.
 *  Non-payload children (gens with `R = void`, sleeps, parallels)
 *  contribute `void` to the payload union — the winner being one of
 *  those resumes with `undefined`. */
export function* race<Cs extends readonly Yieldable[]>(
  ...children: Cs
): Animator<PayloadOf<Cs[number]>> {
  return yield* suspend<PayloadOf<Cs[number]>>((wake, spawn) => {
    type V = PayloadOf<Cs[number]>;
    let won = false;
    let setupDone = false;
    let pending = false;
    let pendingValue: V | undefined;
    // A sync-completing child during the spawn loop defers its wake
    // until all siblings are spawned, so cancel still reaches losers.
    const safeWake = (value?: V): void => {
      if (won) return;
      won = true;
      if (setupDone) (wake as (v?: V) => void)(value);
      else {
        pending = true;
        pendingValue = value;
      }
    };
    const disposers: (() => void)[] = [];
    for (const c of children) {
      if (typeof c === "function" && !isGen(c)) {
        // Bare suspend-fn — subscribe directly, sharing our spawn so
        // nested combinators (race-of-races) work without rewrapping.
        disposers.push(
          (
            c as (
              wake: (v: unknown) => void,
              spawn: SpawnFn,
            ) => () => void
          )(safeWake as (v: unknown) => void, spawn),
        );
      } else {
        // Gen / number / array / undefined — payload-less; safeWake
        // gets called with no args, V resolves to `undefined`.
        disposers.push(spawn(asGen(c), safeWake as () => void));
      }
    }
    setupDone = true;
    if (pending) (wake as (v?: V) => void)(pendingValue);
    return () => {
      for (const d of disposers) d();
    };
  });
}

/** Run `work` until `trigger` fires (cancel-on-trigger). Sugar over
 *  `race(work, trigger)`. Resume value is whichever side won. The next
 *  `yield*` after `yield until(...)` is the graceful-exit sequel. */
export function* until<W extends Yieldable, T extends Yieldable>(
  trigger: T,
  work: W,
): Animator<PayloadOf<W> | PayloadOf<T>> {
  return yield* race(work, trigger) as Animator<
    PayloadOf<W> | PayloadOf<T>
  >;
}
