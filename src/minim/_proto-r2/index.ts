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
  type ValueOf,
  type SignalOptions,
} from "./signal";

export {
  linearOf, lerpOf, metricOf, equalsOf,
  requireLinear, requireLerp, requireMetric, requireEquals,
  type Linear, type Lerp, type Metric, type Equals,
  type Traits, type TraitDict, type TraitKey,
} from "./traits";

export { field, type SignalInit } from "./field";

export { Num, NumChain, num, type NumValue } from "./values/num";
export { Vec, VecChain, vec, polar, type VecValue } from "./values/vec";
export { Box, BoxChain, box, type BoxValue } from "./values/box";
export { Color, ColorChain, rgb, rgba, type ColorValue } from "./values/color";
export {
  Matrix, MatrixChain, matrix,
  identity, fromTranslate, fromScale, fromRotate,
  isIdentity, multiply, invert, determinant,
  transformPoint, transformBox, compose,
  toMatrixString,
  type MatrixValue,
} from "./values/matrix";
export {
  Transform, TransformChain, transform,
  type TransformValue, type TransformInit,
} from "./values/transform";
export { combine, mean } from "./values/multi";
export { hyperLens, type InversePolicy } from "./values/hyper";

export {
  tween, tweenStep, spring, toward, attract,
  type SpringOpts,
} from "./anim";
