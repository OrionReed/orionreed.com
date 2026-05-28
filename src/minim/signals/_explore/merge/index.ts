// Public surface of the merge prototype. Mirrors `signals/index.ts`
// for the subset we copied; adds the merge primitives.

export {
  _activeBwdWriter,
  _batchDepth,
  _bwdCascadeId,
  batch,
  derive,
  effect,
  type Init,
  type Inner,
  isComputed,
  isLens,
  isSignal,
  lazy,
  lens,
  type Network,
  network,
  type Read,
  reader,
  readNow,
  Signal,
  type SignalOptions,
  setSignalWriteHook,
  signal,
  type SymmetricLensSpec1,
  type SymmetricLensSpecN,
  untracked,
  type Val,
  type Writable,
  type WritableBrand,
} from "./signal";
export {
  type Equals,
  type Lerp,
  type Linear,
  type Metric,
  type Pack,
  type Pivotal,
  requireEquals,
  requireLerp,
  requireLinear,
  requireMetric,
  requirePack,
  requirePivotal,
  type TraitDict,
  type Traits,
} from "./traits";
export { derived, field } from "./writable";
export { Num, num } from "./num";
export { Vec, vec } from "./vec";
export {
  DIRECT_SLOT,
  maxPolicy,
  meanPolicy,
  meanScalarPolicy,
  type MergePolicy,
  minPolicy,
  peekMergeAcc,
  peekMergeSlots,
  sumPolicy,
  withMerge,
} from "./merge";
