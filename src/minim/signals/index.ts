// Public API for the signals module.
//
// Design: writability is a generic modifier (`Writable<R>`) on top of
// RO-by-default value classes. The brand on factory returns gates
// `.value =`, `.set`, `.bind` so untyped consumers can't accidentally
// mutate a derived (read-only) signal. Animator-style constraints use
// `WritableOf<T> & Traits<T, K>` and reject bare RO values at compile
// time.

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
export { clockSignal } from "./clock";
export { bind, eq, freeze, gated } from "./lateral";
// ─── Ops (for value-class authors) ────────────────────────────────
export { applyOp0, applyOp1, applyOp2, type Op } from "./ops";
// ─── Engine ───────────────────────────────────────────────────────
export {
  batch,
  computed,
  computedCls,
  effect,
  isComputed,
  isLens,
  isSignal,
  lens,
  lensCls,
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
  requireEquals,
  requireLerp,
  requireLinear,
  requireMetric,
  type TraitDict,
  type TraitKey,
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
export * as ColorMath from "./values/color";
export { Color, rgb, rgba } from "./values/color";
export { hyperLens, type InversePolicy } from "./values/hyper";
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
// ─── Combinators ──────────────────────────────────────────────────
export { combine, mean } from "./values/multi";
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
// ─── Writable modifier ────────────────────────────────────────────
export {
  invertibles,
  type Writable,
  type WritableOf,
} from "./writable";
