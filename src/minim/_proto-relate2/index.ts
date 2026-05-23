// _proto-relate2 — lazy-solve constraint cluster prototype.
//
// Same numerical kernel as `_proto-avbd` (we re-use `Solver`,
// `Force`, and the geometric primitives), but the reactive
// integration is structurally different:
//
//   - **No `preEffect`**. Bound signals become lens-style nodes
//     whose `getter` triggers solve on read and whose `setter`
//     marks the cluster dirty + bumps a pulse signal.
//   - **Pure pull semantics**. Solve runs at most once per
//     read-after-write, never speculatively.
//   - **No new signal-layer primitives**. Everything uses
//     existing `signal()` + `getter`/`setter` install slots.
//
// See `cluster.ts` for the design notes.

export {
  type Bindable,
  clamp,
  distance,
  eq,
  generic,
  geq,
  leq,
  lensNum,
  softTarget,
  spring,
} from "./constraints";
export { Cluster } from "./cluster";
