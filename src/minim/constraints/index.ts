// constraints/ — reactive constraint engine.
//
// AVBD-based primal-dual solver integrated with the signals layer via
// `network`. Scales from "make two values equal" to sketchpad scenes
// and full rigid-body physics.
//
// Layered as:
//
//   Numerical kernel (signal-free):
//     solver.ts     `Solver`, SOA cell state + AVBD inner loop.
//     term.ts       `Term` base class (residual + Jacobian + dual λ).
//     terms.ts      `*Term` subclasses + `Strength` constants.
//     linalg.ts     SPD solve helpers.
//
//   Reactive integration:
//     cluster.ts    `Constraints`: a `Solver` + a phase `pipeline`
//                   run on each `step(dt)`.
//     factories.ts  Constraint factories returning Relations.
//     phases.ts     `Phase` type + built-in phases.
//     drivers.ts    Generators wrapping `c.step(dt)`.
//     physics.ts    `physics(opts)` — velocity + gravity (cloth, particles).
//     world.ts      `world(opts)` — physics + broadphase + contacts.
//     rigid.ts      Body, Joint, BodyAnchor relations + BoxContact.
//
// Reference: Giles, Diaz, Yuksel (2025). Augmented Vertex Block
// Descent. ACM TOG 44(4) — SIGGRAPH 2025. Extends Chen et al.
// (2024) "Vertex Block Descent". 2D demo at
// https://github.com/savant117/avbd-demo2d.

export { Constraints, constraints, type Relation } from "./cluster";
export {
  animate,
  dilated,
  fixedStep,
} from "./drivers";
export {
  angle,
  bend,
  clamp,
  collinear,
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
  pin,
  repel,
  rightAngle,
  softTarget,
  spring,
} from "./factories";
export { dragBody, dragBodyAnchored } from "./interaction";
export { type Phase, prepare, snapshot, solve, writeback } from "./phases";
export { type Physics, type PhysicsOpts, physics } from "./physics";
export {
  Body,
  BodyAnchor,
  BodyAnchorTerm,
  type BodyInit,
  type BodyOpts,
  BoxContact,
  body,
  bodyAnchor,
  Joint,
  type JointStiffness,
  JointTerm,
  joint,
  weld,
} from "./rigid";
export { Solver, type SolverOpts } from "./solver";
export { LAMBDA_MAX, PENALTY_MAX, PENALTY_MIN, Term } from "./term";
export {
  BoundsTerm,
  DistanceTerm,
  EqTerm,
  GenericTerm,
  LensNumTerm,
  type ResidualFn,
  SoftTargetTerm,
  Strength,
} from "./terms";
export { type World, type WorldOpts, world } from "./world";
