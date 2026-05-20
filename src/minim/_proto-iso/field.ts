// `field()` collapses to a stock `Iso` — no engine surgery.
//
// Before: `field(parent, "x", Num)` in `signals/derive.ts:55` was a
// bespoke primitive that created a Computed-backed lens with cached
// per-(parent, key) results and a spread-replace setter.
//
// After: a record-field is just an Iso with `fwd = o → o[k]` and
// `bwd = (v, prev) → { ...prev, [k]: v }`. Composes with everything
// else in the iso world.

import type { Iso } from "./iso";

/** Lens onto `O[K]`. `prev` is required for the spread-replace setter
 *  to preserve the other fields of the record — hence `needsPrev: true`. */
export const field = <O, K extends keyof O>(key: K): Iso<O, O[K]> => ({
  fwd: (o) => o[key],
  bwd: (v, prev) => ({ ...prev, [key]: v }),
  needsPrev: true,
});
