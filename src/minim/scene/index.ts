// Scene graph: `Shape` + spatial primitives (Point, Bounds, AABB) +
// matrix math + the `Scene` callable. `../shapes/` is built on this.

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

export {
  centroid,
  meanRotation,
  meanScale,
  meanVec,
  meanNum,
} from "./aggregates";

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
} from "./shape";

export { draggable } from "./interaction";

export { makeScene, type Scene, type Padding } from "./scene";
