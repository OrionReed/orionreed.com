// Vector-space algebra accessors. The struct framework stamps an
// `[ALGEBRA]` slot on each per-type prototype carrying `add`/`sub`/
// `scale`; behaviors (`spring`, `oscillate`, …) and aggregates (`mean`)
// read it to find the right ops for the value type.
//
// There is NO scalar-number fallback — pass a `Num.signal` (which has
// the algebra installed) or any other struct cell. Plain `Signal<T>`
// without an `[ALGEBRA]` slot throws.

import { ALGEBRA } from "@minim/signals/struct";
import type { Signal } from "@minim/signals";

/** The minimal vector-space algebra: enough for tween, spring,
 *  oscillate, drift, attract, mean, sum, lerp, etc. */
export interface VectorSpace<T> {
  add: (a: T, b: T) => T;
  sub: (a: T, b: T) => T;
  scale: (a: T, k: number) => T;
}

/** Resolve the algebra for a signal via the `[ALGEBRA]` slot.
 *  Throws if the signal isn't a struct cell with algebra registered. */
export function algebraOf<T>(sig: Signal<T>): VectorSpace<T> {
  const a = (sig as any)[ALGEBRA] as VectorSpace<T> | undefined;
  if (!a) {
    throw new Error(
      "algebraOf: signal has no [ALGEBRA] slot. Use a struct cell " +
        "(e.g. `num(0)`, `Vec.signal({x,y})`) for behaviors like " +
        "spring/oscillate/drift/attract.",
    );
  }
  return a;
}
