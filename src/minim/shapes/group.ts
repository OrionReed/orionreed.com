import { Shape, type ShapeOpts } from "../shape";

/** Empty container — bundles children for transform/opacity inheritance.
 *  Generic in `O` so a passed-in `computed(...)` for, say, `translate`
 *  produces a `ReadonlySignal` field on the returned shape (animations
 *  on it become a TypeScript error rather than a runtime throw). */
export const group = <const O extends ShapeOpts>(opts?: O): Shape<O> =>
  new Shape<O>(undefined, undefined, opts);
