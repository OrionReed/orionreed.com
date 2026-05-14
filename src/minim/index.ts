// minim — generator-driven SVG diagrams with reactive primitives.
//
//   core/     pure generator runtime: Anim, suspensions, composers,
//             drive, easings, snapshot, Val coercions
//   signals/  irreducible reactivity: signal engine, Cell types,
//             chain + tween, struct framework
//   values/   domain value-types (Vec, Box, Color, Matrix2D, Num,
//             Transform) + behaviors + algebra
//   shapes/   Shape base + visuals + interaction + layout + mount +
//             transitions + choreographers
//
// Sibling subpath modules:
//   `minim/tex`     LaTeX → MathML primitives via Temml
//   `minim/assert`  trace (spans/tree/tag) + claim (assertions)
//   `minim/ext`     timeline, events, waapi, marker (opt-in extras)

// ── Reactive signals (signal engine + cells + chain/tween + struct) ─
export {
  cell,
  derive,
  effect,
  batch,
  untracked,
  tween,
  lerpable,
  chain,
  struct,
  type Cell,
  type ReadonlyCell,
  type Tween,
  type Easing,
  type Duration,
  type Lerp,
  type Chained,
} from "./signals";

// ── Generator runtime + combinators ─────────────────────────────────
export {
  Anim,
  asGen,
  isGen,
  suspend,
  untilChange,
  untilTrue,
  untilFalse,
  untilEvent,
  untilPromise,
  race,
  all,
  sequence,
  parallel,
  loop,
  sleep,
  after,
  every,
  rand,
  drive,
  toSig,
  when,
  snapshot,
  counter,
  type Val,
  type Animator,
  type SpawnFn,
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
  clockSignal,
  Anchor,
  Dir,
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

// ── Shapes (space stdlib) ───────────────────────────────────────────
//
// `Shape` is the base SVG node — `translate` / `rotate` / `scale` /
// `origin` / `opacity`, plus `aabb`, `localFrame` / `worldFrame`,
// `add(child)`, and DOM event suspensions. Every concrete shape
// (`line`, `circle`, `rect`, `path`, …) extends it.
export {
  Shape,
  centroid,
  meanRotation,
  meanScale,
  draggable,
  hoverSignal,
  mount,
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
  type ShapeOpts,
  type AnyShape,
  type Writable,
  type Mount,
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

// ── Time stdlib ─────────────────────────────────────────────────────
//
// Easings live in `./core` (see top of file).
// Behaviors (spring / oscillate / drift / attract) live in `./values`
// (see the values block above).
// Transitions + choreographers (`fadeIn` / `slideIn` / `swap` /
// `orbit` / …) live in `./shapes` (see the shapes block above) —
// they're shape-shaped tweens.
export {
  linear,
  easeOut,
  easeIn,
  easeInOut,
} from "./core";

// Struct framework type-level surface (lives in `./signals/cell` but
// is conceptually paired with `./values` consumers).
export type {
  StructType,
  WriteOf,
  ReadOf,
  NestedMap,
  NestedInput,
} from "./signals";
export {
  spring,
  oscillate,
  drift,
  attract,
  type SpringOpts,
} from "./values";
export {
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
  orbit,
  swap,
  stagger,
  splay,
  assemble,
} from "./shapes";

// ── Extras (opt-in) ─────────────────────────────────────────────────
//
// Independently useful modules that don't belong in `core`. Each can
// also be imported directly via `@minim/ext` if you want to side-step
// the root re-export.
export {
  timeline,
  sequential,
  EventBus,
  type Clip,
  type Timeline,
  type TimelineOf,
} from "./ext";

// Marker: lives in tex/ alongside PartMarker which composes it.
export {
  marker,
  palette,
  hover,
  getMarker,
  registerMarker,
  type Marker,
} from "./tex";

// ── Consumer scaffold (`@minim/web`) ────────────────────────────────
//
// Custom-element host for embedding diagrams in HTML. Import directly
// from `@minim/web` to skip the root re-export.
export {
  Diagram,
  css,
  attr,
  observedAttributesOf,
  viewport,
  MdTex,
  MdMarker,
} from "./web";
