// Scene graph: the shape primitive + spatial primitives (Point, Bounds,
// AABB) + matrix math + the Scene callable. Layer C — depends on
// layer-A (Anim, only via the `Animator` type for `until`/`onSignal`)
// and layer-B (signals + utilities). The shape stdlib (`../shapes/`)
// is built on this.

export {
  Point,
  DerivedPoint,
  pt,
  toPoint,
  isPoint,
  vecEquals,
  type Pointlike,
  type ResolveVec,
} from "./point";

export { centroid } from "./aggregates";

export {
  Bounds,
  aabb,
  aabbEdgeFrom,
  expandAABB,
  unionAABB,
  type AABB,
} from "./bounds";

export {
  Shape,
  SVG_NS,
  type ShapeOpts,
  type AnyShape,
  type AnimatableKey,
  type Writable,
  type Segment,
  boundsInRoot,
  boundsIn,
  draggable,
} from "./shape";

export {
  type Matrix2D,
  identity as matrixIdentity,
  fromTranslate,
  fromRotate,
  fromScale,
  multiply as matrixMultiply,
  invert as matrixInvert,
  transformPoint,
  transformAABB,
  compose as composeMatrix,
  isIdentity,
  toString as matrixToString,
} from "./matrix";

export { makeScene, type Scene, type Padding } from "./scene";
