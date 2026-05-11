// minim — generator-driven SVG diagrams with reactive primitives.
//   core/   — signals, Anim, suspensions, timeline, …
//   scene/  — Shape, Point, Bounds, aggregates, …
//   shapes/ — visuals + layout + list (space stdlib)
//   motion/ — easings, composers, transitions, … (time stdlib)
//   trace/  — derivations on `Anim.observe`
//   anchor, diagram, attr, viewport — top-level utilities + scaffold

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

export { toSig, when, type Arg } from "./core/arg";

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
  type Writable,
  boundsInRoot,
  boundsIn,
} from "./scene/shape";

export { draggable } from "./scene/interaction";

export { makeScene, type Scene } from "./scene/scene";

export {
  Anim,
  asGen,
  isGen,
  suspend,
  type Animator,
  type SpawnFn,
} from "./core/anim";

export { EventBus } from "./core/events";

export {
  untilChange,
  untilTrue,
  onceEvent,
  fromPromise,
  race,
  until,
} from "./core/suspensions";

// ── Trace ───────────────────────────────────────────────────────────
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

// ── Claims (specs & assertions as labeled bool signals) ─────────────
export {
  claim,
  process,
  labelledProcess,
  held,
  any,
  not,
  track,
  verdictDot,
  SignalClaim,
  Predicates,
  type Claim,
  type Process,
} from "./claim";

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
  button,
  Path,
  path,
  annularSector,
  connect,
  arrow,
  clipPath,
  tokens,
  Text,
  t,
  arrange,
  forEach,
  type CommonOpts,
  type LineOpts,
  type RectOpts,
  type CircleOpts,
  type LabelOpts,
  type ButtonOpts,
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
  drive,
  all,
  sequence,
  delay,
  transaction,
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
  pulse,
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

// ── Spatial constants ───────────────────────────────────────────────
export { Anchor, Dir } from "./anchor";

// ── Consumer scaffold ───────────────────────────────────────────────
export { Diagram, css } from "./diagram";
export { attr, observedAttributesOf } from "./attr";
export { viewport } from "./viewport";
