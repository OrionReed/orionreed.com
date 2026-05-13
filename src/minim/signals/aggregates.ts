// Aggregates over N reactive signals — writable views where reads
// merge inputs and writes distribute the change.
//
// Generic over any value type with a registered struct algebra (Vec,
// Box, Color, Matrix2D, Transform) AND raw `Signal<number>`. When the
// sources carry a struct identity (`[STRUCT]` slot), the result wraps
// in that struct's lens flavor so the rich surface (axes, ops, getters)
// rides along — `mean(...vecs)` is a Vec, `mean(...nums)` is a plain
// number signal.

import { combine } from "./lens";
import { algebraOf } from "./algebra";
import { STRUCT, type StructType } from "./struct";
import type { Signal } from "../core/signal";

/** Mean of N signals as a writable signal. Reads return the arithmetic
 *  mean; writes apply the delta to every input (group moves rigidly so
 *  the mean lands at the new value). Result wraps in the source's
 *  struct lens flavor when present. */
export function mean<T>(...sigs: Signal<T>[]): Signal<T> {
  if (sigs.length === 0) {
    throw new Error("mean: requires at least one signal");
  }
  const { add, sub, scale } = algebraOf(sigs[0]);
  const inner = combine<T>(
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
  // If sources carry a struct identity, wrap so the rich surface rides along.
  const struct = (sigs[0] as { [STRUCT]?: StructType<T> })[STRUCT];
  return struct
    ? struct.lens(() => inner.value, (v) => { inner.value = v; })
    : inner;
}
