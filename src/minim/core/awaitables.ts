// Awaitable adapters — bridges from external sources to the
// `yield <Awaitable>` slot consumed by `Anim`. Every adapter has the
// same shape: subscribe + return a disposer. Sync-resolve is allowed
// (calling `wake()` before returning is fine — Anim handles it).
//
// All five-line wrappers; pick whichever matches your source.

import type { Awaitable } from "./anim";
import { effect, type ReadonlySignal } from "./signal";

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

/** Wake on one DOM event (or any `EventTarget`). Listener auto-removes
 *  after firing; the disposer also removes it (cancel before fire). */
export function onceEvent(
  target: EventTarget,
  name: string,
  opts?: AddEventListenerOptions,
): Awaitable {
  return (wake) => {
    const handler = () => wake();
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
