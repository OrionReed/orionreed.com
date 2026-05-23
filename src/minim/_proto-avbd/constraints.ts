// constraints.ts — concrete Force subclasses for the common
// geometric / numerical constraints. Each is a small class that
// implements `initialize`, `computeConstraint`, and
// `computeDerivatives`. The user-facing factories at the bottom
// (`distance`, `eq`, `lens`, …) construct + register these with a
// solver.
//
// Convention for constraint orientation:
//
//   The constraint function C(x) should equal zero when satisfied.
//   For inequalities, we pick the sign so that `C ≥ 0` is the
//   feasible side and we set `fmax = 0` (force can only push to
//   reduce C, not pull). Symmetric for `C ≤ 0`.
//
// All the constraints here support:
//
//   - Hard mode: `stiffness[r] = Infinity`. Uses augmented-Lagrangian
//     with progressive penalty ramping, perfectly satisfied at
//     convergence.
//   - Soft mode: `stiffness[r] = k` finite. Penalty ramps up to
//     `k`, then plateaus. Soft penalty competes with other forces
//     in the LSQ-like manner.
//   - Inequality bounds via `fmin` / `fmax`.
//
// We handle the most common cases (Num↔Num lens, Vec→Vec distance,
// equality, range-clamp). The architecture is open: any new force
// is just a Force subclass.

import { Cell } from "./cell";
import { Force } from "./force";
import { Solver } from "./solver";

// ─── Fixed-anchor pin (cell ↔ static target) ─────────────────────────
//
// Constraint: cell.position − target = 0.
// Used by `pin(cell, target)` for hard-pinning a cell to a fixed
// world value while leaving it free in the cluster (so other
// constraints can complain). For "make this cell completely
// inert", just set `cell.mass = 0` instead.

export class PinForce extends Force {
  target: Float64Array;

  constructor(cell: Cell, target: ArrayLike<number>, hard = true) {
    super([cell], cell.dim);
    this.target = new Float64Array(cell.dim);
    for (let k = 0; k < cell.dim; k++) this.target[k]! = target[k] ?? 0;
    if (!hard) {
      this.stiffness.fill(1e6);
      this.refreshHardFlags();
    }
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    const cell = this.cells[0]!;
    for (let k = 0; k < cell.dim; k++) {
      const Cn = cell.position[k]! - this.target[k]!;
      this.C[k]! = this.isHard(k) ? Cn - alpha * this.C0[k]! : Cn;
    }
  }

  computeDerivatives(_cellIdx: number): void {
    const cell = this.cells[0]!;
    const dim = cell.dim;
    const J = this.J[0]!;
    // J[r,k] = δ_{r,k} (identity). Set once; cheap.
    for (let r = 0; r < dim; r++) {
      for (let k = 0; k < dim; k++) J[r * dim + k]! = r === k ? 1.0 : 0.0;
    }
    // H is zero (constraint is linear).
  }
}

// ─── Equality between two same-dim cells ─────────────────────────────
//
// Constraint: a.position − b.position = 0 (componentwise).
// Hard by default. Replaces our old `lens(a, b, id, id)`.

export class EqForce extends Force {
  constructor(a: Cell, b: Cell, hard = true) {
    if (a.dim !== b.dim) throw new Error("eq: cell dims must match");
    super([a, b], a.dim);
    if (!hard) {
      this.stiffness.fill(1e6);
      this.refreshHardFlags();
    }
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    const a = this.cells[0]!,
      b = this.cells[1]!;
    for (let k = 0; k < this.rows; k++) {
      const Cn = a.position[k]! - b.position[k]!;
      this.C[k]! = this.isHard(k) ? Cn - alpha * this.C0[k]! : Cn;
    }
  }

  computeDerivatives(cellIdx: number): void {
    const dim = this.rows;
    const J = this.J[cellIdx]!;
    const sign = cellIdx === 0 ? 1.0 : -1.0;
    for (let r = 0; r < dim; r++) {
      for (let k = 0; k < dim; k++) J[r * dim + k]! = r === k ? sign : 0.0;
    }
  }
}

// ─── Generic invertible lens (Num→Num) ───────────────────────────────
//
// Constraint: b.position[0] − fwd(a.position[0]) = 0.
// Both cells must have dim = 1. For Vec→Vec, write a custom Force
// subclass (the `fwd`/`bwd` shape doesn't generalise cleanly via
// numerical FD without duplicating the work).
//
// Note: AVBD doesn't actually use `bwd` — the augmented Lagrangian
// converges to the correct two-way solution via duality. We accept
// `bwd` only for parity with the relate-prototype API; the runtime
// ignores it. (TODO: consider removing it from the signature.)

export class LensNumForce extends Force {
  fwd: (a: number) => number;
  // FD step for derivative.
  private readonly fdStep: number;

  constructor(a: Cell, b: Cell, fwd: (x: number) => number, fdStep = 1e-6) {
    if (a.dim !== 1 || b.dim !== 1) {
      throw new Error("lensNum: both cells must be Num (dim=1)");
    }
    super([a, b], 1);
    this.fwd = fwd;
    this.fdStep = fdStep;
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    const a = this.cells[0]!.position[0]!;
    const b = this.cells[1]!.position[0]!;
    const Cn = b - this.fwd(a);
    this.C[0]! = this.isHard(0) ? Cn - alpha * this.C0[0]! : Cn;
  }

  computeDerivatives(cellIdx: number): void {
    const J = this.J[cellIdx]!;
    if (cellIdx === 1) {
      // ∂C / ∂b = 1.
      J[0]! = 1.0;
    } else {
      // ∂C / ∂a = -fwd'(a). Forward difference.
      const a = this.cells[0]!.position[0]!;
      const f0 = this.fwd(a);
      const f1 = this.fwd(a + this.fdStep);
      J[0]! = -(f1 - f0) / this.fdStep;
    }
  }
}

// ─── Distance constraint (Vec ↔ Vec) ─────────────────────────────────
//
// Constraint: |a − b| − rest = 0.
// The classic spring/distance constraint from cloth and rigid-body
// physics. Hard mode → infinitely stiff (perfectly preserved).
// Soft mode → spring-like with finite stiffness.
//
// Jacobian: ∂C/∂a = (a − b) / |a − b|; ∂C/∂b = -ditto.
// Hessian: rank-1 correction with dyadic products — diagonally
// lumped via column-norms.

export class DistanceForce extends Force {
  rest: number;
  // Cached after computeConstraint, reused by computeDerivatives.
  // Skips redundant Math.hypot / subtractions in the hot loop.
  private _cachedNx = 0;
  private _cachedNy = 0;
  private _cachedInvD = 0;
  private _cachedDegenerate = false;
  private _aPos: Float64Array;
  private _bPos: Float64Array;

  constructor(a: Cell, b: Cell, rest: number, hard = true, stiffness = 1e6) {
    if (a.dim !== 2 || b.dim !== 2) {
      throw new Error("distance: both cells must be Vec (dim=2)");
    }
    super([a, b], 1);
    this.rest = rest;
    this._aPos = a.position;
    this._bPos = b.position;
    if (!hard) {
      this.stiffness.fill(stiffness);
      this.refreshHardFlags();
    }
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    const a = this._aPos;
    const b = this._bPos;
    const dx = a[0]! - b[0]!;
    const dy = a[1]! - b[1]!;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-24) {
      this._cachedDegenerate = true;
      this._cachedNx = 0;
      this._cachedNy = 0;
      this._cachedInvD = 0;
      const Cn = -this.rest;
      this.C[0]! = this.hard[0] === 1 ? Cn - alpha * this.C0[0]! : Cn;
      return;
    }
    const d = Math.sqrt(d2);
    const inv = 1 / d;
    this._cachedDegenerate = false;
    this._cachedNx = dx * inv;
    this._cachedNy = dy * inv;
    this._cachedInvD = inv;
    const Cn = d - this.rest;
    this.C[0]! = this.hard[0] === 1 ? Cn - alpha * this.C0[0]! : Cn;
  }

  computeDerivatives(cellIdx: number): void {
    const J = this.J[cellIdx]!;
    const Hcols = this.HCols[cellIdx]!;
    if (this._cachedDegenerate) {
      J[0]! = cellIdx === 0 ? 1 : -1;
      J[1]! = 0;
      Hcols[0]! = 0;
      Hcols[1]! = 0;
      return;
    }
    const nx = this._cachedNx;
    const ny = this._cachedNy;
    const inv = this._cachedInvD;
    const sign = cellIdx === 0 ? 1.0 : -1.0;
    J[0]! = sign * nx;
    J[1]! = sign * ny;
    // |col k of (I - n nᵀ)/d| = sqrt(1 - n_k²) / d for unit n.
    Hcols[0]! = Math.sqrt(1 - nx * nx) * inv;
    Hcols[1]! = Math.sqrt(1 - ny * ny) * inv;
  }
}

// ─── 1D bounds (clamp) ───────────────────────────────────────────────
//
// Constraint: cell.position[0] − lo ≥ 0  AND  hi − cell.position[0] ≥ 0.
// Implemented as a single Force with rows=2 (or rows=1 if only one
// side is bounded). Inequality via `fmax = 0` on each row.
//
// Hard by default; matches the relate prototype's `clamp(x, lo, hi)`.

export class BoundsForce extends Force {
  lo: number;
  hi: number;

  constructor(cell: Cell, lo: number, hi: number) {
    if (cell.dim !== 1) throw new Error("clamp: cell must be Num (dim=1)");
    super([cell], 2);
    this.lo = lo;
    this.hi = hi;
    // Row 0: x − lo ≥ 0 → fmin = -∞, fmax = 0 (force can only pull
    // x up if x < lo, never push down).
    // Row 1: hi − x ≥ 0 → same shape.
    this.fmax[0]! = 0;
    this.fmax[1]! = 0;
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    const x = this.cells[0]!.position[0]!;
    const c0 = x - this.lo;
    const c1 = this.hi - x;
    this.C[0]! = this.isHard(0) ? c0 - alpha * this.C0[0]! : c0;
    this.C[1]! = this.isHard(1) ? c1 - alpha * this.C0[1]! : c1;
  }

  computeDerivatives(_cellIdx: number): void {
    // Row 0: ∂(x-lo)/∂x = 1.
    // Row 1: ∂(hi-x)/∂x = -1.
    const J = this.J[0]!;
    J[0]! = 1; // row 0
    J[1]! = -1; // row 1
    // H is zero (linear).
  }
}

// ─── Soft pull / target (any cell) ───────────────────────────────────
//
// Constraint: cell.position − target = 0, with finite stiffness.
// Used to express "this cell prefers to be at this value, but
// other constraints can override".

export class SoftTargetForce extends Force {
  target: Float64Array;

  constructor(cell: Cell, target: ArrayLike<number>, stiffness: number) {
    super([cell], cell.dim);
    this.target = new Float64Array(cell.dim);
    for (let k = 0; k < cell.dim; k++) this.target[k]! = target[k] ?? 0;
    this.stiffness.fill(stiffness);
    this.refreshHardFlags();
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(_alpha: number): void {
    const cell = this.cells[0]!;
    for (let k = 0; k < cell.dim; k++) {
      this.C[k]! = cell.position[k]! - this.target[k]!;
    }
  }

  computeDerivatives(_cellIdx: number): void {
    const dim = this.cells[0]!.dim;
    const J = this.J[0]!;
    for (let r = 0; r < dim; r++) {
      for (let k = 0; k < dim; k++) J[r * dim + k]! = r === k ? 1 : 0;
    }
  }
}

// ─── User-facing factories ───────────────────────────────────────────
//
// Each registers the force with the solver and returns the force
// instance. The caller can later set `force.stiffness`, `force.fmin`,
// etc., before the next step.

export function pin(s: Solver, cell: Cell, target?: ArrayLike<number>): PinForce {
  const t = target ?? Array.from(cell.position);
  const f = new PinForce(cell, t);
  s.addForce(f);
  return f;
}

export function eq(s: Solver, a: Cell, b: Cell): EqForce {
  const f = new EqForce(a, b);
  s.addForce(f);
  return f;
}

export function lensNum(
  s: Solver,
  a: Cell,
  b: Cell,
  fwd: (x: number) => number,
): LensNumForce {
  const f = new LensNumForce(a, b, fwd);
  s.addForce(f);
  return f;
}

export function distance(s: Solver, a: Cell, b: Cell, rest: number): DistanceForce {
  const f = new DistanceForce(a, b, rest);
  s.addForce(f);
  return f;
}

export function spring(
  s: Solver,
  a: Cell,
  b: Cell,
  rest: number,
  stiffness: number,
): DistanceForce {
  const f = new DistanceForce(a, b, rest, false, stiffness);
  s.addForce(f);
  return f;
}

export function clamp(s: Solver, cell: Cell, lo: number, hi: number): BoundsForce {
  const f = new BoundsForce(cell, lo, hi);
  s.addForce(f);
  return f;
}

export function softTarget(
  s: Solver,
  cell: Cell,
  target: ArrayLike<number>,
  stiffness: number,
): SoftTargetForce {
  const f = new SoftTargetForce(cell, target, stiffness);
  s.addForce(f);
  return f;
}
