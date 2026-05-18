// values/ — built-in value types + aggregates.
//
// Each per-type file exports its plain `Value` shape, pure math fns
// (`add`/`lerp`/`metric`/...), the reactive class, a `Chain` for
// `derive(...)`, and the factory shorthand. Traits are stamped via
// `defineTrait` from `../lerp`. Pure math can be deep-imported, e.g.:
//
//   import * as VecMath from "@minim/signals/values/vec";
//   VecMath.add(a, b);

export { Num, num, type Value as NumValue } from "./num";
export { Vec, vec, polar, type Value as VecValue } from "./vec";
export { Color, rgb, rgba, type Value as ColorValue } from "./color";
export { Box, box, type Boxed, type Value as BoxValue } from "./box";
export {
  Transform, transform,
  type Value as TransformValue,
  type Init as TransformInit,
} from "./transform";
export {
  Matrix2D, matrix,
  identity, fromTranslate, fromScale, fromRotate,
  isIdentity, multiply, invert, determinant,
  transformPoint, transformBox, compose,
  toString as matrixToString,
  type Value as Matrix2DValue,
} from "./matrix";
export { Anchor, Dir } from "./anchor";

// ════════════════════════════════════════════════════════════════════
// mean<T> — writable arithmetic mean over N reactive cells.
//
// Reads merge inputs via [LINEAR]; writes apply the delta to every
// input so the group moves rigidly to land the mean at the new value.
// Generic via [LINEAR] — works on Num, Vec, Color, Transform, …
// ════════════════════════════════════════════════════════════════════

import { Signal, type Read } from "../signal";
import { requireLinear } from "../traits";
import { derived } from "../derive";

/** N-to-1 lens-flavored cell. Reads merge inputs; writes distribute.
 *  The result inherits `parts[0]`'s class so chainable methods (Vec
 *  arithmetic, Num.add, …) work all the way through.
 *
 *  The parameter type is `Read<T>` (covariant) so subclass-T cells
 *  (`Vec`, `Num`, …) flow through. Writes are routed through the
 *  concrete `Signal` instances at runtime — non-Signal `Read`s are a
 *  runtime no-op (silently skipped on distribute). */
export function combine<T, S extends Read<T>>(
  parts: readonly S[],
  merge: (vs: readonly T[]) => T,
  distribute: (next: T, prev: readonly T[]) => readonly T[],
): S {
  if (parts.length === 0) throw new Error("combine: need ≥1 cell");
  const Cls = (parts[0] as object).constructor as new (...args: never[]) => Signal<T>;
  return derived(Cls,
    () => {
      const vs = new Array<T>(parts.length);
      for (let i = 0; i < parts.length; i++) vs[i] = parts[i].value;
      return merge(vs);
    },
    (next) => {
      const prev = new Array<T>(parts.length);
      for (let i = 0; i < parts.length; i++) prev[i] = parts[i].peek();
      const updated = distribute(next, prev);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p instanceof Signal) (p as Signal<T>).value = updated[i];
      }
    },
  ) as unknown as S;
}

/** Reactive arithmetic mean. Reads return the mean; writes apply the
 *  delta to every input so the group moves rigidly to land the mean at
 *  the new value. Requires `[LINEAR]` on the first cell; the result is
 *  flavored as the same class. */
export function mean<T, S extends Read<T>>(...cells: S[]): S {
  if (cells.length === 0) throw new Error("mean: need ≥1 cell");
  const lin = requireLinear(cells[0]);
  const invN = 1 / cells.length;
  return combine<T, S>(
    cells,
    (vs) => {
      let acc = vs[0];
      for (let i = 1; i < vs.length; i++) acc = lin.add(acc, vs[i]);
      return lin.scale(acc, invN);
    },
    (next, prev) => {
      let acc = prev[0];
      for (let i = 1; i < prev.length; i++) acc = lin.add(acc, prev[i]);
      const cur = lin.scale(acc, invN);
      const delta = lin.sub(next, cur);
      return prev.map((v) => lin.add(v, delta));
    },
  );
}
