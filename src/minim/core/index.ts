// Core: the irreducible (space, time) foundation. Self-contained —
// signal primitive is vendored (see `preact-signal.ts`). Drop this
// folder into another project to bootstrap a minim-like scene graph.

export {
  signal,
  computed,
  effect,
  batch,
  untracked,
  Signal,
  tween,
  type ReadonlySignal,
  type Tween,
  type Easing,
  type Duration,
} from "./signal";

export {
  toSig,
  when,
  type Arg,
  type NumSig,
  type ResolveSig,
} from "./arg";

export { store, snapshot, type Store } from "./store";

export { Point, pt } from "./point";

export {
  Bounds,
  aabb,
  aabbEdgeFrom,
  expandAABB,
  unionAABB,
  type AABB,
  type Vec,
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

export { Anim, type Animator, type Yieldable } from "./anim";
