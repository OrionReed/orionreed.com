export const linear = (t: number) => t;
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 2);
export const easeIn = (t: number) => t * t;
export const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
