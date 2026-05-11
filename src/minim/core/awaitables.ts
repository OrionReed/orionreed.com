// Awaitable adapters and combinators. Every awaitable has the same
// shape: subscribe + return a disposer. Combinators that orchestrate
// generators (`race`, `until`) accept a `spawn` capability — the
// runtime hands one to every awaitable, but simple subscribers (event
// listeners, signal-change waiters, promise bridges) ignore it and
// keep their one-arg `(wake) => dispose` shape unchanged.
//
// Sync-resolve is allowed (calling `wake()` before returning is fine —
// `Anim` handles it).

import { asGen, isGen, type Awaitable, type Yieldable } from "./anim";
import { effect, type ReadonlySignal } from "./signal";

// ── Adapters ────────────────────────────────────────────────────────

/** Wake on the next change of `sig`. The first effect run is the
 *  baseline (already-current value) — we ignore it; the next change
 *  fires `wake`. Built on Preact's `effect` so the value is read once
 *  for tracking, no polling. */
export function untilChange<T>(sig: ReadonlySignal<T>): Awaitable {
  return (wake) => {
    let first = true;
    return effect(() => {
      sig.value;
      if (first) {
        first = false;
        return;
      }
      wake();
    });
  };
}

/** Wake when `sig` becomes truthy. Wakes immediately if the value is
 *  already truthy at subscribe time (sync-resolve). For "wake on any
 *  change," use `untilChange`; for "wake when becomes falsy," derive
 *  the negation: `untilTrue(sig.derive(v => !v))`. */
export function untilTrue(sig: ReadonlySignal<unknown>): Awaitable {
  return (wake) => {
    let resolved = false;
    return effect(() => {
      if (resolved) return;
      if (sig.value) {
        resolved = true;
        wake();
      }
    });
  };
}

/** Wake on one DOM event (or any `EventTarget`). Listener auto-removes
 *  after firing; the disposer also removes it (cancel before fire). */
export function onceEvent(
  target: EventTarget,
  name: string,
  opts?: AddEventListenerOptions,
): Awaitable {
  return (wake) => {
    const handler = (): void => wake();
    target.addEventListener(name, handler, { ...opts, once: true });
    return () => target.removeEventListener(name, handler);
  };
}

/** Wake when `p` settles (fulfilled or rejected). The disposer flips
 *  a cancellation flag — the promise's settlement still fires, but
 *  `wake` is suppressed. (Promises can't be cancelled; this is the
 *  best we can do.) */
export function fromPromise(p: Promise<unknown>): Awaitable {
  return (wake) => {
    let cancelled = false;
    p.finally(() => {
      if (!cancelled) wake();
    });
    return () => {
      cancelled = true;
    };
  };
}

// ── Combinators ─────────────────────────────────────────────────────

/** First-completion race. Spawn each child; the first to finish wakes
 *  the parent, the rest are cancelled (via the returned disposer's
 *  cascade). Children may be any `Yieldable` — generators, awaitables,
 *  numbers (sleep), arrays (parallel), `undefined` (one frame). Mixed
 *  freely:
 *
 *      yield race(orbit(centre, shapes), 5, onceEvent(btn, "click"));
 *
 *  resumes on whichever happens first — the orbit completing, 5 seconds
 *  elapsing, or the button being clicked.
 *
 *  Sync-resolve safe: a child that completes during the spawn loop
 *  defers the wake until all siblings are spawned, so the cancel sweep
 *  reaches every loser regardless of completion order. */
export function race(...children: Yieldable[]): Awaitable {
  return (wake, spawn) => {
    let won = false;
    let setupDone = false;
    let pending = false;
    const safeWake = (): void => {
      if (won) return;
      won = true;
      if (setupDone) wake();
      else pending = true;
    };
    const disposers: (() => void)[] = [];
    for (const c of children) {
      if (typeof c === "function" && !isGen(c)) {
        // Bare Awaitable — subscribe directly, sharing our spawn so
        // nested combinators (race-of-races) work without rewrapping.
        disposers.push((c as Awaitable)(safeWake, spawn));
      } else {
        // Animator | number | undefined | Yieldable[] — `asGen` lifts
        // non-generators; generators pass through untouched.
        disposers.push(spawn(asGen(c), safeWake));
      }
    }
    setupDone = true;
    if (pending) wake();
    return () => {
      for (const d of disposers) d();
    };
  };
}

/** Run `work` until `trigger` fires. Sugar over `race(work, trigger)` —
 *  same mechanism, named for the cancel-on-trigger intent. The next
 *  statement after `yield until(...)` is your exit:
 *
 *      yield until(untilChange(stop), orbit(centre, [s]));
 *      yield* zoomOut(s, 0.4);
 *
 *  Both arguments accept any `Yieldable`, so `until(5, work)` ("run for
 *  at most 5 seconds") and `until(untilChange(sig), work)` are both
 *  natural. */
export function until(trigger: Yieldable, work: Yieldable): Awaitable {
  return race(work, trigger);
}
