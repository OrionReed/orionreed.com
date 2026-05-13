// minim — generator-driven SVG diagrams with reactive primitives.
//   core/   — signals, Anim, suspensions, composers, drive, timeline, …
//   scene/  — Shape, Point, Box, aggregates, Mount, …
//   shapes/ — visuals + layout + list (space stdlib)
//   motion/ — easings, transitions, integrators (time stdlib)
//   anchor, diagram, attr, viewport — top-level utilities + scaffold
//
// Sibling subpath modules — import explicitly:
//   `minim/tex`     — LaTeX → MathML primitives via Temml
//   `minim/assert`  — trace (spans/tree/tag) + claim (assertions)
//   `minim/waapi`   — Web Animations / scroll / view-timeline bridges

// ── Core ────────────────────────────────────────────────────────────

// `cell` is the unified user-facing primitive for reactive state:
//   cell(v)            — writable        (alias for `signal(v)`)
//   cell.derived(fn)   — read-only       (alias for `computed(fn)`)
//   cell.lens(r, w)    — writable lens   (alias for `lens(r, w)`)
// `Cell<T, W>` is the unified type. The older `signal`/`computed`/
// `lens` and `Signal`/`ReadonlySignal` names remain for back-compat.
export { cell, type Cell, type ReadonlyCell, type RW } from "./core/cell";

export {
  signal,
  computed,
  effect,
  lens,
  Signal,
  type ReadonlySignal,
} from "./core/signal";

export {
  tween,
  lerpable,
  type Tween,
  type Easing,
  type Duration,
  type Lerp,
} from "./core/tween";

// Reactive value-type framework. `struct(name, defaults)` is the
// fluent Builder for record types; `defineCell` is the underlying
// primitive (escape hatch for non-record types: arrays, variants,
// strings — see `lerpable` for the simplest case).
export {
  struct,
  defineCell,
  type Reactive,
  type StructType,
} from "./signals/struct";

// Built-in struct value types beyond Vec/Box/Matrix.
export { Color, rgb, rgba, type C } from "./signals/color";

export { toSig, when, type Arg } from "./core/arg";

export { snapshot, counter } from "./core/store";

// `Vec` is the registered struct (value + type-witness via
// `instanceof`). The plain `{x, y}` value type is exported as `V` —
// what the legacy code called `type Vec` is now `type V`.
export {
  Vec,
  pt,
  polar,
  toPoint,
  lensPoint,
  isPoint,
  vecEquals,
  type V,
  type Point,
  type DerivedPoint,
  type Pointlike,
  type ResolveVec,
} from "./signals/vec";

export {
  centroid,
  meanRotation,
  meanScale,
  meanVec,
  meanNum,
} from "./scene/aggregates";
// Generic mean<T> — works for any value type with a registered
// vector-space algebra. meanVec/meanNum/centroid are sugar over it.
export { mean } from "./signals/aggregates";

// `Box` re-exports BOTH the value (the registered struct, used as
// `Box.signal({...})`, `instanceof Box`, etc.) AND the type alias for
// the plain `{x, y, w, h}` shape — same name, two namespaces.
// Mirrors how `Vec` works. The plain `box(x,y,w,h)` constructor is
// kept internal (would collide with `box(part)` decoration).
export {
  Box,
  expandBox,
  unionBox,
  boxEdgeFrom,
  type Boxlike,
} from "./signals/box";

export {
  Shape,
  type ShapeOpts,
  type AnyShape,
  type Writable,
  boxInRoot,
  boxIn,
} from "./scene/shape";

export { draggable } from "./scene/interaction";

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
export { Anchor, Dir } from "./anchor";

// ── Consumer scaffold ───────────────────────────────────────────────
export { Diagram, css } from "./diagram";
export { attr, observedAttributesOf } from "./attr";
export { viewport } from "./viewport";
