// Scene graph: `Shape` + spatial primitives (Point, Box) + matrix
// math + the `Mount` callable. `../shapes/` is built on this.

export {
  Vec,
  vec,
  polar,
  isPoint,
  vecEquals,
  mean,
  // `Box` re-export carries BOTH the value (the struct) and the type
  // alias (the `{x, y, w, h}` shape) — same name, two namespaces, like
  // a class.
  Box,
  expandBox,
  unionBox,
  boxEdgeFrom,
  isBox,
  type V,
  type Point,
  type DerivedPoint,
  type Pointlike,
  type ResolveVec,
  type Boxlike,
} from "@minim/values";

export {
  Shape,
  SVG_NS,
  centroid,
  meanRotation,
  meanScale,
  type ShapeOpts,
  type AnyShape,
  type AnimatableKey,
  type Writable,
  type Segment,
} from "./shape";

export { draggable, hoverSignal } from "./interaction";

export { mount, type Mount } from "./mount";
