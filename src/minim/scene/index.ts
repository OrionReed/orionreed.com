// Scene graph: `Shape` + spatial primitives (Point, Box, AABB) +
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
  aabb,
  aabbEdgeFrom,
  expandAABB,
  makeBox,
  unionAABB,
  type AABB,
  type Box,
} from "./box";

export {
  Shape,
  SVG_NS,
  type ShapeOpts,
  type AnyShape,
  type AnimatableKey,
  type Writable,
  type Segment,
  aabbInRoot,
  aabbIn,
} from "./shape";

export { draggable } from "./interaction";

export { makeScene, type Scene, type Padding } from "./scene";
