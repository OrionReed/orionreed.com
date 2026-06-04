// drivers.ts — animation drivers for `Constraints.step(dt)`.
//
// Generators that wrap `c.step(dt)` with different rhythms. Driven by
// any `Tick`-yielding animation loop (`anim.start(...)`). Custom
// drivers (scrubbing, pause/resume) just yield then call `c.step`.

import type { Tick } from "../core/anim";
import type { Constraints } from "./cluster";

/** Real-time driver: advance by the actual frame `dt`. Mainly for
 *  cloth / particle physics (reactive scenes self-fire). */
export function* animate(c: Constraints): Generator<undefined, never, Tick> {
  for (;;) {
    const tick: Tick = yield;
    c.step(tick.dt);
  }
}

/** Fixed-`dt` sub-stepping: accumulate frame time and fire as many
 *  fixed steps as fit (capped at `maxSubSteps` against the
 *  spiral-of-death). Fixed `dt` avoids the jitter variable `dt`
 *  causes in warm-start / extrapolation / velocity. Defaults
 *  (1/60s, 4) match the AVBD demo. */
export function* fixedStep(
  c: Constraints,
  fixedDt: number,
  maxSubSteps: number = 4,
): Generator<undefined, never, Tick> {
  let acc = 0;
  for (;;) {
    const tick: Tick = yield;
    acc += Math.min(tick.dt, fixedDt * maxSubSteps);
    let n = 0;
    while (acc >= fixedDt && n < maxSubSteps) {
      c.step(fixedDt);
      acc -= fixedDt;
      n++;
    }
  }
}

/** Time-dilated driver: scale the wall-clock dt by `factor()` each
 *  frame. `factor` is a thunk so callers can flip it live (slow-mo
 *  toggles, pause via `factor: () => 0`, scrubbing, etc.). */
export function* dilated(c: Constraints, factor: () => number): Generator<undefined, never, Tick> {
  for (;;) {
    const tick: Tick = yield;
    c.step(tick.dt * factor());
  }
}
