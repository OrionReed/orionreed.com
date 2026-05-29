// merge.ts — companion to ../../backwards-merge.md.
//
// The merge primitive itself lives on `Signal.prototype.merge` in
// `./signal.ts`, alongside `.lens()`. This module is the policy
// library + test helpers.
//
// User-facing API:
//
//   sig.merge(policy)        // Signal.prototype.merge, chain-position
//                            //   merge node, returns NEW cell
//
//   MergePolicy<T>            // re-exported from signal.ts; the engine
//                            //   ships the type so the prototype method
//                            //   can declare it.
//
// Common policies live here. So do `peekMergeSlots` / `peekMergeAcc`
// for tests.

import type { MergePolicy, Signal } from "./signal";

export type { MergePolicy } from "./signal";
export { DIRECT_SLOT } from "./signal";

// ─── Common policies ────────────────────────────────────────────────

/** Lattice join via `Math.max`. Identity = -∞. Idempotent. */
export const maxPolicy: MergePolicy<number> = {
  identity: Number.NEGATIVE_INFINITY,
  combine: (a, b) => (a > b ? a : b),
};

/** Lattice meet via `Math.min`. Identity = +∞. Idempotent. */
export const minPolicy: MergePolicy<number> = {
  identity: Number.POSITIVE_INFINITY,
  combine: (a, b) => (a < b ? a : b),
};

/** Additive monoid. Identity = 0. Non-idempotent: per-slot dedupe
 *  prevents same-source repeats from accumulating, but cross-slot
 *  arrival order doesn't change the sum (commutative).
 *
 *  Invertible (`remove` = subtraction) ⇒ engine uses the O(1)
 *  incremental fold per arrival, O(k) per cascade. */
export const sumPolicy: MergePolicy<number> = {
  identity: 0,
  combine: (a, b) => a + b,
  remove: (a, b) => a - b,
};

/** Multiplicative monoid. Identity = 1. Invertible via division —
 *  caller is responsible for never folding a `0` contribution if
 *  they intend to use the incremental path (division by zero
 *  poisons the accumulator). */
export const productPolicy: MergePolicy<number> = {
  identity: 1,
  combine: (a, b) => a * b,
  remove: (a, b) => a / b,
};

/** Object-spread merge: each contribution is an object, fold = right-
 *  to-left spread. Useful for partial-field updates where multiple
 *  upstream lenses each touch different keys. Identity = the empty
 *  object (`{}` — caller can pass a more specific identity if desired). */
export function spreadPolicy<T extends object>(identity: T = {} as T): MergePolicy<T> {
  return {
    identity,
    combine: (a, b) => ({ ...a, ...b }),
  };
}

// ─── Test helpers (internal state introspection) ────────────────────

interface MergeNodeShape<T> {
  policy: MergePolicy<T>;
  slots: Map<unknown, T>;
  hasIncrementalAcc: boolean;
  acc: T;
}

/** Snapshot the current slot map for a merge cell. Returns
 *  `undefined` if the cell wasn't built by `.merge()`. */
export function peekMergeSlots<T>(cell: Signal<T>): ReadonlyMap<unknown, T> | undefined {
  return (cell as Signal<T> & { _mergeNode?: MergeNodeShape<T> })._mergeNode?.slots;
}

/** Snapshot the most-recently-committed folded value. Returns
 *  `undefined` if the cell wasn't built by `.merge()` or no
 *  arrival has happened yet.
 *
 *  Incremental-fold policies store `acc` directly; lattice
 *  policies don't have an authoritative `acc` (each arrival
 *  re-folds) so we compute it on demand from the slot map. */
export function peekMergeAcc<T>(cell: Signal<T>): T | undefined {
  const node = (cell as Signal<T> & { _mergeNode?: MergeNodeShape<T> })._mergeNode;
  if (node === undefined) return undefined;
  if (node.hasIncrementalAcc) return node.acc;
  let acc: T = node.policy.identity;
  for (const v of node.slots.values()) acc = node.policy.combine(acc, v);
  return acc;
}
