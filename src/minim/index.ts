// minim — generator-driven SVG diagrams with reactive primitives.
//   core/   — signals, Anim, suspensions, composers, drive, timeline, …
//   scene/  — Shape, Point, Box, aggregates, Mount, …
//   shapes/ — visuals + layout + list (space stdlib)
//   motion/ — easings, transitions, behaviors, choreographers, clocks
//   anchor, diagram, attr, viewport — top-level utilities + scaffold
//
// Sibling subpath modules — import explicitly:
//   `minim/tex`     — LaTeX → MathML primitives via Temml
//   `minim/assert`  — trace (spans/tree/tag) + claim (assertions)
//   `minim/waapi`   — Web Animations / scroll / view-timeline bridges

// ── Core ────────────────────────────────────────────────────────────

// `cell` is the unified reactive primitive:
//   cell(v)            — writable
//   cell.derived(fn)   — read-only
//   cell.lens(r, w)    — writable lens
// `Cell<T, W>` is the type; underlying preact factories stay internal.
export { cell, type Cell, type ReadonlyCell, type RW } from "./core/cell";
export { effect, batch, untracked } from "./core/signal";

export {
  tween,
  lerpable,
  type Tween,
  type Easing,
  type Duration,
  type Lerp,
} from "./core/tween";

// Reactive value-type framework. `struct(name, defaults)` is the fluent
// Builder for record value types. For arrays/strings/variants use
// `lerpable(initial, lerp)` from `core/tween.ts`.
export {
  struct,
  type Reactive,
  type StructType,
} from "./values/struct";

// Built-in struct value types — each exposes:
//   - the struct value (e.g. `Vec`) for advanced use (.signal/.derived/.lens/.is)
//   - a lowercase factory shorthand (`vec`, `num`, `rgb`, `matrix`, `transform`)
//   - the plain value type alias (`V`, `C`, `Box`, `Matrix2D`, `Transform`)
//   - rw/ro flavor aliases where useful (`Point`/`DerivedPoint`, `N`/`DerivedN`)
export { Color, rgb, rgba, type C } from "./values/color";
export { Num, num, type N, type DerivedN } from "./values/num";
export {
  Transform,
  transform,
  type Tr,
  type DerivedTr,
} from "./values/transform";
export { Matrix2D, matrix } from "./values/matrix";

export { toSig, when, type Arg } from "./core/arg";

export { snapshot, counter } from "./core/store";

// `Vec` is the registered struct (value + type-witness via `instanceof`);
// `V` is the plain `{x, y}` value type.
export {
  Vec,
  vec,
  polar,
  isPoint,
  vecEquals,
  type V,
  type Point,
  type DerivedPoint,
  type Pointlike,
  type ResolveVec,
} from "./values/vec";

/** Generic mean over any signals with a registered struct algebra
 *  (Vec/Box/Color/Matrix2D/…) or raw `Signal<number>`. */
export { mean } from "./values/aggregates";

// `Box` is both the registered struct and the plain `{x, y, w, h}` type.
export {
  Box,
  expandBox,
  unionBox,
  boxEdgeFrom,
  isBox,
  type Boxlike,
} from "./values/box";

export {
  Shape,
  centroid,
  meanRotation,
  meanScale,
  type ShapeOpts,
  type AnyShape,
  type Writable,
} from "./scene/shape";

export { draggable, hoverSignal } from "./scene/interaction";

export {
  marker,
  palette,
  hover,
  getMarker,
  registerMarker,
  type Marker,
} from "./core/marker";

export { mount, type Mount } from "./scene/mount";

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
  untilFalse,
  untilEvent,
  untilPromise,
  race,
  firstN,
  endOn,
  startOn,
} from "./core/suspensions";

export {
  all,
  sequence,
  delay,
  transaction,
  rand,
} from "./core/compose";

export { drive } from "./core/drive";

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
  expand,
  grid,
  split,
  forEach,
  debug,
  handle,
  type HandleOpts,
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
  orbit,
  pulse,
  every,
  swap,
  stagger,
  splay,
  assemble,
} from "./motion";

// ── Spatial constants ───────────────────────────────────────────────
export { Anchor, Dir } from "./values/anchor";

// ── Consumer scaffold ───────────────────────────────────────────────
export { Diagram, css } from "./diagram";
export { attr, observedAttributesOf } from "./attr";
export { viewport } from "./viewport";
