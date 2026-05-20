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
  type ReactiveOptions,
} from "./reactive";

export {
  LINEAR, LERP, METRIC, EQUALS,
  linearOf, lerpOf, metricOf, equalsOf,
  requireLinear, requireLerp, requireMetric, requireEquals,
  classOf,
  type Linear, type Lerp, type Metric, type Equals,
  type ValueClass,
} from "./traits";

export { field, type ReactiveInit } from "./field";

export { Num, NumChain, num } from "./values/num";
export { Vec, VecChain, vec, polar } from "./values/vec";
export { Box, BoxChain, box } from "./values/box";
