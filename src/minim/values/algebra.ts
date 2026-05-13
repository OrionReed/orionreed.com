// Vector-space algebra accessors. The struct framework stamps an
// `[ALGEBRA]` slot on each per-type prototype carrying `add`/`sub`/
// `scale`; behaviors (`spring`, `oscillate`, …) and aggregates (`mean`)
// read it to find the right ops for the value type. Raw `Signal<number>`
// falls back to scalar arithmetic.

import type { Signal } from "@minim/core";
import { ALGEBRA } from "./struct";

/** The minimal vector-space algebra: enough for tween, spring,
 *  oscillate, drift, attract, mean, sum, lerp, etc. */
export interface VectorSpace<T> {
  add: (a: T, b: T) => T;
  sub: (a: T, b: T) => T;
  scale: (a: T, k: number) => T;
}

/** Scalar (number) algebra — the default when no struct algebra is
 *  registered on the signal's prototype. */
const NumberVS: VectorSpace<number> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  scale: (a, k) => a * k,
};

/** Resolve the algebra for a signal: prefer the struct-installed one
 *  (via the hidden `[ALGEBRA]` prototype slot), fall back to scalar. */
export function algebraOf<T>(sig: Signal<T>): VectorSpace<T> {
  const a = (sig as any)[ALGEBRA] as VectorSpace<T> | undefined;
  return a ?? (NumberVS as unknown as VectorSpace<T>);
}
