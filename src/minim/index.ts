// scene-v2: retained-mode scene graph on @preact/signals-core.

export {
  signal,
  computed,
  effect,
  batch,
  untracked,
  Signal,
  type ReadonlySignal,
} from "./signal";
export { type Arg, toSig, type ResolveSig } from "./signal";

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

export { align, arrange, type ArrangeOpts } from "./layout";

export {
  Shape,
  SVG_NS,
  type ShapeOpts,
  type AnyShape,
  type AnimatableKey,
  type Writable,
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
} from "./matrix";

export { forEach, type ForEachOptions } from "./list";

export { type Segment, dashedPath } from "./dashed";

export {
  Line,
  line,
  Circle,
  circle,
  Rect,
  rect,
  Label,
  label,
  group,
  Path,
  PathBuilder,
  path,
  AnnularSector,
  annularSector,
  connect,
  arrow,
  clipPath,
  applyOpts,
  setupDashed,
  type CommonOpts,
  type LineOpts,
  type RectOpts,
  type CircleOpts,
  type LabelOpts,
  type PathOpts,
  type AnnularSectorOpts,
  type ArrowOpts,
} from "./shapes";

export { attr, observedAttributesOf } from "./attr";

export { makeScene, type Scene, type Padding } from "./scene";

export { useViewport } from "./viewport";

export { Text, t, type Content, type TextPart } from "./text";

export { tokens, type Tokens } from "./tokens";

export { Diagram, css } from "./diagram";

export { Anim, AbortError, type Animator, type Yieldable } from "./anim";

export {
  linear,
  easeOut,
  easeIn,
  easeInOut,
  all,
  sequence,
  delay,
  lag,
  until,
  repeat,
  race,
} from "./anims";

// Side-effect import: augments `Signal.prototype` with `.to(...)`.
export { TweenChain } from "./tween";
