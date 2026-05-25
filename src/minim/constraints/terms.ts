// terms.ts — concrete `Term` subclasses (numerical kernel).
//
// Each subclass operates on cell ids into the solver's SOA buffers.
// Subclasses read positions via `solver.positions` / `solver.offsets`,
// and write Jacobian / Hessian column norms into `J[ci]` / `HCols[ci]`.
//
// **Mutable parameters via signals.** Numeric parameters that the
// user might want to mutate (rest lengths, bounds, target stiffness,
// …) are stored as `Signal<number>` and *cached* in `initialize()`
// — which the AVBD outer loop calls once per `solver.solve()`. The
// inner per-iteration computeConstraint/computeDerivatives methods
// use the cached primitive, so the inner loop stays signal-free
// (no `.value` reads, no subscription bookkeeping, identical perf
// to the previous fixed-number form).
//
// Subscription happens at the cluster layer: `Constraints`'s network
// body reads each relation's members (including param signals) so
// mutating `r.rest.value = 50` triggers a re-solve via the normal
// reactive flow. The term then peeks the new value when
// `initialize()` runs.

import { type Signal, type Writable } from "../signals";
import { param } from "../signals/network-utils";
import { Solver } from "./solver";
import { Term } from "./term";

// ─── Strength constants ──────────────────────────────────────────────

export const Strength = {
  WEAK: 1,
  MEDIUM: 1e3,
  STRONG: 1e6,
  REQUIRED: 1e9,
  /** True hard constraint: solved via the augmented Lagrangian
   *  path rather than penalty weighting. The default for the
   *  `*Term` constructors. */
  HARD: Infinity,
} as const;

// ─── Equality between two same-dim cells ─────────────────────────────

export class EqTerm extends Term {
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

export class LensNumTerm extends Term {
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

export class DistanceTerm extends Term {
  /** Rest-length signal. Cached once per `solver.solve()` in
   *  `initialize()` — the inner loop reads only the primitive. */
  readonly rest: Signal<number>;
  /** Optional mutable stiffness signal (only set when `hard=false`). */
  readonly stiffnessSig?: Signal<number>;
  private _restCached = 0;
  private _cachedNx = 0;
  private _cachedNy = 0;
  private _cachedInvD = 0;
  private _cachedDegenerate = false;

  constructor(
    solver: Solver,
    a: number,
    b: number,
    rest: number | Writable<Signal<number>>,
    hard = true,
    stiffness?: number | Writable<Signal<number>>,
  ) {
    if (solver.dims[a]! !== 2 || solver.dims[b]! !== 2) {
      throw new Error("distance: both cells must be Vec (dim=2)");
    }
    super(solver, [a, b], 1);
    this.rest = param(rest);
    this._restCached = this.rest.peek();
    if (!hard) {
      this.stiffnessSig = param(stiffness ?? 1e6);
      this.stiffness.fill(this.stiffnessSig.peek());
    }
  }

  initialize(): boolean {
    // `.value` (not `.peek()`) — runs inside the cluster's network
    // body where `activeNetwork` is set, so the read both refreshes
    // the cache AND subscribes the network to this param signal.
    // Mutations to `rest` then trigger normal re-fire via the
    // signal DAG. The inner per-iteration loop reads the cached
    // primitive only — no signals on the hot path.
    this._restCached = this.rest.value;
    if (this.stiffnessSig !== undefined) {
      const k = this.stiffnessSig.value;
      this.stiffness[0]! = k;
    }
    return true;
  }

  computeConstraint(alpha: number): void {
    const positions = this.solver.positions;
    const aOff = this.cellOffsets[0]!;
    const bOff = this.cellOffsets[1]!;
    const dx = positions[aOff]! - positions[bOff]!;
    const dy = positions[aOff + 1]! - positions[bOff + 1]!;
    const d2 = dx * dx + dy * dy;
    const restCached = this._restCached;
    if (d2 < 1e-24) {
      this._cachedDegenerate = true;
      this._cachedNx = 0;
      this._cachedNy = 0;
      this._cachedInvD = 0;
      const Cn = -restCached;
      this.C[0]! = this.stiffness[0]! === Infinity ? Cn - alpha * this.C0[0]! : Cn;
      return;
    }
    const d = Math.sqrt(d2);
    const inv = 1 / d;
    this._cachedDegenerate = false;
    this._cachedNx = dx * inv;
    this._cachedNy = dy * inv;
    this._cachedInvD = inv;
    const Cn = d - restCached;
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

export class BoundsTerm extends Term {
  readonly lo: Signal<number>;
  readonly hi: Signal<number>;
  private _loCached = 0;
  private _hiCached = 0;

  constructor(
    solver: Solver,
    cell: number,
    lo: number | Writable<Signal<number>>,
    hi: number | Writable<Signal<number>>,
  ) {
    if (solver.dims[cell]! !== 1) throw new Error("clamp: cell must be Num (dim=1)");
    super(solver, [cell], 2);
    this.lo = param(lo);
    this.hi = param(hi);
    this._loCached = this.lo.peek();
    this._hiCached = this.hi.peek();
    this.lambdaMax[0]! = 0;
    this.lambdaMax[1]! = 0;
  }

  initialize(): boolean {
    // `.value` to subscribe + refresh cache; see DistanceTerm note.
    this._loCached = this.lo.value;
    this._hiCached = this.hi.value;
    return true;
  }

  computeConstraint(alpha: number): void {
    const positions = this.solver.positions;
    const off = this.cellOffsets[0]!;
    const x = positions[off]!;
    const c0 = x - this._loCached;
    const c1 = this._hiCached - x;
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

export class SoftTargetTerm extends Term {
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

export class GenericTerm extends Term {
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
