// cell.ts — vertex / cell type for the AVBD solver.
//
// Each Cell holds the per-vertex state that the AVBD inner loop
// reads and writes. In the original AVBD reference (rigid bodies in
// 2D physics), a cell has 3 DOFs: x, y position and θ rotation.
// Our domain is more general: a Num cell has 1 DOF, a Vec has 2,
// a Box has 4, etc. The `dim` is set per cell and the local solve
// uses a `dim × dim` system.
//
// Naming follows the AVBD paper:
//
//   x    — current position (the value being solved for)
//   x⁻   — initial: position at start of timestep (before warm-start)
//   y    — inertial: warm-start anchor that the inertia term pulls
//          toward. For physics: x + h·v + h²·a_ext.
//          For our static editing use: previous solve's x, or the
//          user's most recent write.
//   v    — velocity: (x - x⁻) / dt at end of timestep
//   v⁻   — prevVelocity: for adaptive warm-start a la VBD §3.7
//   m    — mass: regularisation weight on the inertia term. Default
//          1; `m = 0` marks a kinematic / pinned cell that the solver
//          skips during primal updates.
//
// `forces` is the adjacency list — every Force that touches this
// cell. The AVBD primal step iterates over this list to build the
// local linear system.
//
// `signal` is the back-pointer to a reactive Signal (when present).
// The reactive engine layer uses it to write the post-solve value
// back into the signal graph and propagate to subscribers.

import type { Force } from "./force";

export class Cell {
  /** Number of degrees of freedom. */
  readonly dim: number;
  /** Current position (the value being solved for). */
  position: Float64Array;
  /** Position at start of timestep (`x⁻`). */
  initial: Float64Array;
  /** Warm-start anchor (`y`). The inertia term pulls `position`
   *  toward this. */
  inertial: Float64Array;
  /** Velocity at end of last timestep. */
  velocity: Float64Array;
  /** Velocity at end of step before that (for adaptive warm-start). */
  prevVelocity: Float64Array;
  /** Position from one Chebyshev iteration ago. Reused as scratch
   *  when acceleration is disabled. */
  posPrev1: Float64Array;
  /** Position from two Chebyshev iterations ago. */
  posPrev2: Float64Array;
  /** Regularisation weight on the inertia term `m / dt² · ‖x - y‖²`.
   *  Default 1 (mild regularisation, Tikhonov-like). `0` marks a
   *  kinematic/pinned cell — its primal update is skipped. */
  mass: number;
  /** Forces incident to this cell. Built up as the user creates
   *  constraints. */
  forces: Force[] = [];
  /** For each entry in `forces`, this cell's index within
   *  `force.cells`. Avoids `force.cells.indexOf(cell)` per cell-
   *  visit per iteration in the hot loop. Maintained alongside
   *  `forces` whenever a force is added or removed. */
  forceCellIdx: number[] = [];
  /** Optional back-pointer to a reactive Signal (set by the
   *  reactive engine adapter; left untyped here so the core
   *  solver doesn't depend on the signal layer). */
  signal?: unknown;

  constructor(dim: number, initial?: ArrayLike<number>) {
    this.dim = dim;
    this.position = new Float64Array(dim);
    this.initial = new Float64Array(dim);
    this.inertial = new Float64Array(dim);
    this.velocity = new Float64Array(dim);
    this.prevVelocity = new Float64Array(dim);
    this.posPrev1 = new Float64Array(dim);
    this.posPrev2 = new Float64Array(dim);
    this.mass = 1;
    if (initial) {
      for (let i = 0; i < dim; i++) {
        const v = initial[i] ?? 0;
        this.position[i] = v;
        this.initial[i] = v;
        this.inertial[i] = v;
      }
    }
  }
}
