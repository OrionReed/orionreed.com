// Public API for the r2 prototype.

export {
  Signal,
  signal,
  computed,
  lens,
  effect,
  batch,
  untracked,
  value,
  isSignal,
  isLens,
  isComputed,
  setSignalWriteHook,
  type Val,
  type Read,
  type Computed,
  type Lens,
  type RO,
  type Of,
  type SignalOptions,
  type SignalInit,
} from "./signal";

export {
  linearOf, lerpOf, metricOf, equalsOf,
  requireLinear, requireLerp, requireMetric, requireEquals,
  type Linear, type Lerp, type Metric, type Equals,
  type Traits, type TraitDict, type TraitKey,
} from "./traits";

export {
  type Op, applyOp0, applyOp1, applyOp2, Chain,
} from "./ops";

export { Num, NumChain, num } from "./values/num";
export { Vec, VecChain, vec, polar } from "./values/vec";
export {
  Box, BoxChain, box,
  // box math fns
  union as boxUnion,
  edgeFrom,
} from "./values/box";
export { Color, ColorChain, rgb, rgba } from "./values/color";
export {
  Matrix, MatrixChain, matrix,
  identity, fromTranslate, fromScale, fromRotate,
  isIdentity, multiply, invert, determinant,
  transformPoint, transformBox, compose,
  toMatrixString,
} from "./values/matrix";
export {
  Transform, TransformChain, transform,
  type TransformInit,
} from "./values/transform";
export { Anchor, Dir } from "./values/anchor";
export { combine, mean } from "./values/multi";
export { hyperLens, type InversePolicy } from "./values/hyper";

export {
  tween, tweenStep, spring, toward, attract,
  Tween,
  follow, wave, driven,
  play, when, not, untilChange, loop, every,
  type Play, type PlayTrigger,
  type SpringOpts,
} from "./anim";

export { clockSignal } from "./clock";

// Math-helper namespace exports, mirroring prod's `VecMath`/`BoxMath`/…
// pattern. Lets consumers do `BoxMath.union(...)` without having to
// import each math fn separately. (We also expose `boxUnion` /
// `edgeFrom` as named exports for direct import.)
export * as NumMath from "./values/num";
export * as VecMath from "./values/vec";
export * as BoxMath from "./values/box";
export * as ColorMath from "./values/color";
export * as MatrixMath from "./values/matrix";
export * as TransformMath from "./values/transform";
