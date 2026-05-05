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
export { type Arg, bindArg, isReactive, isSignal, read, unwrap } from "./signal";

export { Point, pt } from "./point";
export { Heading, heading } from "./heading";

export {
  Bounds,
  Pivot,
  aabb,
  aabbEdgeFrom,
  expandAABB,
  unionAABB,
  type AABB,
  type Vec,
} from "./bounds";

export { Shape, SVG_NS, type ShapeOpts } from "./shape";

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

export { Text, t, type Content, type TextPart } from "./text";

export { tokens, type Tokens } from "./tokens";

export { Diagram, css } from "./diagram";

export { Anim, AbortError, type Animator, type Yieldable } from "./anim";

export {
  easeOut,
  easeIn,
  easeInOut,
  tween,
  fadeIn,
  fadeOut,
  parallel,
  sequence,
  withDelay,
  lag,
  untilSig,
  repeat,
  race,
} from "./anims";
