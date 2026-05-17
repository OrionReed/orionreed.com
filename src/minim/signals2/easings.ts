// easings.ts — easing curves: pure (t: number) => number functions.

export type Easing = (t: number) => number;

export const linear: Easing  = (t) => t;
export const easeIn: Easing  = (t) => t * t;
export const easeOut: Easing = (t) => 1 - (1 - t) * (1 - t);
export const easeInOut: Easing = (t) =>
  t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
