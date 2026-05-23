// solver.ts — Augmented Vertex Block Descent solver core.
//
// This is the numerical kernel: take a set of cells (vertices) and
// forces (constraints), advance them one step. Adapted from the
// reference 2D AVBD demo (Giles et al., SIGGRAPH 2025) at
// https://github.com/savant117/avbd-demo2d, generalised for cells
// of varying DOF and stripped of physics-specific parts (no
// collision detection, no friction primitives — those go in domain-
// specific extensions).
//
// ─── Algorithm summary ─────────────────────────────────────────────
//
// Per timestep:
//   1. Force initialisation + warm-start of penalty/lambda from
//      previous step (paper §3.7, eq. 19).
//   2. Cell warm-start: y = x + h·v + h²·a (paper §3.1, eq. 2).
//   3. Outer loop over `iterations + (postStabilize ? 1 : 0)` steps:
//      a. Primal pass: for each cell with mass > 0, solve a local
//         `dim × dim` linear system using only its incident forces
//         (paper §3.2, eq. 4). The "vertex block descent" step.
//      b. Dual pass (skipped during the post-stabilisation iteration):
//         update each force's lambda and penalty (paper §3.1
//         eq. 11, §3.4 eq. 16).
//   4. Velocity update: v = (x − x⁻) / dt (paper §3.1, eq. 6).
//
// Stabilisation parameter `α`:
//   - `α = 0`: full error correction every step. The constraint
//     residual is `C*(x)` directly, and the solver tries to fully
//     satisfy it within the iteration budget. This is what we want
//     for static / kinematic editing — the user expects a write to
//     immediately propagate. (Default in this prototype.)
//   - `α ∈ (0, 1)`: gradual correction. Useful for physics
//     simulation where pre-existing constraint error from limited
//     iteration budgets shouldn't manifest as explosive forces in
//     the next frame. The constraint becomes `C*(x) − α·C*(x⁻)`.
//
// ─── Geometric editing mode ────────────────────────────────────────
//
// The AVBD paper is written for physics: dt is a physical timestep,
// mass is physical mass, gravity is the external acceleration. For
// purely-geometric / static editing (CAD, Sketchpad-style sketches),
// we use the same machinery but interpret it differently:
//
//   - dt = 1: the inertia term `m / dt² · ‖x − y‖²` becomes a unit
//     Tikhonov regularisation. For under-determined systems, this
//     selects the solution closest to `y` (the warm-start anchor).
//   - mass = 1: uniform regularisation. `mass = 0` marks a
//     kinematic / pinned cell.
//   - aExt = 0: no gravity / external acceleration.
//   - velocity = 0 by default: no inertia between solves.
//   - alpha = 0: full error correction (no stabilisation).
//
// The user can opt back into dynamics by setting `dt`, `mass`,
// `aExt`, and `alpha` to physics-shaped values.

import type { Cell } from "./cell";
import { PENALTY_MAX, PENALTY_MIN } from "./force";
import type { Force } from "./force";
import { clamp, solveSPD } from "./linalg";

export interface SolverOpts {
  /** Timestep size. Default 1.0 (kinematic / static editing mode). */
  dt?: number;
  /** External acceleration applied to every cell. Length must be
   *  ≥ the maximum cell dim in the solver. Default zero. */
  aExt?: ArrayLike<number>;
  /** Number of primal+dual iterations per step. Default 10. */
  iterations?: number;
  /** Stabilisation parameter α ∈ [0, 1]. `0` (default) = full
   *  error correction, suitable for static editing. `0.99` =
   *  gradual correction over multiple frames, suitable for
   *  physics. Values in between trade off responsiveness and
   *  smoothness. */
  alpha?: number;
  /** Penalty ramp parameter β. Larger → faster penalty growth →
   *  faster convergence at the cost of stiffer linear systems.
   *  Default 1e5. Paper recommends [1, 1000]; 1e5 worked for the
   *  reference 2D demo. */
  beta?: number;
  /** Warm-start decay γ ∈ [0, 1). Default 0.99. */
  gamma?: number;
  /** When true (default), the solver runs in static-editing mode:
   *  no velocity extrapolation between steps (`y = x⁻`), no
   *  velocity update at end of step. Each `step()` is a fresh
   *  constraint-satisfaction problem starting from the current
   *  cell positions, with warm-started λ / penalty providing
   *  cross-step continuity.
   *
   *  Set to `false` for true physics simulation: `y = x⁻ + h·v +
   *  h²·a` and `v = (x − x⁻) / h`. */
  staticMode?: boolean;
}

const TINY = 1e-14;

export class Solver {
  private readonly _cells: Cell[] = [];
  private readonly _forces: Force[] = [];

  dt: number;
  aExt: Float64Array;
  iterations: number;
  alpha: number;
  beta: number;
  gamma: number;
  staticMode: boolean;

  /** Read-only view of registered cells. */
  get cells(): readonly Cell[] {
    return this._cells;
  }
  /** Read-only view of registered forces. */
  get forces(): readonly Force[] {
    return this._forces;
  }

  // Reusable scratch buffers for the local Newton system. Sized to
  // the largest cell dim seen so far.
  private _lhs = new Float64Array(0);
  private _rhs = new Float64Array(0);
  private _maxDim = 0;

  constructor(opts: SolverOpts = {}) {
    this.dt = opts.dt ?? 1.0;
    this.iterations = opts.iterations ?? 10;
    this.alpha = opts.alpha ?? 0; // static editing default
    this.beta = opts.beta ?? 1e5;
    this.gamma = opts.gamma ?? 0.99;
    this.staticMode = opts.staticMode ?? true;
    if (opts.aExt) {
      this.aExt = new Float64Array(opts.aExt.length);
      for (let i = 0; i < opts.aExt.length; i++) this.aExt[i]! = opts.aExt[i]!;
    } else {
      this.aExt = new Float64Array(0);
    }
  }

  addCell(cell: Cell): void {
    this._cells.push(cell);
    if (cell.dim > this._maxDim) {
      this._maxDim = cell.dim;
      this._lhs = new Float64Array(cell.dim * cell.dim);
      this._rhs = new Float64Array(cell.dim);
      // Grow aExt if it's smaller than the largest cell — out-of-
      // bounds reads would silently return 0, masking errors.
      if (this.aExt.length < cell.dim) {
        const old = this.aExt;
        this.aExt = new Float64Array(cell.dim);
        for (let i = 0; i < old.length; i++) this.aExt[i]! = old[i]!;
      }
    }
  }

  addForce(force: Force): void {
    this._forces.push(force);
  }

  removeForce(force: Force): void {
    const idx = this._forces.indexOf(force);
    if (idx >= 0) this._forces.splice(idx, 1);
    for (const c of force.cells) {
      const ci = c.forces.indexOf(force);
      if (ci >= 0) {
        c.forces.splice(ci, 1);
        c.forceCellIdx.splice(ci, 1);
      }
    }
  }

  /** Advance the simulation by one timestep. */
  step(): void {
    const dt = this.dt;
    const dt2 = dt * dt;
    const inv_dt2 = 1 / dt2;

    // ─── 1. Force initialisation + warm-start ────────────────────
    for (let fi = this._forces.length - 1; fi >= 0; fi--) {
      const f = this._forces[fi]!;
      if (f.disabled) {
        this.removeForce(f);
        continue;
      }
      if (!f.initialize()) {
        this.removeForce(f);
        continue;
      }
      // Cache C0 = C(x⁻) for stabilisation. Done by initialize() for
      // forces that need it; default is to compute it now from
      // current state (which IS x⁻ at this point — we haven't moved
      // anything yet this step).
      f.computeConstraint(0); // alpha=0 → C0 read raw
      for (let r = 0; r < f.rows; r++) f.C0[r]! = f.C[r]!;
      // Warm-start penalty + lambda (paper §3.7, eq. 19).
      // Lambda decays only by γ — the α factor in the paper's eq. 19
      // accounts for stabilisation energy that should be discounted.
      // For α = 0 (static mode) there's no such energy. For α > 0
      // we still use just γ here; the paper's α·γ damping is
      // physics-tuned and over-aggressive for our domain. Easy to
      // restore via a flag if needed.
      for (let r = 0; r < f.rows; r++) {
        f.lambda[r]! *= this.gamma;
        f.penalty[r]! = clamp(f.penalty[r]! * this.gamma, PENALTY_MIN, PENALTY_MAX);
        // Soft constraint: penalty capped by material stiffness.
        const k = f.stiffness[r]!;
        if (Number.isFinite(k) && f.penalty[r]! > k) f.penalty[r]! = k;
      }
    }

    // ─── 2. Cell warm-start ──────────────────────────────────────
    for (const cell of this._cells) {
      const dim = cell.dim;
      // Save x⁻ = current position.
      for (let k = 0; k < dim; k++) cell.initial[k]! = cell.position[k]!;
      // Compute inertial anchor `y`. In static mode, that's just
      // x⁻ (no extrapolation). In dynamics mode, y = x⁻ + h·v + h²·a.
      if (this.staticMode) {
        for (let k = 0; k < dim; k++) cell.inertial[k]! = cell.initial[k]!;
      } else {
        for (let k = 0; k < dim; k++) {
          cell.inertial[k]! = cell.initial[k]! + dt * cell.velocity[k]! + dt2 * this.aExt[k]!;
        }
        // Advance position to the extrapolated guess (free-fall
        // initialization). Skipped if mass = 0 (kinematic).
        if (cell.mass > 0) {
          for (let k = 0; k < dim; k++) cell.position[k]! = cell.inertial[k]!;
        }
      }
    }

    // ─── 3. Iterations ───────────────────────────────────────────
    for (let it = 0; it < this.iterations; it++) {
      const currentAlpha = this.alpha;

      // ─── 3a. Primal pass: per-vertex local Newton ────────────
      this._primalSweep(currentAlpha);

      // ─── 3b. Dual pass ────────────────────────────────────────
      {
        const beta = this.beta;
        const allForces = this._forces;
        for (let fi = 0; fi < allForces.length; fi++) {
          const f = allForces[fi]!;
          if (f.disabled) continue;
          f.computeConstraint(currentAlpha);
          const fHard = f.hard;
          const fLambda = f.lambda;
          const fPenalty = f.penalty;
          const fC = f.C;
          const fMin = f.fmin;
          const fMax = f.fmax;
          const fStiff = f.stiffness;
          const fFracture = f.fracture;
          const rows = f.rows;
          for (let r = 0; r < rows; r++) {
            const lambda = fHard[r]! === 1 ? fLambda[r]! : 0;
            const kC = fPenalty[r]! * fC[r]! + lambda;
            const lo = fMin[r]!;
            const hi = fMax[r]!;
            const newLambda = kC < lo ? lo : kC > hi ? hi : kC;
            fLambda[r]! = newLambda;
            const absLambda = newLambda < 0 ? -newLambda : newLambda;
            if (absLambda >= fFracture[r]!) {
              f.disable();
              break;
            }
            // Penalty update — only inside bounds.
            if (newLambda > lo && newLambda < hi) {
              const stiff = fStiff[r]!;
              const cap = stiff < PENALTY_MAX ? stiff : PENALTY_MAX;
              const absC = fC[r]! < 0 ? -fC[r]! : fC[r]!;
              const next = fPenalty[r]! + beta * absC;
              fPenalty[r]! = next > cap ? cap : next;
            }
          }
        }
      }

      // ─── 3c. Velocity update on the last iteration ──────────
      // Only in dynamics mode — static mode keeps velocities at 0
      // so cross-step error doesn't accumulate.
      if (!this.staticMode && it === this.iterations - 1) {
        for (const cell of this._cells) {
          for (let k = 0; k < cell.dim; k++) {
            cell.prevVelocity[k]! = cell.velocity[k]!;
            if (cell.mass > 0) {
              cell.velocity[k]! = (cell.position[k]! - cell.initial[k]!) / dt;
            }
          }
        }
      }
    }
  }


  /** Compute the unweighted L2 norm of the constraint residual
   *  vector ‖C‖. Cheap diagnostic for convergence checks in tests. */
  residualNorm(): number {
    let s = 0;
    for (const f of this._forces) {
      if (f.disabled) continue;
      f.computeConstraint(0); // un-stabilised (raw) residual
      for (let r = 0; r < f.rows; r++) s += f.C[r]! * f.C[r]!;
    }
    return Math.sqrt(s);
  }

  /** Forward Gauss-Seidel sweep over cells. Hot path. */
  private _primalSweep(currentAlpha: number): void {
    const lhs = this._lhs;
    const rhs = this._rhs;
    const cells = this._cells;
    const inv_dt2 = 1 / (this.dt * this.dt);
    for (let cellI = 0; cellI < cells.length; cellI++) {
      const cell = cells[cellI]!;
      if (cell.mass <= 0) continue;
      const dim = cell.dim;
      const cellPos = cell.position;
      const cellInertial = cell.inertial;
      const massInvDt2 = cell.mass * inv_dt2;
      // Initialise lhs = M / dt² · I, rhs = M / dt² · (x − y).
      if (dim === 2) {
        lhs[0]! = massInvDt2;
        lhs[1]! = 0;
        lhs[2]! = 0;
        lhs[3]! = massInvDt2;
        rhs[0]! = massInvDt2 * (cellPos[0]! - cellInertial[0]!);
        rhs[1]! = massInvDt2 * (cellPos[1]! - cellInertial[1]!);
      } else {
        for (let i = 0; i < dim * dim; i++) lhs[i]! = 0;
        for (let i = 0; i < dim; i++) lhs[i * dim + i]! = massInvDt2;
        for (let k = 0; k < dim; k++) {
          rhs[k]! = massInvDt2 * (cellPos[k]! - cellInertial[k]!);
        }
      }
      // Accumulate force contributions.
      const cellForces = cell.forces;
      const cellForceIdx = cell.forceCellIdx;
      for (let fi = 0; fi < cellForces.length; fi++) {
        const f = cellForces[fi]!;
        if (f.disabled) continue;
        const ci = cellForceIdx[fi]!;
        f.computeConstraint(currentAlpha);
        f.computeDerivatives(ci);
        const Jblock = f.J[ci]!;
        const Hcols = f.HCols[ci]!;
        const fHard = f.hard;
        const fLambda = f.lambda;
        const fPenalty = f.penalty;
        const fC = f.C;
        const fMin = f.fmin;
        const fMax = f.fmax;
        const rows = f.rows;
        for (let r = 0; r < rows; r++) {
          const lambda = fHard[r]! === 1 ? fLambda[r]! : 0;
          const kC = fPenalty[r]! * fC[r]! + lambda;
          const lo = fMin[r]!;
          const hi = fMax[r]!;
          const fc = kC < lo ? lo : kC > hi ? hi : kC;
          const baseJ = r * dim;
          const penalty_r = fPenalty[r]!;
          const absF = fc < 0 ? -fc : fc;
          if (dim === 2) {
            const j0 = Jblock[baseJ]!;
            const j1 = Jblock[baseJ + 1]!;
            rhs[0]! += j0 * fc;
            rhs[1]! += j1 * fc;
            lhs[0]! += penalty_r * j0 * j0;
            lhs[1]! += penalty_r * j0 * j1;
            lhs[2]! += penalty_r * j1 * j0;
            lhs[3]! += penalty_r * j1 * j1;
            if (absF > TINY) {
              lhs[0]! += Hcols[baseJ]! * absF;
              lhs[3]! += Hcols[baseJ + 1]! * absF;
            }
          } else {
            for (let k = 0; k < dim; k++) rhs[k]! += Jblock[baseJ + k]! * fc;
            for (let i = 0; i < dim; i++) {
              const ji = penalty_r * Jblock[baseJ + i]!;
              for (let j = 0; j < dim; j++) {
                lhs[i * dim + j]! += ji * Jblock[baseJ + j]!;
              }
            }
            if (absF > TINY) {
              for (let k = 0; k < dim; k++) {
                lhs[k * dim + k]! += Hcols[baseJ + k]! * absF;
              }
            }
          }
        }
      }
      // Solve and apply.
      if (dim === 2) {
        const a = lhs[0]!;
        const c = lhs[1]!;
        const d = lhs[3]!;
        const det = a * d - c * c;
        if (det > 1e-14) {
          const invDet = 1 / det;
          const b0 = rhs[0]!;
          const b1 = rhs[1]!;
          cellPos[0]! -= (d * b0 - c * b1) * invDet;
          cellPos[1]! -= (-c * b0 + a * b1) * invDet;
        }
      } else if (solveSPD(lhs, rhs, dim)) {
        for (let k = 0; k < dim; k++) cellPos[k]! -= rhs[k]!;
      }
    }
  }
}
