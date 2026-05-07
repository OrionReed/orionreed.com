import { Shape, type ShapeOpts } from "../scene";

/** Empty container — bundles children under one transform / opacity. */
export const group = <const O extends ShapeOpts>(opts?: O): Shape<O> =>
  new Shape<O>(undefined, undefined, opts);
