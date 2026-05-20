// Public API for the r2 prototype.

export {
  Reactive,
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
  type ReactiveOptions,
} from "./reactive";

export {
  linearOf, lerpOf, metricOf, equalsOf,
  requireLinear, requireLerp, requireMetric, requireEquals,
  classOf,
  type Linear, type Lerp, type Metric, type Equals,
  type Traits,
  type HasTraits, type HasLinear, type HasLerp, type HasMetric, type HasEquals,
  type ValueClass,
} from "./traits";

export { field, type ReactiveInit } from "./field";

export { Num, NumChain, num, type NumValue } from "./values/num";
export { Vec, VecChain, vec, polar, type VecValue } from "./values/vec";
export { Box, BoxChain, box, type BoxValue } from "./values/box";
