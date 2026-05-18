export { Num, num, type Value as NumValue } from "./num";
export { Vec, vec, polar, type Value as VecValue } from "./vec";
export { Color, rgb, rgba, type Value as ColorValue } from "./color";
export { Box, box, type Value as BoxValue } from "./box";
export {
  Transform, transform,
  type Value as TransformValue,
  type Init as TransformInit,
} from "./transform";
export {
  Matrix, matrix,
  identity, fromTranslate, fromScale, fromRotate,
  isIdentity, multiply, invert, determinant,
  transformPoint, transformBox, compose,
  toString as matrixToString,
  type Value as MatrixValue,
} from "./matrix";
export { Anchor, Dir } from "./anchor";

import { Signal, type Read } from "../signal";
import { requireLinear } from "../traits";
import { derived } from "../derive";

/** N-to-1 lens flavored as `parts[0]`'s class. */
export function combine<T, S extends Read<T>>(
  parts: readonly S[],
  merge: (vs: readonly T[]) => T,
  distribute: (next: T, prev: readonly T[]) => readonly T[],
): S {
  if (parts.length === 0) throw new Error("combine: need ≥1 signal");
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

/** Writable arithmetic mean; writes distribute the delta. Needs `[LINEAR]`. */
export function mean<T, S extends Read<T>>(...signals: S[]): S {
  if (signals.length === 0) throw new Error("mean: need ≥1 signal");
  const lin = requireLinear(signals[0]);
  const invN = 1 / signals.length;
  return combine<T, S>(
    signals,
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
