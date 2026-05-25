// Public API for the signals module.
//
// Design:
//
// - `Signal<T>` is the engine — self-contained, no peer imports.
//   Declares `value` as `declare readonly value: T`; the runtime
//   accessor is installed once on the prototype via Object.defineProperty
//   (V8-equivalent to `get value() { … }` syntax). Bare `Signal<T>`
//   and any bare value class (`Vec`, `Num`, `Box`, …) are RO at the
//   type level by default.
//
// - `Writable<R>` is the type-level modifier that re-adds a settable
//   `.value` via intersection with `WritableBrand`. Factory returns
//   (`signal(…)`, `vec(…)`, `Vec.lens(…)`, etc.) cast to it.
//
// - `Animatable<T, K>` is the animator-style call-site constraint
//   (`WritableOf<T> & Traits<T, K>`) — accepts a writable carrying T
//   whose class declares the listed traits.
//
// - Trait dispatch (`./traits`) is layered on top of Signal — the
//   engine knows nothing about any trait. Subclasses thread custom
//   equality through `super(v, { equals })` in their constructor.
//
// - Lateral binding lives in the free `bind(target, source)` function
//   rather than as a method.

// Aggregate primitives built on `Cls.lens([...], ...)` /
// `Cls.derive([...], ...)`. ~1.4–1.93× faster than the equivalent
// `mix(..., mean, deltaEven)` on aggregations (per-cell scratch,
// direct bwd invocation, no two-stage trait dispatch). `axesLens`
// and `polarCircular` are available here, but the hand-tuned
// `axes()` and `polar()` in `./values/vec.ts` remain the canonical
// surface for those — they win on 1-write polymorphic cases.
export {
  type ArgminOpts,
  type ArgminVecOpts,
  argminNum,
  argminVec,
  axesLens,
  centroidLens,
  clampToDisc,
  maxLens,
  meanLens,
  midpointLens,
  minLens,
  polarCircular,
  sumLens,
} from "./aggregates";
// ─── Animators ────────────────────────────────────────────────────
export {
  type Animatable,
  attract,
  driven,
  every,
  loop,
  not,
  type Play,
  type PlayTrigger,
  play,
  type SpringOpts,
  spring,
  Tween,
  toward,
  tween,
  tweenStep,
  untilChange,
  wave,
  when,
} from "./anim";
// ─── Clock bridge ─────────────────────────────────────────────────
export { bind } from "./lateral";
// ─── Network utilities (reactive-collection lifecycle helpers) ──
//
// `when` collides with the existing animator-flavoured `when` from
// `./anim`; consumers that need the network-flavoured lifecycle
// helper import it explicitly from "./network-utils" rather than
// the top-level index. `each` and `param` have no collisions and
// re-export from here is fine.
export { each, type Lifecycle, param } from "./network-utils";
// New primitives natural under N-input lenses. `vecLerp` / `pulleySum`
// / `diffLens` give bidirectional drag on derived values; `bezier2`/3,
// `clampedMean`, `distanceLens`, `angleLens`, `reflectionLens` are
// RO geometric helpers.
export {
  angleLens,
  bezier2,
  bezier3,
  clampedMean,
  diffLens,
  distanceLens,
  pulleySum,
  reflectionLens,
  vecLerp,
} from "./new-primitives";
// ─── Bidirectional relations ──────────────────────────────────────
//
// `relate(a, b, fwd, bwd)` is a re-orientable bidirectional binding
// between two existing writable signals — either side can be the
// driver (the propagator-network shape). Termination is structural
// (writeBack-based exclusion + the engine's `===` short-circuit)
// for any Iso or contractive pair.
//
// N-input multi-parent lenses are now expressed via the engine
// surface: `Cls.lens([p1, p2, ...], fwd, bwd)` for RW, or
// `Cls.derive([p1, p2, ...], fn)` for RO. The `fanin` helper that
// used to live here is now an engine-internal `_fanin` invoked by
// these surfaces — same hot path, cleaner public API.
export { type RelateHandle, relate } from "./relate";
// ─── Engine ───────────────────────────────────────────────────────
export {
  batch,
  computed,
  derive,
  effect,
  isComputed,
  isLens,
  isSignal,
  lazy,
  lens,
  type Network,
  network,
  type Of,
  type Read,
  Signal,
  type SignalOptions,
  setSignalWriteHook,
  signal,
  untracked,
  type Val,
  valFn,
  value,
  type Writable,
  type WritableBrand,
  type WritableOf,
} from "./signal";
// ─── Traits ───────────────────────────────────────────────────────
export {
  type Equals,
  type Lerp,
  type Linear,
  type Metric,
  type Pack,
  requireEquals,
  requireLerp,
  requireLinear,
  requireMetric,
  requirePack,
  type TraitDict,
  type Traits,
} from "./traits";
export { Anchor, Dir } from "./values/anchor";
export * as BoxMath from "./values/box";
export {
  Box,
  box,
  edgeFrom,
  union as boxUnion,
} from "./values/box";
// ─── Codec lenses (text ↔ typed-value bidirectional) ──────────────
// Bridges between `Signal<string>` (form input / URL param / label)
// and the typed value classes. No new value types — these are
// 1-input cross-class lenses on top of `Cls.lens`.
export {
  colorFromHex,
  hexFromColor,
  type NumCodecOpts,
  numFromText,
  secondsFromText,
  textFromNum,
  textFromSeconds,
} from "./values/codecs";
export * as ColorMath from "./values/color";
export { Color, rgb, rgba } from "./values/color";
export * as MatrixMath from "./values/matrix";
export {
  compose,
  determinant,
  fromRotate,
  fromScale,
  fromTranslate,
  identity,
  invert,
  isIdentity,
  Matrix,
  matrix,
  multiply,
  toMatrixString,
  transformBox,
  transformPoint,
} from "./values/matrix";
// ─── Math-helper namespaces ───────────────────────────────────────
// Mirrors prod's `VecMath`/`BoxMath`/… pattern. Lets consumers do
// `BoxMath.union(...)` etc. without importing each math fn separately.
export * as NumMath from "./values/num";
// ─── Value classes ────────────────────────────────────────────────
export { Num, num } from "./values/num";
export * as PoseMath from "./values/pose";
export { Pose, pose } from "./values/pose";
export * as RangeMath from "./values/range";
export { ends, Range, range, span } from "./values/range";
export * as TransformMath from "./values/transform";
export { Transform, type TransformInit, transform } from "./values/transform";
export * as VecMath from "./values/vec";
export { axes, type PolarPolicy, polar, tangentPoint, Vec, vec } from "./values/vec";
// ─── Value-class authoring helpers ───────────────────────────────
export { derived, field } from "./writable";
