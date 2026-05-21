// Public API for the signals module.
//
// Design: writability is a generic modifier (`Writable<R>`) on top of
// RO-by-default value classes. The brand on factory returns gates
// `.value =`, `.set`, `.bind` so untyped consumers can't accidentally
// mutate a derived (read-only) signal. Animator-style constraints use
// `WritableOf<T> & Traits<T, K>` and reject bare RO values at compile
// time.

// ─── Engine ───────────────────────────────────────────────────────
export {
  Signal,
  signal, computed, lens, computedCls, lensCls,
  effect, batch, untracked,
  isSignal, isComputed, isLens,
  value, valFn,
  setSignalWriteHook,
  type Read, type Val, type Of,
  type SignalOptions,
  type WritableBrand,
} from "./signal";

// ─── Traits ───────────────────────────────────────────────────────
export {
  type Linear, type Lerp, type Metric, type Equals,
  type Traits, type TraitDict, type TraitKey,
  requireLinear, requireLerp, requireMetric, requireEquals,
} from "./traits";

// ─── Ops (for value-class authors) ────────────────────────────────
export { type Op, applyOp0, applyOp1, applyOp2 } from "./ops";

// ─── Writable modifier ────────────────────────────────────────────
export {
  type Writable,
  type WritableOf,
  invertibles,
} from "./writable";

// ─── Value classes ────────────────────────────────────────────────
export { Num, num } from "./values/num";
export { Vec, vec, axes, polar, type PolarPolicy } from "./values/vec";
export { tangentPoint } from "./values/vec";
export {
  Box, box,
  union as boxUnion,
  edgeFrom,
} from "./values/box";
export { Transform, transform, type TransformInit } from "./values/transform";
export { Color, rgb, rgba } from "./values/color";
export {
  Matrix, matrix,
  identity, fromTranslate, fromScale, fromRotate,
  multiply, invert, determinant,
  transformPoint, transformBox, compose, toMatrixString,
  isIdentity,
} from "./values/matrix";
export { Anchor, Dir } from "./values/anchor";

// ─── Combinators ──────────────────────────────────────────────────
export { combine, mean } from "./values/multi";
export { hyperLens, type InversePolicy } from "./values/hyper";
export { eq, freeze, gated } from "./lateral";
export {
  argminNum, argminVec, clampToDisc,
  type ArgminOpts, type ArgminVecOpts,
} from "./argmin";

// ─── Animators ────────────────────────────────────────────────────
export {
  Tween, tween, tweenStep, spring, toward, attract,
  wave, driven, when, not, untilChange, loop, every,
  play, type Play, type PlayTrigger, type SpringOpts,
} from "./anim";

// ─── Clock bridge ─────────────────────────────────────────────────
export { clockSignal } from "./clock";

// ─── Math-helper namespaces ───────────────────────────────────────
// Mirrors prod's `VecMath`/`BoxMath`/… pattern. Lets consumers do
// `BoxMath.union(...)` etc. without importing each math fn separately.
export * as NumMath from "./values/num";
export * as VecMath from "./values/vec";
export * as BoxMath from "./values/box";
export * as ColorMath from "./values/color";
export * as MatrixMath from "./values/matrix";
export * as TransformMath from "./values/transform";
