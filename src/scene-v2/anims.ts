// Reusable Promise-returning animation helpers. Compose by awaiting
// inside the existing `anim.loop(async () => { ... })` body — no new
// runner mechanism, just async functions that fold into the script.

import { easeOut, type Anim } from "../elements/anim";
import type { Shape } from "./shape";

/**
 * Tween a shape's opacity from its current value to 1 over `ms`.
 * Works on any shape, including empty groups — children inherit
 * opacity via SVG `<g>` multiplicative blending, so a group's
 * fade-in fades all its descendants together.
 */
export function fadeIn(
  anim: Anim,
  shape: Shape,
  ms: number,
  ease: (t: number) => number = easeOut,
): Promise<void> {
  const start = shape.opacity.peek();
  return anim.tween(ms, (t) => {
    shape.opacity.value = start + (1 - start) * ease(t);
  });
}

/** Tween opacity from current to 0. */
export function fadeOut(
  anim: Anim,
  shape: Shape,
  ms: number,
  ease: (t: number) => number = easeOut,
): Promise<void> {
  const start = shape.opacity.peek();
  return anim.tween(ms, (t) => {
    shape.opacity.value = start * (1 - ease(t));
  });
}

/** Run multiple animations in parallel; resolves when all complete. */
export function parallel(...ps: Promise<void>[]): Promise<void> {
  return Promise.all(ps).then(() => {});
}
