// minim — generator-driven SVG diagrams with reactive primitives.
//
//   core/    reactivity (`cell`), Anim, suspensions, composers,
//            drive, easings, clocks, tween, timeline, marker
//   values/  reactive value-types (Vec, Box, Color, Matrix2D, Num,
//            Transform) + struct framework + behaviors + algebra
//   scene/   Shape, interaction, mount
//   shapes/  visuals + layout + list (space stdlib)
//   motion/  transitions + choreographers (re-exports easings/clocks/
//            behaviors from their canonical homes)
//
// Sibling subpath modules:
//   `minim/tex`     LaTeX → MathML primitives via Temml
//   `minim/assert`  trace (spans/tree/tag) + claim (assertions)
//   `minim/waapi`   Web Animations / scroll / view-timeline bridges

// ── Reactive primitives + time + utilities ──────────────────────────
export {
  cell,
  effect,
  batch,
  untracked,
  tween,
  lerpable,
  toSig,
  when,
  snapshot,
  counter,
  marker,
  palette,
  hover,
  getMarker,
  registerMarker,
  Anim,
  asGen,
  isGen,
  suspend,
  EventBus,
  untilChange,
  untilTrue,
  untilFalse,
  untilEvent,
  untilPromise,
  race,
  firstN,
  endOn,
  startOn,
  all,
  sequence,
  delay,
  transaction,
  rand,
  drive,
  timeline,
  sequential,
  type Cell,
  type ReadonlyCell,
  type Tween,
  type Easing,
  type Duration,
  type Lerp,
  type Arg,
  type Marker,
  type Animator,
  type SpawnFn,
  type Clip,
  type Timeline,
  type TimelineOf,
} from "./core";

// ── Reactive value types + struct framework ─────────────────────────
//
// Each value type ships:
//   - the struct value (e.g. `Vec`) for advanced use
//     (.signal/.derived/.lens/.is/.isWritable)
//   - a lowercase factory shorthand (`vec`, `num`, `rgb`, `matrix`,
//     `transform`)
//   - the plain value type alias (`V`, `C`, `Box`, `Matrix2D`, …)
//   - rw/ro flavor aliases where useful (`Point`/`DerivedPoint`,
//     `N`/`DerivedN`)
export {
  struct,
  Vec,
  vec,
  polar,
  isPoint,
  vecEquals,
  Box,
  expandBox,
  unionBox,
  boxEdgeFrom,
  isBox,
  Color,
  rgb,
  rgba,
  Matrix2D,
  matrix,
  Num,
  num,
  Transform,
  transform,
  mean,
  algebraOf,
  Anchor,
  Dir,
  type Reactive,
  type StructType,
  type RW,
  type V,
  type Point,
  type DerivedPoint,
  type Pointlike,
  type ResolveVec,
  type Boxlike,
  type C,
  type N,
  type DerivedN,
  type Tr,
  type DerivedTr,
  type VectorSpace,
} from "./values";

// ── Scene graph ─────────────────────────────────────────────────────
export {
  Shape,
  centroid,
  meanRotation,
  meanScale,
  draggable,
  hoverSignal,
  mount,
  type ShapeOpts,
  type AnyShape,
  type Writable,
  type Mount,
} from "./scene";

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

// ── Consumer scaffold ───────────────────────────────────────────────
export { Diagram, css } from "./diagram";
export { attr, observedAttributesOf } from "./attr";
export { viewport } from "./viewport";
