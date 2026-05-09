// Composers for `Animator` generators.

import type { Animator } from "../core";

/** Run in parallel; complete when all finish. */
export function* all(...children: Animator[]): Animator {
  yield children;
}

/** Run sequentially. */
export function* sequence(...children: Animator[]): Animator {
  for (const c of children) yield* c;
}

/** Pause `sec` seconds, then run `c`. */
export function* delay(sec: number, c: Animator): Animator {
  if (sec > 0) yield sec;
  yield* c;
}

/** Pause until `condition()` is true (polled per frame). For waits on a
 *  specific event, signal change, or other subscribable source, prefer a
 *  zero-latency `Awaitable` (e.g. `bus.until(name)`, `untilChange(sig)`,
 *  `fromPromise(p)`). */
export function* until(condition: () => boolean): Animator {
  while (!condition()) yield;
}
