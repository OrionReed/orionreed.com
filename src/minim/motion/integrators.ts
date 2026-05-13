// Frame-driven integrators — generators that step `dt` into one or
// more signals. The single-signal integrators (spring, oscillate,
// drift, attract) live in `signals/integrators` and are generic over
// any value type whose registered struct exposes a vector-space
// algebra (add + sub + scale) — works for `Signal<number>`,
// `Reactive<Vec>`, `Reactive<Color>`, etc. uniformly.
//
// `orbit` lives here because it operates on a *list of shapes* and
// reads `center` as a Pointlike — not a single-signal integrator,
// so it doesn't fit the generic shape.

import type { Animator, Arg, V } from "../core";
import { drive, toSig } from "../core";
import type { Pointlike, Writable } from "../scene";

export {
  spring,
  oscillate,
  drift,
  attract,
  type SpringOpts,
  type VectorSpace,
} from "../signals/integrators";

// ── Multi-shape integrator ──────────────────────────────────────────

/** Continuous orbit around `center`, one revolution per `period`
 *  seconds. Picks up each shape's current radius/angle (no jump). Never
 *  returns. `rate` (default 1) is a reactive multiplier — tween it for
 *  ease-in/out; negatives reverse; 0 pauses. */
export function orbit(
  center: Pointlike,
  shapes: readonly Writable<"translate">[],
  opts: { period?: number; rate?: Arg<number> } = {},
): Animator {
  const period = opts.period ?? 4;
  const rate = toSig(opts.rate ?? 1);
  const omega = (2 * Math.PI) / period;
  const N = shapes.length;
  const c0 = center.value;
  const init = shapes.map((sh) => {
    const v = sh.translate.peek();
    const dx = v.x - c0.x;
    const dy = v.y - c0.y;
    return { angle: Math.atan2(dy, dx), radius: Math.hypot(dx, dy) };
  });
  // Own `t`, not drive's: needs reactive-rate scaling per step.
  let t = 0;
  return drive((dt) => {
    t += dt * rate.value;
    const c = center.value;
    for (let i = 0; i < N; i++) {
      const angle = init[i].angle + omega * t;
      const point: V = {
        x: c.x + init[i].radius * Math.cos(angle),
        y: c.y + init[i].radius * Math.sin(angle),
      };
      shapes[i].translate.value = point;
    }
  });
}
