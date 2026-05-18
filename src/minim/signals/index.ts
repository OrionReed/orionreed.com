export {
  Signal,
  Computed,
  signal,
  computed,
  lens,
  effect,
  batch,
  untracked,
  value,
  isSignal,
  type Lens,
  type Read,
  type Val,
  type SignalOptions,
} from "./signal";

export {
  LINEAR,
  LERP,
  METRIC,
  EQUALS,
  classOf,
  linearOf,
  lerpOf,
  metricOf,
  equalsOf,
  requireLinear,
  requireLerp,
  requireMetric,
  requireEquals,
  type Linear,
  type Lerp,
  type Metric,
  type Equals,
  type ValueClass,
} from "./traits";

export {
  BaseChain,
  derived,
  field,
  bindFields,
  type ReactiveInit,
} from "./derive";

export {
  Tween,
  tween,
  spring,
  toward,
  attract,
  follow,
  driven,
  wave,
  play,
  when,
  not,
  untilChange,
  loop,
  every,
  defineTrait,
  lerpImpl,
  type LerpMethods,
  type SpringOpts,
  type PlayTrigger,
} from "./lerp";

export { clockSignal } from "./clock";

export {
  Num,
  num,
  type NumValue,
  Vec,
  vec,
  polar,
  type VecValue,
  Color,
  rgb,
  rgba,
  type ColorValue,
  Box,
  box,
  type BoxValue,
  Transform,
  transform,
  type TransformValue,
  type TransformInit,
  Matrix,
  matrix,
  type MatrixValue,
  identity,
  fromTranslate,
  fromScale,
  fromRotate,
  isIdentity,
  multiply,
  invert,
  determinant,
  transformPoint,
  transformBox,
  compose,
  matrixToString,
  Anchor,
  Dir,
  mean,
  combine,
} from "./values";

export * as VecMath from "./values/vec";
export * as BoxMath from "./values/box";
export * as ColorMath from "./values/color";
export * as MatrixMath from "./values/matrix";
export * as NumMath from "./values/num";
export * as TransformMath from "./values/transform";
