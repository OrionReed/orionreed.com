import { type AnyShape, Shape, type ShapeOpts } from "./shape";

/** Empty container — bundles children under one transform / opacity.
 *  Pass children after `opts` for JSX-ish nesting:
 *  `group({ translate }, rect(...), label(...))`. */
export function group<const O extends ShapeOpts>(opts?: O, ...children: AnyShape[]): Shape<O> {
  const g = new Shape<O>(undefined, undefined, opts);
  if (children.length > 0) g.add(...children);
  return g;
}
