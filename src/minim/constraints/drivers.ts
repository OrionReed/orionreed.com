// drivers.ts — animation drivers for `Constraints.step(dt)`.
//
// Three free generators that wrap `c.step(dt)` with different
// rhythms. They're plain `function*` generators, so any animation
// loop that yields `Tick` objects (`anim.start(...)`) can drive
// them.
//
// All three are <30 lines. Custom drivers (replay scrubbing,
// pause/resume, externally-clocked) are easy to write — just
// yield, then call `c.step(dt)` with whatever `dt` makes sense.

import type { Tick } from "../core/anim";
import type { Constraints } from "./cluster";

/** Real-time driver: each frame, advance by the actual frame `dt`.
 *  Suitable for sketchpad / IK / layout scenes that just want to
 *  re-solve in step with the animation clock — though for those
 *  the reactive driver fires automatically and you usually don't
 *  need this at all. Most useful for cloth / particle physics. */
export function* animate(c: Constraints): Generator<undefined, never, Tick> {
  for (;;) {
    const tick: Tick = yield;
    c.step(tick.dt);
  }
}

/** Fixed-`dt` sub-stepping. Real frame time accumulates and the
 *  pipeline fires as many fixed-`dt` steps as fit per frame
 *  (capped at `maxSubSteps` to prevent the spiral-of-death).
 *  Production physics engines (Box2D, Bullet, Rapier) all do this
 *  because variable `dt` amplifies jitter — penalty/λ warm-start,
 *  inertial extrapolation, and velocity scale non-uniformly in dt.
 *
 *  Default config (1/60s, 4 max sub-steps) matches the AVBD demo. */
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
export function* dilated(
  c: Constraints,
  factor: () => number,
): Generator<undefined, never, Tick> {
  for (;;) {
    const tick: Tick = yield;
    c.step(tick.dt * factor());
  }
}
