// Animation generators. Each yields a TweenDesc (or sub-anim); the
// runner on Anim drives them. `yield*` to delegate, `yield <number>`
// for a pause, `yield [...]` for parallel.
//
//   yield* tween(lineT, 1, 1100, easeOut);
//   yield 240;                            // pause 240ms
//   yield* fadeIn(box, 600);
//   yield [fadeIn(a, 500), fadeIn(b, 500)];  // parallel

import { easeOut, type AnimGen, type TweenDesc } from "./anim";
import type { Signal } from "./signal";
import type { Shape } from "./shape";

/**
 * Tween a numeric signal from its current value to `target` over `ms`.
 * The start value is captured at iteration time, not construction.
 */
export function* tween(
  sig: Signal<number>,
  target: number,
  ms: number,
  ease?: (t: number) => number,
): AnimGen {
  const start = sig.peek();
  const desc: TweenDesc = {
    ms,
    ease,
    step: (t) => {
      sig.value = start + (target - start) * t;
    },
  };
  yield desc;
}

/** Fade `shape.opacity` from current to 1 over `ms`. */
export function* fadeIn(
  shape: Shape,
  ms: number,
  ease: (t: number) => number = easeOut,
): AnimGen {
  const start = shape.opacity.peek();
  const desc: TweenDesc = {
    ms,
    ease,
    step: (t) => {
      shape.opacity.value = start + (1 - start) * t;
    },
  };
  yield desc;
}

/** Fade `shape.opacity` from current to 0 over `ms`. */
export function* fadeOut(
  shape: Shape,
  ms: number,
  ease: (t: number) => number = easeOut,
): AnimGen {
  const start = shape.opacity.peek();
  const desc: TweenDesc = {
    ms,
    ease,
    step: (t) => {
      shape.opacity.value = start * (1 - t);
    },
  };
  yield desc;
}
