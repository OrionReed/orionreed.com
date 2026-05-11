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

export {
  centroid,
  meanRotation,
  meanScale,
  meanVec,
  meanNum,
} from "./scene/aggregates";

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
} from "./scene/shape";

export { draggable } from "./scene/interaction";

export { makeScene, type Scene } from "./scene/scene";

export {
  Anim,
  type Animator,
  type Awaitable,
  type Yieldable,
  type SpawnFn,
  type ObserveListeners,
} from "./core/anim";

export { EventBus } from "./core/events";

export {
  untilChange,
  onceEvent,
  fromPromise,
  race,
  until,
} from "./core/awaitables";

// ── Trace (derivations on top of `Anim.observe`) ────────────────────
export {
  spans,
  traceTree,
  tag,
  tagAll,
  tagOf,
  type Span,
  type Trace,
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
  rand,
  from,
  spring,
  oscillate,
  drift,
  attract,
  type SpringOpts,
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
  swap,
  stagger,
  splay,
  orbit,
  assemble,
} from "./motion";

// ── Consumer scaffold ───────────────────────────────────────────────
export { Diagram, css } from "./diagram";
export { attr, observedAttributesOf } from "./attr";
export { viewport } from "./viewport";
