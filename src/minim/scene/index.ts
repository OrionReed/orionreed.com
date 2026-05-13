// Scene graph: `Shape` + spatial primitives (Point, Box) + matrix
// math + the `Mount` callable. `../shapes/` is built on this.

export {
  Vec,
  pt,
  polar,
  isPoint,
  vecEquals,
  type V,
  type Point,
  type DerivedPoint,
  type Pointlike,
  type ResolveVec,
} from "../signals/vec";

export {
  centroid,
  meanRotation,
  meanScale,
} from "./aggregates";
export { mean } from "../signals/aggregates";

// `Box` re-export carries BOTH the value (the struct) and the type
// alias (the `{x, y, w, h}` shape) — same name, two namespaces, like
// a class.
export {
  Box,
  expandBox,
  unionBox,
  boxEdgeFrom,
  isBox,
  type Boxlike,
} from "../signals/box";

export {
  Shape,
  SVG_NS,
  type ShapeOpts,
  type AnyShape,
  type AnimatableKey,
  type Writable,
  type Segment,
  boxInRoot,
  boxIn,
} from "./shape";

export { draggable, hoverSignal } from "./interaction";

export { mount, type Mount } from "./mount";
