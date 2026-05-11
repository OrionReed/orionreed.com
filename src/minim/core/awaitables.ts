// Awaitable adapters and combinators. Every awaitable is
// `(wake, spawn?) => dispose`; `spawn` is for combinators that
// orchestrate generators (`race`, `until`). Sync-resolve (calling
// `wake` before returning) is fine.

import { asGen, isGen, type Awaitable, type Yieldable } from "./anim";
import { effect, type ReadonlySignal } from "./signal";

// ── Adapters ────────────────────────────────────────────────────────

/** Wake on the next change of `sig` (the baseline read is ignored). */
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

/** Wake when `sig` is truthy. Wakes immediately if already truthy. For
 *  "becomes falsy," pass `sig.derive(v => !v)`. */
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

/** Wake on one DOM event; auto-removes the listener on fire or cancel. */
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

/** Wake when `p` settles. Cancel suppresses `wake` (the promise itself
 *  can't be cancelled). */
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

/** First-completion race. Children may be any `Yieldable` (generator,
 *  awaitable, number sleep, array parallel, `undefined` one frame).
 *  First to finish wakes the parent; the rest are cancelled. */
export function race(...children: Yieldable[]): Awaitable {
  return (wake, spawn) => {
    let won = false;
    let setupDone = false;
    let pending = false;
    // A sync-completing child during the spawn loop defers its wake
    // until all siblings are spawned, so cancel still reaches losers.
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

/** Run `work` until `trigger` fires (cancel-on-trigger). Sugar over
 *  `race(work, trigger)`. The next `yield*` after `yield until(...)`
 *  is the graceful-exit sequel. */
export function until(trigger: Yieldable, work: Yieldable): Awaitable {
  return race(work, trigger);
}
