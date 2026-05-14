// Capability accessors — read the symbol-keyed capability slots that
// the struct framework stamps on each per-type prototype.
//
//   algebraOf(cell) → VectorSpace<T> (add, sub, scale)
//   metricOf(cell)  → (a, b) => number   or undefined
//
// Used by behaviors (`spring`/`oscillate`/`drift`/`attract`) and
// aggregates (`mean`). No scalar-number fallback — pass a struct
// cell (e.g. `num(0)`, `Vec.signal({x,y})`) or anything with the
// capability registered.

import { ALGEBRA, METRIC } from "@minim/signals/struct";
import type { Cell, ReadonlyCell } from "@minim/signals";

/** Re-export `VectorSpace<T>` — the algebra contract. Defined in
 *  `@minim/signals/struct` for the capability slot; aliased here for
 *  the `values/` consumers. */
export type { VectorSpace } from "@minim/signals/struct";
import type { VectorSpace } from "@minim/signals/struct";

/** Resolve the algebra for a cell via the `[ALGEBRA]` slot. Throws
 *  if the cell isn't a struct cell with algebra registered. */
export function algebraOf<T>(sig: Cell<T> | ReadonlyCell<T>): VectorSpace<T> {
  const a = (sig as any)[ALGEBRA] as VectorSpace<T> | undefined;
  if (!a) {
    throw new Error(
      "algebraOf: cell has no [ALGEBRA] slot. Use a struct cell with " +
        "an algebra registered (e.g. `num(0)`, `Vec.signal({x,y})`) " +
        "for behaviors like spring/oscillate/drift/attract.",
    );
  }
  return a;
}

/** Resolve the metric (distance function) for a cell via the
 *  `[METRIC]` slot, or `undefined` if none registered. Returning
 *  `undefined` (not throwing) lets callers — e.g. spring's precision-
 *  stop — degrade gracefully: with no metric, the behavior runs
 *  without auto-settle. */
export function metricOf<T>(
  sig: Cell<T> | ReadonlyCell<T>,
): ((a: T, b: T) => number) | undefined {
  return (sig as any)[METRIC] as ((a: T, b: T) => number) | undefined;
}
