// solver.ts — Augmented Vertex Block Descent solver core.
//
// This is the numerical kernel: take a set of cells (vertices) and
// forces (constraints), advance them one step. Adapted from the
// reference 2D AVBD demo (Giles et al., SIGGRAPH 2025) at
// https://github.com/savant117/avbd-demo2d, generalised for cells
// of varying DOF and stripped of all physics-specific parts: no
// time, no velocity, no gravity, no collision. The solver answers
// the time-free question: "given an inertial anchor `y` and
// constraints, find `x`." Time-stepping (velocity, dt, gravity)
// lives in `Simulation` (see simulation.ts), which composes with
// this solver.
//
// ─── Algorithm summary ─────────────────────────────────────────────
//
// `prepare()`:
//   1. Force initialisation + warm-start of penalty/lambda from
//      previous step (paper §3.7, eq. 19).
//   2. Cell warm-start: snapshot initial = position; set inertial
//      = position. (Simulation overrides inertial after this.)
//
// `solve(dt)`:
//   3. Outer loop over `iterations` steps:
//      a. Primal pass: for each cell with mass > 0, solve a local
//         `dim × dim` linear system using only its incident forces
//         (paper §3.2, eq. 4). The "vertex block descent" step.
//      b. Dual pass: update each force's lambda and penalty
//         (paper §3.1 eq. 11, §3.4 eq. 16).
//
// `step()` calls both with `dt = 1` — the default static-editing
// path. With `dt = 1`, the inertia term `m / dt²` reduces to mild
// Tikhonov regularisation pulling each cell toward its inertial
// anchor (which is just its starting position).
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
// The AVBD paper is written for physics. For purely-geometric / static
// editing (CAD, Sketchpad-style sketches), we use the same machinery
// but interpret it differently:
//
//   - dt = 1: the inertia term `m / dt² · ‖x − y‖²` becomes a unit
//     Tikhonov regularisation. For under-determined systems, this
//     selects the solution closest to `y` (the warm-start anchor).
//   - mass = 1: uniform regularisation. `mass = 0` marks a
//     kinematic / pinned cell.
//   - alpha = 0: full error correction (no stabilisation).
//
// To opt into dynamics: wrap the solver in a `Simulation` (sets
// inertial = position + dt·v + dt²·a, manages velocity, drives ticks).

import type { Cell } from "./cell";
import { PENALTY_MAX, PENALTY_MIN } from "./force";
import type { Force } from "./force";
import { clamp, solveSPD } from "./linalg";

export interface SolverOpts {
  /** Number of primal+dual iterations per step. Default 10. */
  iterations?: number;
  /** Stabilisation parameter α ∈ [0, 1]. `0` (default) = full
   *  error correction. The constraint residual is treated as
   *  `C*(x) − α·C*(x⁻)`; positive α delays correction over
   *  multiple steps, useful for physics that wants gradual
   *  recovery from limited iteration budgets. */
  alpha?: number;
  /** Penalty ramp parameter β. Larger → faster penalty growth →
   *  faster convergence at the cost of stiffer linear systems.
   *  Default 1e5. Paper recommends [1, 1000]; 1e5 worked for the
   *  reference 2D demo. */
  beta?: number;
  /** Warm-start decay γ ∈ [0, 1). Default 0.99. */
  gamma?: number;
}

const TINY = 1e-14;

/** Remove element at `idx` by swapping in the last element. O(1).
 *  Caller must not rely on element ordering. */
function swapPop<T>(arr: T[], idx: number): void {
  if (idx < 0 || idx >= arr.length) return;
  const last = arr.length - 1;
  if (idx !== last) arr[idx] = arr[last]!;
  arr.pop();
}

export class Solver {
  private readonly _cells: Cell[] = [];
  private readonly _forces: Force[] = [];

  iterations: number;
  alpha: number;
  beta: number;
  gamma: number;

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
    this.iterations = opts.iterations ?? 10;
    this.alpha = opts.alpha ?? 0; // static editing default
    this.beta = opts.beta ?? 1e5;
    this.gamma = opts.gamma ?? 0.99;
  }

  addCell(cell: Cell): void {
    this._cells.push(cell);
    if (cell.dim > this._maxDim) {
      this._maxDim = cell.dim;
      this._lhs = new Float64Array(cell.dim * cell.dim);
      this._rhs = new Float64Array(cell.dim);
    }
  }

  addForce(force: Force): void {
    this._forces.push(force);
  }

  removeForce(force: Force): void {
    // Order doesn't matter in any of these arrays — solver iterates
    // them all per step. Swap-and-pop is O(1) per array.
    swapPop(this._forces, this._forces.indexOf(force));
    for (const c of force.cells) {
      const ci = c.forces.indexOf(force);
      if (ci < 0) continue;
      swapPop(c.forces, ci);
      swapPop(c.forceCellIdx, ci);
    }
  }

  /** Convenience: `prepare()` + `solve(1)`. The default static-editing
   *  step. For physics, drive the solver via `Simulation.tick(dt)`. */
  step(): void {
    this.prepare();
    this.solve(1);
  }

  /** Snapshot positions, warm-start forces, and set the inertial
   *  anchor `y = x⁻`. After calling this, callers may overwrite
   *  `cell.inertial` (e.g. `Simulation` adds inertial extrapolation)
   *  before invoking `solve(dt)`. */
  prepare(): void {
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
      // Cache C0 = C(x⁻) for stabilisation. We're at x⁻ now (haven't
      // moved anything this step).
      f.computeConstraint(0);
      for (let r = 0; r < f.rows; r++) f.C0[r]! = f.C[r]!;
      // Warm-start penalty + lambda (paper §3.7, eq. 19).
      for (let r = 0; r < f.rows; r++) {
        f.lambda[r]! *= this.gamma;
        f.penalty[r]! = clamp(f.penalty[r]! * this.gamma, PENALTY_MIN, PENALTY_MAX);
        const k = f.stiffness[r]!;
        if (Number.isFinite(k) && f.penalty[r]! > k) f.penalty[r]! = k;
      }
    }

    // ─── 2. Cell warm-start: y = x⁻ by default ───────────────────
    for (const cell of this._cells) {
      const dim = cell.dim;
      for (let k = 0; k < dim; k++) {
        cell.initial[k]! = cell.position[k]!;
        cell.inertial[k]! = cell.position[k]!;
      }
    }
  }

  /** Run the iteration loop using the current `cell.inertial` as
   *  the warm-start anchor. `dt` scales the inertia term `m / dt²`.
   *  Default 1 — gives mild Tikhonov regularisation. Smaller `dt`
   *  (e.g. `1/60`) makes the inertia term dominate, which is what
   *  physics simulation wants. */
  solve(dt: number = 1): void {
    const inv_dt2 = 1 / (dt * dt);

    for (let it = 0; it < this.iterations; it++) {
      const currentAlpha = this.alpha;

      // ─── Primal pass: per-vertex local Newton ────────────────
      this._primalSweep(currentAlpha, inv_dt2);

      // ─── Dual pass ────────────────────────────────────────────
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
  private _primalSweep(currentAlpha: number, inv_dt2: number): void {
    const lhs = this._lhs;
    const rhs = this._rhs;
    const cells = this._cells;
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
