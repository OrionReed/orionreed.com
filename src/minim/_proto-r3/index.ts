// Public surface for the r3 prototype.

export {
  Node, type Read, type Of, type Val, type NodeOptions,
  Signal, Computed, Lens,
  signal, computed, lens,
  effect, batch, untracked,
  isNode, isSignal, isComputed, isLens,
  value,
} from "./signal";

export {
  type Linear, type Lerp, type Metric, type Equals,
  type TraitDict, type TraitKey, type Traits,
  linearOf, lerpOf, metricOf, equalsOf,
  requireLinear, requireLerp, requireMetric, requireEquals,
} from "./traits";

export { type Op, applyOp1, applyOp2 } from "./ops";
export { type Writable } from "./promote";

export {
  NumSignal, NumComputed, NumLens,
  type Num, type WritableNum,
  num, Num as NumNS,  // `Num` namespace exposes derive/lens/hasInstance
} from "./values/num";

export {
  VecSignal, VecComputed, VecLens,
  type Vec, type WritableVec,
  vec, Vec as VecNS, polar,
} from "./values/vec";
