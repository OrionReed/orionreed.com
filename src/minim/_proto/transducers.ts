// Time-direction transducers — `onTick` only. Compose by stacking;
// descendants inherit automatically via the engine spawn chain.

import {
  transduce,
  type Animator,
  type Transduced,
} from "./anim";

/** Run `target` with `rate()` as its time-scale. `rate() === 0` freezes
 *  the subtree (no localClock advance, no wake). */
export function scaled<R>(
  rate: () => number,
  target: Animator<R> | Transduced<R>,
): Transduced<R> {
  return transduce({ onTick: (dt) => dt * rate() }, target);
}

/** Pause the subtree while `pred()` is true. Equivalent to scaled(0|1). */
export function pauseWhen<R>(
  pred: () => boolean,
  target: Animator<R> | Transduced<R>,
): Transduced<R> {
  return scaled(() => (pred() ? 0 : 1), target);
}

/** Run the subtree at `fraction` speed while `pred()` is true; full speed otherwise. */
export function slowmoWhen<R>(
  pred: () => boolean,
  fraction: number,
  target: Animator<R> | Transduced<R>,
): Transduced<R> {
  return scaled(() => (pred() ? fraction : 1), target);
}
