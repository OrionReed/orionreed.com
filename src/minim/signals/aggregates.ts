// Aggregates over N reactive signals — writable views where reads
// merge inputs and writes distribute the change. Built on `combine`
// from the lens module.
//
// `mean<T>` is generic over any value type `T` whose registered
// struct exposes a vector-space algebra (add / sub / scale via the
// `[ALGEBRA]` prototype slot). That gives you `mean(...vecSigs)`,
// `mean(...numSigs)`, `mean(...colorSigs)`, `mean(...boxSigs)`,
// `mean(...matrixSigs)` — all from one definition.
//
// `meanVec` and `meanNum` remain as named aliases for back-compat
// and discoverability; both are now one-line specializations.

import { combine } from "./lens";
import { algebraOf } from "./algebra";
import { Vec, type V } from "./vec";
import type { Signal } from "../core/signal";

/** Mean of N writable signals as a writable signal. Reads return the
 *  arithmetic mean; writes apply the delta to every input — moving
 *  the group rigidly so the mean lands at the new value.
 *
 *  Generic over the value type's algebra: works for any registered
 *  struct that declares `add` / `sub` / `scale` (Vec, Box, Color,
 *  Matrix2D, Transform, …) AND for raw `Signal<number>`. Falls back
 *  to scalar arithmetic when no struct algebra is registered. */
export function mean<T>(...sigs: Signal<T>[]): Signal<T> {
  if (sigs.length === 0) {
    throw new Error("mean: requires at least one signal");
  }
  const { add, sub, scale } = algebraOf(sigs[0]);
  return combine<T>(
    sigs,
    (vs) => {
      let acc = vs[0];
      for (let i = 1; i < vs.length; i++) acc = add(acc, vs[i]);
      return scale(acc, 1 / vs.length);
    },
    (next, prev) => {
      let acc = prev[0];
      for (let i = 1; i < prev.length; i++) acc = add(acc, prev[i]);
      const cur = scale(acc, 1 / prev.length);
      const delta = sub(next, cur);
      return prev.map((v) => add(v, delta));
    },
  );
}

/** Mean of N writable Vec signals as a writable `Reactive<V>` (Vec
 *  surface — `.x`, `.y`, `.add`, `.scale`, …). Sugar over `mean`
 *  with the result wrapped to expose the Vec methods. */
export function meanVec(...sigs: Signal<V>[]) {
  const m = mean(...sigs);
  return Vec.lens(
    () => m.value,
    (v) => {
      m.value = v;
    },
  );
}

/** Mean of N writable scalar signals. Alias for `mean(...sigs)`. */
export function meanNum(...sigs: Signal<number>[]): Signal<number> {
  return mean(...sigs);
}
