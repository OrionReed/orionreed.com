// Predicate factories. Each returns a plain `derive()`d `Read<boolean>`,
// composable with `and` / `or` / `not` / hand-rolled `derive()`.

import type { Box, Vec } from "@minim/signals";
import { derive, type Inner, type Read } from "@minim/signals";

/** `lo ≤ s ≤ hi`. */
export function inRange(s: Read<number>, range: readonly [number, number]): Read<boolean> {
  const [lo, hi] = range;
  return derive(() => {
    const v = s.value;
    return v >= lo && v <= hi;
  });
}

/** `s === v` (strict). */
export function equal<T>(s: Read<T>, v: T): Read<boolean> {
  return derive(() => s.value === v);
}

/** `s > n`. */
export function above(s: Read<number>, n: number): Read<boolean> {
  return derive(() => s.value > n);
}

/** `s < n`. */
export function below(s: Read<number>, n: number): Read<boolean> {
  return derive(() => s.value < n);
}

/** `|s - n| ≤ tol`. */
export function near(s: Read<number>, n: number, tol = 1e-6): Read<boolean> {
  return derive(() => Math.abs(s.value - n) <= tol);
}

/** Point lies inside a Box (signal or shape's `.box`). */
export function inside(s: Read<Inner<Vec>>, region: Box): Read<boolean> {
  return derive(() => {
    const v = s.value;
    const b = region.value;
    return v.x >= b.x && v.x <= b.x + b.w && v.y >= b.y && v.y <= b.y + b.h;
  });
}

/** `|a - b| ≤ tol`. */
export function following(a: Read<number>, b: Read<number>, tol = 1e-9): Read<boolean> {
  return derive(() => Math.abs(a.value - b.value) <= tol);
}

/** Pointwise equality with another signal. */
export function isEqual<T>(a: Read<T>, b: Read<T>): Read<boolean> {
  return derive(() => a.value === b.value);
}
