// minim — retained-mode scene graph on a vendored signals core.
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
  lens,
  Signal,
  tween,
  type ReadonlySignal,
  type Tween,
  type Easing,
  type Duration,
} from "./core/signal";

export { counter } from "./core/counter";

export {
  toSig,
  when,
  type Arg,
  type NumSig,
  type ResolveSig,
} from "./core/arg";

export { snapshot } from "./core/store";

export { type Vec } from "./core/vec";

export {
  Point,
  DerivedPoint,
  pt,
  toPoint,
  isPoint,
  vecEquals,
  type Pointlike,
  type ResolveVec,
} from "./scene/point";

export { centroid } from "./scene/aggregates";

export { Bounds, type AABB } from "./scene/bounds";

export {
  Shape,
  type ShapeOpts,
  type AnyShape,
  type AnimatableKey,
  type Writable,
  type Segment,
  boundsInRoot,
  boundsIn,
  draggable,
} from "./scene/shape";

export { makeScene, type Scene } from "./scene/scene";

export {
  Anim,
  type Animator,
  type Awaitable,
  type Yieldable,
  type Span,
  type Trace,
} from "./core/anim";

export { EventBus } from "./core/events";

// ── Trace (derivations on top of `Anim.trace()`) ────────────────────
export {
  traceTree,
  tag,
  tagAll,
  type TraceTree,
  type TraceNode,
  type TraceBatch,
} from "./trace";

export {
  timeline,
  sequential,
  type Clip,
  type Timeline,
  type TimelineOf,
} from "./core/timeline";

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
  from,
  fadeIn,
  fadeOut,
  fadeUp,
  fadeUpOut,
  slideIn,
  slideOut,
  scaleIn,
  zoomOut,
  bounceIn,
  spinIn,
  Dir,
  pulse,
  clock,
  every,
  ramp,
  reverse,
  speed,
} from "./motion";

// ── Consumer scaffold ───────────────────────────────────────────────
export { Diagram, css } from "./diagram";
export { attr, observedAttributesOf } from "./attr";
export { viewport } from "./viewport";
