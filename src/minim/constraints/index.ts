// constraints/ — reactive constraint engine.
//
// AVBD-based solver tightly integrated with the signals layer.
// Designed to scale from "set two values equal" to sketchpad-style
// scenes (1000s of points, lines, hard joints, soft springs).
//
// Layered as:
//
//   - Numerical kernel (signal-free):
//       solver.ts   — `Solver`, SOA cell state + AVBD inner loop.
//       force.ts    — `Force` base class.
//       forces.ts   — Concrete `*Force` subclasses (`EqForce`,
//                     `DistanceForce`, `LensNumForce`,
//                     `BoundsForce`, `SoftTargetForce`,
//                     `GenericForce`) + `Strength` constants.
//       linalg.ts   — Sparse SPD solve, clamp, etc.
//
//   - Reactive integration:
//       cluster.ts    — `Cluster`: binds `Signal`s to a `Solver`.
//                       Wraps a regular `effect()` whose writebacks
//                       go through `signal.writeBack(value)` for
//                       structural termination.
//       factories.ts  — Signal-aware constraint factories: `eq`,
//                       `distance`, `spring`, `lensNum`, `clamp`,
//                       `bounded`, `leq`, `geq`, `softTarget`,
//                       `generic`, plus sketchpad primitives
//                       (`angle`, `parallel`, `perpendicular`,
//                       `collinear`, `onCircle`, `equalDist`,
//                       `midpoint`).
//       simulation.ts — `Simulation`: time-stepping wrapper
//                       (velocity, gravity). Composes with
//                       `core/anim` via `animate()`.
//
// Reference: Giles, Diaz, Yuksel (2025). Augmented Vertex Block
// Descent. ACM TOG 44(4) — SIGGRAPH 2025. Extends Chen et al.
// (2024) "Vertex Block Descent". 2D demo at
// https://github.com/savant117/avbd-demo2d.

export { Cluster } from "./cluster";
export {
  angle,
  type Bindable,
  bounded,
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
