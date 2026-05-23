// _proto-avbd — Augmented Vertex Block Descent prototype.
//
// A second-generation constraint solver, replacing the Newton-LM
// core of `_proto-relate` with the algorithm from
//
//   Giles, Diaz, Yuksel (2025). Augmented Vertex Block Descent.
//   ACM TOG 44(4) — SIGGRAPH 2025.
//
// extending Chen et al. (2024) "Vertex Block Descent". The reference
// 2D implementation by Chris Giles is at
//   https://github.com/savant117/avbd-demo2d
//
// Why AVBD over Newton-LM:
//   - Per-cell local Newton (DOF-sized) instead of global
//     factorisation. Eliminates the bandwidth / sparse-matrix
//     machinery the old prototype was wrestling with.
//   - Augmented Lagrangian gives true hard constraints (joint
//     limits, equality, attachment) without ill-conditioning.
//   - Per-iteration cost is O(cells × avg_force_per_cell × dim²).
//     Time-per-frame degrades gracefully — capping the iter count
//     stays stable, just leaves more residual.
//   - Maps directly to GPU coordinate descent should we want it.
//
// This folder is intentionally clean-slate. We don't depend on
// `_proto-relate`. Once AVBD proves out, we'll converge the two
// experiments.

export { Cell } from "./cell";
export { Force, PENALTY_MAX, PENALTY_MIN } from "./force";
export { Solver, type SolverOpts } from "./solver";
export {
  BoundsForce,
  clamp,
  distance,
  DistanceForce,
  eq,
  EqForce,
  lensNum,
  LensNumForce,
  pin,
  PinForce,
  softTarget,
  SoftTargetForce,
  spring,
} from "./constraints";
