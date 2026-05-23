// _proto-avbd — Augmented Vertex Block Descent prototype.
//
// A constraint solver based on the algorithm from
//
//   Giles, Diaz, Yuksel (2025). Augmented Vertex Block Descent.
//   ACM TOG 44(4) — SIGGRAPH 2025.
//
// extending Chen et al. (2024) "Vertex Block Descent". The reference
// 2D implementation by Chris Giles is at
//   https://github.com/savant117/avbd-demo2d
//
// Architecture:
//
//   - `Solver` owns SOA buffers (positions/initials/inertials/masses)
//     indexed by integer cell ids. `addCell(dim, init?)` returns
//     a fresh id; `bind(sig)` registers a reactive `Signal` (any
//     class declaring the `pack` trait) and returns its id.
//   - `Force` and subclasses (`EqForce`, `DistanceForce`, …) operate
//     on cell ids and read positions through the solver's buffers.
//   - `reactive.ts` installs a `preEffect` driver per solver that
//     pulls signal values into cells, runs the solver, and writes
//     results back. Self-mutes via the signals layer's preEffect
//     primitive.
//   - `Simulation` wraps the solver with velocity, gravity, and
//     time-stepping. Composes with `core/anim` via `animate()`.

export {
  angle,
  type Bindable,
  BoundsForce,
  bounded,
  clamp,
  collinear,
  DistanceForce,
  distance,
  EqForce,
  eq,
  equalDist,
  GenericForce,
  generic,
  geq,
  LensNumForce,
  lensNum,
  leq,
  midpoint,
  onCircle,
  parallel,
  perpendicular,
  type ResidualFn,
  SoftTargetForce,
  Strength,
  softTarget,
  spring,
} from "./constraints";
export { Force, PENALTY_MAX, PENALTY_MIN } from "./force";
// Side-effect import: registers the reactive driver factory so
// `Solver.bind()` works. Re-exports `pin`.
export { pin } from "./reactive";
export { Simulation, type SimulationOpts } from "./simulation";
export { Solver, type SolverOpts } from "./solver";
