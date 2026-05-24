// constraints/ — reactive constraint engine.
//
// AVBD-based solver tightly integrated with the signals layer via
// `settle`. Scales from "make two values equal" to sketchpad-style
// scenes (thousands of points, lines, joints, springs).
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
//     cluster.ts    `Cluster`: holds a `Solver` + a `settle` node.
//                   Free factories return `Relation` values; pass
//                   them to `cluster.add(rel)` / `cluster.remove(rel)`.
//                   The settle's body reads bound signals, runs
//                   `solver.step()`, and writes back — all auto-
//                   self-excluded (settle's contract) and atomic
//                   (settle's auto-batch) for glitch-free downstream.
//     factories.ts  Free constraint factories returning Relations
//                   (`eq`, `distance`, `spring`, `lensNum`, `clamp`,
//                   `leq`, `geq`, `softTarget`, `generic`, sketchpad
//                   primitives, `pin`).
//     simulation.ts `Simulation`: velocity + gravity time-stepper.
//                   Disposes the cluster's settle and runs its own
//                   tick loop (signals are mutated directly each
//                   frame; the cluster's reactivity is preempted).
//
// Reference: Giles, Diaz, Yuksel (2025). Augmented Vertex Block
// Descent. ACM TOG 44(4) — SIGGRAPH 2025. Extends Chen et al.
// (2024) "Vertex Block Descent". 2D demo at
// https://github.com/savant117/avbd-demo2d.

export { Constraints, constraints, defineRelation, type Relation } from "./cluster";
export {
  angle,
  type BoundsRelation,
  bend,
  clamp,
  collinear,
  type DistanceRelation,
  distance,
  eq,
  equalDist,
  gap,
  generic,
  geq,
  inside,
  lensNum,
  leq,
  midpoint,
  onCircle,
  parallel,
  perpendicular,
  repel,
  rightAngle,
  type SpringRelation,
  softTarget,
  spring,
} from "./factories";
export { Force, LAMBDA_MAX, PENALTY_MAX, PENALTY_MIN } from "./force";
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
export {
  Body,
  BodyAnchor,
  type BodyOpts,
  BoxContact,
  Joint,
  type JointStiffness,
  RigidWorld,
  type RigidWorldOpts,
} from "./rigid";
export { Simulation, type SimulationOpts } from "./simulation";
export { Solver, type SolverOpts } from "./solver";
