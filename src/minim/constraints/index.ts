// constraints/ — reactive constraint engine.
//
// AVBD-based solver tightly integrated with the signals layer.
// Scales from "make two values equal" to sketchpad-style scenes
// (thousands of points, lines, joints, springs).
//
// Layered as:
//
//   Numerical kernel (signal-free):
//     solver.ts     `Solver`, SOA cell state + AVBD inner loop.
//     force.ts      `Force` base class.
//     forces.ts     `*Force` subclasses + `Strength` constants.
//     linalg.ts     Sparse SPD solve helpers.
//
//   Reactive integration:
//     cluster.ts    `Cluster`: binds `Signal`s to a `Solver`,
//                   solves on writes, writes back without re-firing
//                   (via `signal.writeBack`).
//     factories.ts  Signal-aware constraint constructors (`eq`,
//                   `distance`, `spring`, `lensNum`, `clamp`, `leq`,
//                   `geq`, `softTarget`, `generic`, plus sketchpad
//                   primitives: `angle`, `parallel`, `perpendicular`,
//                   `collinear`, `onCircle`, `equalDist`, `midpoint`).
//     simulation.ts `Simulation`: velocity + gravity time-stepper,
//                   integrates with `core/anim`.
//
// Reference: Giles, Diaz, Yuksel (2025). Augmented Vertex Block
// Descent. ACM TOG 44(4) — SIGGRAPH 2025. Extends Chen et al.
// (2024) "Vertex Block Descent". 2D demo at
// https://github.com/savant117/avbd-demo2d.

export { Cluster } from "./cluster";
export {
  angle,
  clamp,
  collinear,
  distance,
  eq,
  equalDist,
  generic,
  geq,
  leq,
  lensNum,
  midpoint,
  onCircle,
  parallel,
  perpendicular,
  rightAngle,
  softTarget,
  spring,
} from "./factories";
export { Force, PENALTY_MAX, PENALTY_MIN } from "./force";
export {
  BoundsForce,
  DistanceForce,
  EqForce,
  GenericForce,
  LensNumForce,
  type ResidualFn,
  SoftTargetForce,
  Strength,
} from "./forces";
export { Simulation, type SimulationOpts } from "./simulation";
export { Solver, type SolverOpts } from "./solver";
