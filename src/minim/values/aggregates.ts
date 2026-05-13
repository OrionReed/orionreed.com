// Aggregates over N reactive signals — writable views where reads
// merge inputs and writes distribute the change.
//
// Generic over any value type with a registered struct algebra (Vec,
// Box, Color, Matrix2D, Transform) AND raw `Signal<number>`. When the
// sources carry a struct identity (`[STRUCT]` slot), the result wraps
// in that struct's lens flavor so the rich surface (axes, ops, getters)
// rides along — `mean(...vecs)` is a Vec, `mean(...nums)` is a number
// signal.

import { lens, type Signal } from "@minim/core";
import { algebraOf } from "./algebra";
import { STRUCT, type StructType } from "./struct";

/** N-to-1 lens combinator. Reads merge inputs; writes distribute. The
 *  engine behind `mean` and friends. */
function combine<T>(
  parts: readonly Signal<T>[],
  merge: (vs: readonly T[]) => T,
  distribute: (next: T, prev: readonly T[]) => readonly T[],
): Signal<T> {
  return lens(
    () => merge(parts.map((p) => p.value)),
    (next) => {
      const prev = parts.map((p) => p.peek());
      const updated = distribute(next, prev);
      for (let i = 0; i < parts.length; i++) {
        parts[i].value = updated[i];
      }
    },
  );
}

/** Mean of N signals as a writable signal. Reads return the arithmetic
 *  mean; writes apply the delta to every input (group moves rigidly so
 *  the mean lands at the new value). Auto-wraps in the source's struct
 *  lens flavor when sources carry one. */
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
  const struct = (sigs[0] as { [STRUCT]?: StructType<T> })[STRUCT];
  return struct
    ? struct.lens(() => inner.value, (v) => { inner.value = v; })
    : inner;
}
