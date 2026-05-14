// Aggregates over N reactive cells — writable views where reads merge
// inputs and writes distribute the change.
//
// Generic over any value type with a registered struct algebra (Vec,
// Box, Color, Matrix2D, Transform, Num). When the sources carry a
// struct identity (`[STRUCT]` slot), the result wraps in that struct's
// lens flavor so the rich surface (axes, ops, getters) rides along —
// `mean(...vecs)` is a Vec, `mean(...nums)` is a Num cell.

import { lens, type Cell, type StructType } from "@minim/signals";
import { STRUCT } from "@minim/signals/struct";
import { algebraOf } from "./algebra";

/** N-to-1 lens combinator. Reads merge inputs; writes distribute. The
 *  engine behind `mean` and friends. */
function combine<T>(
  parts: readonly Cell<T>[],
  merge: (vs: readonly T[]) => T,
  distribute: (next: T, prev: readonly T[]) => readonly T[],
): Cell<T> {
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

/** Mean of N cells as a writable cell. Reads return the arithmetic
 *  mean; writes apply the delta to every input (group moves rigidly so
 *  the mean lands at the new value). Auto-wraps in the source's struct
 *  lens flavor when sources carry one. */
export function mean<T>(...sigs: Cell<T>[]): Cell<T> {
  if (sigs.length === 0) {
    throw new Error("mean: requires at least one cell");
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
