// constraints.ts — concrete Force subclasses (numerical kernel).
//
// Each subclass operates on cell ids (`number`) into the solver's
// SOA buffers. Subclasses read positions via `solver.positions` /
// `solver.offsets`. Constructors take `(Solver, ...cellIds, ...)`.
//
// The user-facing factory functions that accept `Signal`s live in
// `_proto-relate3/constraints.ts` (a layer above this module).
// This module is signal-free.

import { Force } from "./force";
import { Solver } from "./solver";

// ─── Strength constants ──────────────────────────────────────────────

export const Strength = {
  WEAK: 1,
  MEDIUM: 1e3,
  STRONG: 1e6,
  REQUIRED: 1e9,
  /** True hard constraint: solved via the augmented Lagrangian
   *  path rather than penalty weighting. The default for the
   *  `*Force` constructors. */
  HARD: Infinity,
} as const;

// ─── Equality between two same-dim cells ─────────────────────────────

export class EqForce extends Force {
  constructor(solver: Solver, a: number, b: number, hard = true) {
    if (solver.dims[a]! !== solver.dims[b]!) {
      throw new Error("eq: cell dims must match");
    }
    super(solver, [a, b], solver.dims[a]!);
    if (!hard) this.stiffness.fill(1e6);
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    const positions = this.solver.positions;
    const aOff = this.cellOffsets[0]!;
    const bOff = this.cellOffsets[1]!;
    for (let k = 0; k < this.rows; k++) {
      const Cn = positions[aOff + k]! - positions[bOff + k]!;
      this.C[k]! = this.stiffness[k]! === Infinity ? Cn - alpha * this.C0[k]! : Cn;
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

export class LensNumForce extends Force {
  fwd: (a: number) => number;
  private readonly fdStep: number;
  private _cachedFwdA = 0;
  private _cachedA = NaN;

  constructor(solver: Solver, a: number, b: number, fwd: (x: number) => number, fdStep = 1e-6) {
    if (solver.dims[a]! !== 1 || solver.dims[b]! !== 1) {
      throw new Error("lensNum: both cells must be Num (dim=1)");
    }
    super(solver, [a, b], 1);
    this.fwd = fwd;
    this.fdStep = fdStep;
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    const positions = this.solver.positions;
    const aOff = this.cellOffsets[0]!;
    const bOff = this.cellOffsets[1]!;
    const a = positions[aOff]!;
    const b = positions[bOff]!;
    const fa = this.fwd(a);
    this._cachedFwdA = fa;
    this._cachedA = a;
    const Cn = b - fa;
    this.C[0]! = this.stiffness[0]! === Infinity ? Cn - alpha * this.C0[0]! : Cn;
  }

  computeDerivatives(cellIdx: number): void {
    const J = this.J[cellIdx]!;
    if (cellIdx === 1) {
      J[0]! = 1.0;
      return;
    }
    const a = this._cachedA;
    const f0 = this._cachedFwdA;
    const f1 = this.fwd(a + this.fdStep);
    J[0]! = -(f1 - f0) / this.fdStep;
  }
}

// ─── Distance constraint (Vec ↔ Vec) ─────────────────────────────────

export class DistanceForce extends Force {
  rest: number;
  private _cachedNx = 0;
  private _cachedNy = 0;
  private _cachedInvD = 0;
  private _cachedDegenerate = false;

  constructor(solver: Solver, a: number, b: number, rest: number, hard = true, stiffness = 1e6) {
    if (solver.dims[a]! !== 2 || solver.dims[b]! !== 2) {
      throw new Error("distance: both cells must be Vec (dim=2)");
    }
    super(solver, [a, b], 1);
    this.rest = rest;
    if (!hard) this.stiffness.fill(stiffness);
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    const positions = this.solver.positions;
    const aOff = this.cellOffsets[0]!;
    const bOff = this.cellOffsets[1]!;
    const dx = positions[aOff]! - positions[bOff]!;
    const dy = positions[aOff + 1]! - positions[bOff + 1]!;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-24) {
      this._cachedDegenerate = true;
      this._cachedNx = 0;
      this._cachedNy = 0;
      this._cachedInvD = 0;
      const Cn = -this.rest;
      this.C[0]! = this.stiffness[0]! === Infinity ? Cn - alpha * this.C0[0]! : Cn;
      return;
    }
    const d = Math.sqrt(d2);
    const inv = 1 / d;
    this._cachedDegenerate = false;
    this._cachedNx = dx * inv;
    this._cachedNy = dy * inv;
    this._cachedInvD = inv;
    const Cn = d - this.rest;
    this.C[0]! = this.stiffness[0]! === Infinity ? Cn - alpha * this.C0[0]! : Cn;
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
    Hcols[0]! = Math.sqrt(1 - nx * nx) * inv;
    Hcols[1]! = Math.sqrt(1 - ny * ny) * inv;
  }
}

// ─── 1D bounds (clamp) ───────────────────────────────────────────────

export class BoundsForce extends Force {
  lo: number;
  hi: number;

  constructor(solver: Solver, cell: number, lo: number, hi: number) {
    if (solver.dims[cell]! !== 1) throw new Error("clamp: cell must be Num (dim=1)");
    super(solver, [cell], 2);
    this.lo = lo;
    this.hi = hi;
    this.fmax[0]! = 0;
    this.fmax[1]! = 0;
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    const positions = this.solver.positions;
    const off = this.cellOffsets[0]!;
    const x = positions[off]!;
    const c0 = x - this.lo;
    const c1 = this.hi - x;
    const stiff = this.stiffness;
    this.C[0]! = stiff[0]! === Infinity ? c0 - alpha * this.C0[0]! : c0;
    this.C[1]! = stiff[1]! === Infinity ? c1 - alpha * this.C0[1]! : c1;
  }

  computeDerivatives(_cellIdx: number): void {
    const J = this.J[0]!;
    J[0]! = 1; // row 0
    J[1]! = -1; // row 1
  }
}

// ─── Soft pull / target (any cell) ───────────────────────────────────

export class SoftTargetForce extends Force {
  target: Float64Array;

  constructor(solver: Solver, cell: number, target: ArrayLike<number>, stiffness: number) {
    const dim = solver.dims[cell]!;
    super(solver, [cell], dim);
    this.target = new Float64Array(dim);
    for (let k = 0; k < dim; k++) this.target[k]! = target[k] ?? 0;
    this.stiffness.fill(stiffness);
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(_alpha: number): void {
    const positions = this.solver.positions;
    const off = this.cellOffsets[0]!;
    const dim = this.rows;
    for (let k = 0; k < dim; k++) {
      this.C[k]! = positions[off + k]! - this.target[k]!;
    }
  }

  computeDerivatives(_cellIdx: number): void {
    const dim = this.rows;
    const J = this.J[0]!;
    for (let r = 0; r < dim; r++) {
      for (let k = 0; k < dim; k++) J[r * dim + k]! = r === k ? 1 : 0;
    }
  }
}

// ─── Generic FD-derived constraint ───────────────────────────────────
//
// User-facing extensibility hook: write the residual `C(positions)`,
// the framework FDs the Jacobian and a diagonal-lump Hessian. ~3×
// residual evals per DOF per iteration vs hand-derived; correct-by-
// construction for any smooth residual.

export type ResidualFn = (
  /** Positions of the cells, in order. Each entry is a `Float64Array`
   *  snapshot of the cell's value (not a live view) — read-only
   *  within the function. */
  positions: readonly Float64Array[],
  /** Output buffer of length `rows`. Write residual values here;
   *  zero means satisfied. */
  out: Float64Array,
) => void;

export class GenericForce extends Force {
  private fn: ResidualFn;
  private fdStep: number;
  private _fdPositions: Float64Array[];
  private _fdRawBase: Float64Array;
  private _fdScratchPlus: Float64Array;
  private _fdScratchMinus: Float64Array;

  constructor(
    solver: Solver,
    cells: readonly number[],
    rows: number,
    fn: ResidualFn,
    opts: { fdStep?: number; hard?: boolean; stiffness?: number } = {},
  ) {
    super(solver, cells, rows);
    this.fn = fn;
    this.fdStep = opts.fdStep ?? 1e-6;
    this._fdScratchPlus = new Float64Array(rows);
    this._fdScratchMinus = new Float64Array(rows);
    this._fdRawBase = new Float64Array(rows);
    this._fdPositions = this.cellDims.map(d => new Float64Array(d));
    if (opts.hard === false) this.stiffness.fill(opts.stiffness ?? 1e6);
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    // Snapshot cell positions into our scratch.
    const positions = this.solver.positions;
    const offsets = this.cellOffsets;
    const dims = this.cellDims;
    for (let i = 0; i < this.cells.length; i++) {
      const off = offsets[i]!;
      const dim = dims[i]!;
      const into = this._fdPositions[i]!;
      for (let k = 0; k < dim; k++) into[k]! = positions[off + k]!;
    }
    this.fn(this._fdPositions, this._fdRawBase);
    const stiff = this.stiffness;
    for (let r = 0; r < this.rows; r++) {
      const raw = this._fdRawBase[r]!;
      this.C[r]! = stiff[r]! === Infinity ? raw - alpha * this.C0[r]! : raw;
    }
  }

  computeDerivatives(cellIdx: number): void {
    const dim = this.cellDims[cellIdx]!;
    const J = this.J[cellIdx]!;
    const Hcols = this.HCols[cellIdx]!;
    const baseRaw = this._fdRawBase;
    const Cplus = this._fdScratchPlus;
    const Cminus = this._fdScratchMinus;
    const fdPos = this._fdPositions[cellIdx]!;
    const h = this.fdStep;
    const invH = 1 / h;
    const invH2 = 1 / (h * h);
    for (let k = 0; k < dim; k++) {
      const saved = fdPos[k]!;
      fdPos[k]! = saved + h;
      this.fn(this._fdPositions, Cplus);
      fdPos[k]! = saved - h;
      this.fn(this._fdPositions, Cminus);
      fdPos[k]! = saved;
      for (let r = 0; r < this.rows; r++) {
        J[r * dim + k]! = (Cplus[r]! - baseRaw[r]!) * invH;
        const d2 = (Cplus[r]! - 2 * baseRaw[r]! + Cminus[r]!) * invH2;
        Hcols[r * dim + k]! = d2 < 0 ? -d2 : d2;
      }
    }
  }
}

