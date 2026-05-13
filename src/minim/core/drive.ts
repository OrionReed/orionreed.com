// The frame-loop substrate: `drive(step)` runs `step(dt, t)` once per
// frame. Foundation under behaviors, clocks, and bounded transitions —
// every "yield dt; update signal" pattern in this stdlib reduces to a
// `drive` call. Return `false` to stop naturally; any other return
// (including `void`) keeps driving. Cancellation from outside still
// unwinds the surrounding generator.
//
//   yield* drive((dt) => { sig.value += vel * dt; });                  // drift
//   yield* drive((_, t) => { sig.value = base + A * Math.sin(2*PI*F*t); }); // oscillate
//   yield* drive((_, t) => {                                           // tween
//     if (t >= dur) { sig.value = target; return false; }
//     sig.value = lerp(start, target, ease(t / dur));
//   });

import type { Animator } from "./anim";

/** Yield once per frame, calling `step(dt, t)` each time. `dt` is the
 *  frame delta in seconds; `t` is total elapsed since drive started.
 *  Return `false` to complete; any other return value (including
 *  `void`) keeps driving until cancelled. */
export function* drive(
  step: (dt: number, t: number) => boolean | void,
): Animator {
  let t = 0;
  while (true) {
    const dt = yield;
    t += dt;
    if (step(dt, t) === false) return;
  }
}
