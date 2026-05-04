// Easing functions: pure `t in [0..1] → t' in [0..1]`. Used by the
// animation primitives in `anims.ts` to shape interpolation curves.

export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 2);
}

export function easeIn(t: number): number {
  return t * t;
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Linear (no easing). */
export function linear(t: number): number {
  return t;
}
