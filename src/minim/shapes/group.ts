import { Shape, type ShapeOpts } from "../shape";

/** Empty container — bundles children for transform/opacity inheritance. */
export const group = (opts?: ShapeOpts): Shape =>
  new Shape(undefined, undefined, opts);
