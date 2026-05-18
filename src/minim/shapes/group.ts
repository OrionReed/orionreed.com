import { Shape, type ShapeOpts } from "./shape";

/** Empty container — bundles children under one transform / opacity. */
export const group = <const O extends ShapeOpts>(opts?: O): Shape<O> =>
  new Shape<O>(undefined, undefined, opts);

// TODO: might want to allow children directly here, might clean up some stuff, jsx-like
