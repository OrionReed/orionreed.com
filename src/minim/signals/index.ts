// Public API for the signals module.
//
// Design: writability is a generic modifier (`Writable<R>`) on top of
// RO-by-default value classes. The brand on factory returns gates
// `.value =` so untyped consumers can't accidentally mutate a derived
// (read-only) signal. Animator-style constraints use
// `WritableOf<T> & Traits<T, K>` and reject bare RO values at compile
// time. Lateral binding lives in the free `bind(target, source)`
// function rather than as a method.

// Aggregate primitives built on `Cls.lens([...], ...)` /
// `Cls.derive([...], ...)`. ~1.4–1.93× faster than the equivalent
// `mix(..., mean, deltaEven)` on aggregations (per-cell scratch,
// direct bwd invocation, no two-stage trait dispatch). `axesLens`
// and `polarCircular` are available here, but the hand-tuned
// `axes()` and `polar()` in `./values/vec.ts` remain the canonical
// surface for those — they win on 1-write polymorphic cases.
export {
  argminNumLens,
  axesLens,
  centroidLens,
  maxLens,
  meanLens,
  midpointLens,
  minLens,
  polarCircular,
  sumLens,
} from "./aggregates";
// ─── Animators ────────────────────────────────────────────────────
export {
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
export {
  type ArgminOpts,
  type ArgminVecOpts,
  argminNum,
  argminVec,
  clampToDisc,
} from "./argmin";
// ─── Clock bridge ─────────────────────────────────────────────────
export { bind } from "./lateral";
export * as Mix from "./mix";
// Merges, writebacks, and the `Part`/`Contribution` types live in
// the `Mix` namespace to avoid flat-export clashes (e.g. `above` is
// also a predicate in `./assert`; `Part` is also a class in
// `./tex/parts` and `./code/code`). The factory `mix(...)` is exported
// flat as the canonical entry point.
export { type Merge, mix, type Writeback } from "./mix";
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
export { type Relation, relate } from "./relate";
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
  type WritableBrand,
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
  type TraitKey,
  type Traits,
  traits,
} from "./traits";
export { Anchor, Dir } from "./values/anchor";
export * as BoxMath from "./values/box";
export {
  Box,
  box,
  edgeFrom,
  union as boxUnion,
} from "./values/box";
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
export * as TransformMath from "./values/transform";
export { Transform, type TransformInit, transform } from "./values/transform";
export * as VecMath from "./values/vec";
export { axes, type PolarPolicy, polar, tangentPoint, Vec, vec } from "./values/vec";
// ─── Writable modifier + authoring helpers ───────────────────────
export {
  derived,
  field,
  type Wr,
  type Writable,
  type WritableOf,
} from "./writable";
