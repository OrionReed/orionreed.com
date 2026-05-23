// _proto-cells — prototype rewrite of the signals engine.
//
// Goals (from the original challenge):
//   1. Glitch-free; passes the existing signal tests.
//   2. As-fast-or-faster than current.
//   3. More correct: explicit law tagging on lens layers (Iso /
//      Projection / Stateful / Opaque) so non-invertibles compose
//      honestly.
//   4. More expressive: bidirectional `relate(a, b, fwd, bwd)`
//      primitive that admits multi-root writes for re-orientable
//      relations (the alga case).
//
// Design:
//   - `Signal` is the same single-class signal/computed/lens primitive
//     as alien-signals v2, with the same flag dispatch.
//   - The `_fusedOf` tag now carries an explicit `LensLaw` rather than
//     the binary `bwdStateless`. The setter is built from the fused
//     law: Iso chains use a stateless setter; Stateful chains thread
//     `priorFwd(s)` honestly; Projection chains short-circuit when
//     idempotent.
//   - `preEffect` removed — failed experiment in the original code,
//     unnecessary now that bidirectional relations live in `relate.ts`.

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
