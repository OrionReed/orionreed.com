// Predicate factory functions. Each returns a `Read<boolean>` derived
// from one or more reactive sources — they're plain `computed()` calls
// with no special types, so users can compose them with `and` / `or` /
// `not` / hand-rolled `computed()` interchangeably.

import { computed, type Read, type Of } from "@minim/signals";
import type { Box, Vec } from "@minim/signals";

type VecValue = Of<Vec>;

/** `lo ≤ s ≤ hi`. */
export function inRange(
  s: Read<number>,
  range: readonly [number, number],
): Read<boolean> {
  const [lo, hi] = range;
  return computed(() => {
    const v = s.value;
    return v >= lo && v <= hi;
  });
}

/** `s === v` (strict). */
export function equal<T>(s: Read<T>, v: T): Read<boolean> {
  return computed(() => s.value === v);
}

/** `s > n`. */
export function above(s: Read<number>, n: number): Read<boolean> {
  return computed(() => s.value > n);
}

/** `s < n`. */
export function below(s: Read<number>, n: number): Read<boolean> {
  return computed(() => s.value < n);
}

/** `|s - n| ≤ tol`. */
export function near(
  s: Read<number>,
  n: number,
  tol = 1e-6,
): Read<boolean> {
  return computed(() => Math.abs(s.value - n) <= tol);
}

/** Point lies inside a Box (signal or shape's `.box`). */
export function inside(
  s: Read<VecValue>,
  region: Box,
): Read<boolean> {
  return computed(() => {
    const v = s.value;
    const b = region.value;
    return v.x >= b.x && v.x <= b.x + b.w && v.y >= b.y && v.y <= b.y + b.h;
  });
}

/** `|a - b| ≤ tol`. */
export function following(
  a: Read<number>,
  b: Read<number>,
  tol = 1e-9,
): Read<boolean> {
  return computed(() => Math.abs(a.value - b.value) <= tol);
}

/** Pointwise equality with another signal. */
export function isEqual<T>(a: Read<T>, b: Read<T>): Read<boolean> {
  return computed(() => a.value === b.value);
}
