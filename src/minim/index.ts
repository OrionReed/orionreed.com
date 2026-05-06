// minim — retained-mode scene graph on @preact/signals-core.
// Conceptual layout: (space, time) tuple.
//   core/    — irreducible foundation (signals, shape graph, math)
//   shapes/  — concrete visuals + layout + list (space stdlib)
//   motion/  — easings, composers, transitions (time stdlib)
//   diagram, attr, viewport — consumer scaffold (this folder)

// ── Core ────────────────────────────────────────────────────────────
export {
  signal,
  computed,
  effect,
  Signal,
  TweenChain,
  type ReadonlySignal,
  type Arg,
  type NumSig,
  type ResolveSig,
} from "./core/signal";

export { Point, pt } from "./core/point";

export { Bounds, type AABB, type Vec } from "./core/bounds";

export {
  Shape,
  type ShapeOpts,
  type AnyShape,
  type AnimatableKey,
  type Writable,
  type Segment,
  boundsInRoot,
  boundsIn,
} from "./core/shape";

export { makeScene, type Scene } from "./core/scene";

export { Anim, type Animator, type Yieldable } from "./core/anim";

// ── Shapes (space stdlib) ───────────────────────────────────────────
export {
  line,
  circle,
  rect,
  label,
  group,
  Path,
  path,
  annularSector,
  connect,
  arrow,
  clipPath,
  tokens,
  Text,
  t,
  align,
  arrange,
  forEach,
  type CommonOpts,
  type LineOpts,
  type RectOpts,
  type CircleOpts,
  type LabelOpts,
  type PathOpts,
  type AnnularSectorOpts,
  type ArrowOpts,
  type ArrangeOpts,
  type ForEachOptions,
  type Content,
} from "./shapes";
// Classes exported as types only — construct via lowercase factories.
export type { Line, Circle, Rect, Label, AnnularSector } from "./shapes";

// ── Motion (time stdlib) ────────────────────────────────────────────
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
  fadeIn,
  fadeUp,
  slideIn,
  scaleIn,
  bounceIn,
  spinIn,
  fadeOut,
  zoomOut,
  fadeUpOut,
  slideOut,
} from "./motion";

// ── Consumer scaffold ───────────────────────────────────────────────
export { Diagram, css } from "./diagram";
export { attr, observedAttributesOf } from "./attr";
export { viewport } from "./viewport";
