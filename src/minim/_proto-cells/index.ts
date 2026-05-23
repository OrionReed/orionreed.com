// _proto-cells — prototype rewrite of the signals engine.
//
// Goals (from the original challenge):
//   1. Glitch-free; passes the existing signal tests + RFTS suite.
//   2. As-fast-or-faster than current.
//   3. More correct: stateful bwds use the engine-supplied `s` arg
//      honestly (no `this.peek()` side-channel).
//   4. More expressive: bidirectional `relate(a, b, fwd, bwd)`
//      primitive that admits multi-root writes (the alga case).
//
// Design:
//   - `Signal` is the same single-class signal/computed/lens primitive
//     as alien-signals v2, with the same flag dispatch.
//   - Statefulness is **arity-inferred** from `bwd.length`:
//       through(v => v + 1, v => v - 1)         // stateless (iso)
//       through(v => v, (v, s) => stateful_fn)  // stateful
//     No explicit law tag — `bwd.length >= 2` declares intent.
//   - `_fusedOf.stateful: boolean` flag composes by OR — any stateful
//     layer poisons the chain upward.
//   - `_fusedOf.fieldPath` enables a path-walking spread-replace fast
//     path for chains of `field()` lenses (3.5× faster writes than the
//     generic stateful composition).
//   - `preEffect` removed — failed experiment; `writeBack` (with
//     active-sub exclusion) is the cleaner replacement.

export {
  batch,
  computed,
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

export { bind } from "./lateral";

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

export { Num, num } from "./values/num";
export { Transform, type TransformInit, transform } from "./values/transform";
export { axes, polar, tangentPoint, Vec, vec } from "./values/vec";

export {
  derived,
  field,
  type Wr,
  type Writable,
  type WritableOf,
} from "./writable";

export { relate, type Relation } from "./relate";

export { fanin } from "./fanin";
