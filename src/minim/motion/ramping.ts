// Clock warpers — generators that drive a `Signal<number>` over time
// with a non-default rate. Compose with any signal-as-clock, including
// `Timeline.clock` or a free-standing `signal(0)`.
//
// All three take a clock signal directly so they're independent of the
// Timeline class — useful for warping any time-driven signal.

import { computed, type Signal } from "../core";
import { toSig, type Arg } from "../core";
import type { Animator } from "../core";
import type { Easing } from "../core";

/** Advance `clock` from its current value to `total`, modulating the
 *  rate by `ease(progress)` where `progress = clock / total`. With
 *  `easeInOut` you get slow-start/fast-middle/slow-end playback; with
 *  `easeIn` you get a slow start; etc. The rate at any instant is the
 *  easing's *value*, not a derivative — pass curves whose endpoints
 *  are 0 (e.g. `easeInOut`) for smooth ramping. */
export function ramp(
  clock: Signal<number>,
  total: Arg<number>,
  ease: Easing,
): Animator {
  const totalSig = toSig(total);
  return (function* () {
    while (clock.value < totalSig.value) {
      const dt: number = yield;
      const t = totalSig.value > 0 ? clock.value / totalSig.value : 1;
      clock.value += dt * ease(t);
    }
  })();
}

/** Drive `clock` backwards from its current value to 0. Useful for
 *  reverse-playback timelines. Symmetric with `ramp` — pass an easing
 *  for non-linear reverse rate. */
export function reverse(
  clock: Signal<number>,
  ease?: Easing,
): Animator {
  return (function* () {
    while (clock.value > 0) {
      const dt: number = yield;
      const rate = ease ? ease(1 - clock.value / Math.max(clock.value, 1)) : 1;
      clock.value = Math.max(0, clock.value - dt * rate);
    }
  })();
}

/** Advance `clock` forever, scaled by `rate`. Negative rate runs
 *  backwards. Reactive — `rate` may be a signal, so playback speed
 *  can be edited live (slider, crossfade, scrub-with-momentum). */
export function speed(
  clock: Signal<number>,
  rate: Arg<number>,
): Animator {
  const r = toSig(rate);
  return (function* () {
    while (true) {
      const dt: number = yield;
      clock.value += dt * r.value;
    }
  })();
}
