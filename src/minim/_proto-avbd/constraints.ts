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

import type { Signal } from "../signals";
import { Cell, NumCell } from "./cell";
import { Force } from "./force";
import { asCell } from "./reactive";
import { Solver } from "./solver";

/** A cell-or-signal; constraint factories accept either. Signals
 *  are auto-bound to the solver via `asCell`, with their typed
 *  values mirrored into a backing `Cell`. */
export type Bindable = Cell | Signal<unknown>;

// ─── Strength constants ──────────────────────────────────────────────
//
// Conventional weight values for soft constraints. Use as
// `s.spring(a, b, 1, Strength.MEDIUM)`. Values outside this scale
// also work; the constants are reading aids.
//
// AVBD's hard constraints are infinite-stiffness (use `Infinity` or
// the `distance`/`eq`/`bounded` factories which default to hard).

export const Strength = {
  WEAK: 1,
  MEDIUM: 1e3,
  STRONG: 1e6,
  REQUIRED: 1e9,
  /** True hard constraint: solved via the augmented Lagrangian path
   *  rather than penalty weighting. The default for `eq`, `distance`,
   *  `bounded`, `lensNum`, etc. */
  HARD: Infinity,
} as const;

// ─── Pinning ─────────────────────────────────────────────────────────
//
// To fix a cell at a position, set `cell.mass = 0` and write the
// desired value to `cell.position` directly:
//
//   const p = vec(3, 4);
//   p.mass = 0;
//
// The cell's primal update is skipped each step. This is the
// canonical "pin" mechanism. We deliberately don't expose a
// PinForce subclass — that was a redundant second way to do this
// with subtly different semantics.

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
// Both cells must have dim = 1. For Vec→Vec or higher-dimensional
// lenses, use `generic` with a custom residual function (or write
// a hand-derived Force subclass for speed).
//
// AVBD's augmented Lagrangian formulation handles bidirectional
// solving naturally: pin a, b derives via dual-driven Newton; pin
// b, a derives the same way. No explicit `bwd` is required.

export class LensNumForce extends Force {
  fwd: (a: number) => number;
  private readonly fdStep: number;
  // Cached `fwd(a)` from `computeConstraint` so `computeDerivatives`
  // doesn't have to call `fwd` again. Avoids two evaluations per
  // iteration (matters for user `fwd` functions that allocate or
  // do non-trivial work).
  private _cachedFwdA = 0;
  private _cachedA = NaN;

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
    const fa = this.fwd(a);
    this._cachedFwdA = fa;
    this._cachedA = a;
    const Cn = b - fa;
    this.C[0]! = this.isHard(0) ? Cn - alpha * this.C0[0]! : Cn;
  }

  computeDerivatives(cellIdx: number): void {
    const J = this.J[cellIdx]!;
    if (cellIdx === 1) {
      J[0]! = 1.0;
      return;
    }
    // ∂C / ∂a = -fwd'(a). Forward difference, reusing fwd(a) cached
    // from `computeConstraint`. We only re-evaluate fwd at the
    // perturbed point.
    const a = this._cachedA;
    const f0 = this._cachedFwdA;
    const f1 = this.fwd(a + this.fdStep);
    J[0]! = -(f1 - f0) / this.fdStep;
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

// ─── Generic FD-derived constraint (correct-by-construction) ─────────
//
// The user-extensibility frontier. To define a new constraint, you
// only write the residual function `C(positions) → number[]`. The
// framework computes the Jacobian via finite difference and uses
// the diagonal-lumped approximate Hessian (treat the second-derivative
// term as zero, which is fine for many constraints — see below).
//
// Trade-off: each derivative evaluation costs an extra residual
// call per cell DOF, so this is ~2× to ~5× slower per iteration
// than a hand-derived constraint. Use it for prototyping, niche
// constraints, or anything where you don't want to derive
// Jacobians by hand. Once a constraint stabilises into the library,
// hand-derive its J/H for the speed.
//
// The "diagonal Hessian = 0" choice is the safe default. The full
// geometric stiffness term in AVBD (paper §3.5) accelerates
// convergence in some cases but introduces no instability when
// omitted (it's just additional preconditioning). For new
// constraints, omitting it is correct-by-construction.

export type ResidualFn = (
  /** Positions of the cells, in order. Each entry is an
   *  ArrayLike for the cell's DOF — read-only within the function. */
  positions: readonly Float64Array[],
  /** Output array of length `m` (rows). Write residual values
   *  here; zero means satisfied. */
  out: Float64Array,
) => void;

export class GenericForce extends Force {
  private fn: ResidualFn;
  private fdStep: number;
  // Scratch buffers: `_fdPositions` snapshots cell positions (so
  // we can perturb without touching the cells), `_fdRawBase` holds
  // the un-stabilised base residual (FD math needs this — the
  // public `C` field carries the alpha-stabilised version), and
  // `_fdScratch` holds the perturbed residual.
  private _fdPositions: Float64Array[];
  private _fdRawBase: Float64Array;
  private _fdScratch: Float64Array;

  constructor(
    cells: readonly Cell[],
    rows: number,
    fn: ResidualFn,
    opts: { fdStep?: number; hard?: boolean; stiffness?: number } = {},
  ) {
    super(cells, rows);
    this.fn = fn;
    this.fdStep = opts.fdStep ?? 1e-6;
    this._fdScratch = new Float64Array(rows);
    this._fdRawBase = new Float64Array(rows);
    this._fdPositions = cells.map(c => new Float64Array(c.dim));
    if (opts.hard === false) {
      this.stiffness.fill(opts.stiffness ?? 1e6);
      this.refreshHardFlags();
    }
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    // Snapshot cell positions into our scratch.
    for (let i = 0; i < this.cells.length; i++) {
      const cellPos = this.cells[i]!.position;
      const into = this._fdPositions[i]!;
      for (let k = 0; k < this.cells[i]!.dim; k++) into[k]! = cellPos[k]!;
    }
    // Raw residual (no stabilisation) — cached for FD use.
    this.fn(this._fdPositions, this._fdRawBase);
    // Public C: with stabilisation if applicable.
    for (let r = 0; r < this.rows; r++) {
      const raw = this._fdRawBase[r]!;
      this.C[r]! = this.hard[r] === 1 ? raw - alpha * this.C0[r]! : raw;
    }
  }

  computeDerivatives(cellIdx: number): void {
    // Both Jacobian (first derivative) AND a diagonal-lump
    // Hessian estimate (second derivative) by central differences.
    //
    // We need the Hessian to stabilise the local Newton system —
    // without it, configurations where the Jacobian is rank-
    // deficient (e.g., a chain in a collinear pose, where the
    // distance constraint's gradient has zero perpendicular
    // component) cause the local solve to take wild steps as
    // penalties ramp up.
    //
    // The diagonal-lump approximation matches AVBD's strategy
    // (paper §3.5, Eq. 17) where the geometric stiffness term is
    // diagonalised. The exact value at element k is
    //   ∂²C_r / ∂x_{cell,k}² ≈ (C(x+h·e_k) − 2 C(x) + C(x−h·e_k)) / h²
    //
    // Cost: 2 residual evaluations per DOF (one forward, one
    // backward), plus the existing forward eval for the Jacobian.
    // So 3·dim residual calls per `computeDerivatives` versus 1·dim
    // for the Jacobian-only version.
    const cell = this.cells[cellIdx]!;
    const dim = cell.dim;
    const J = this.J[cellIdx]!;
    const Hcols = this.HCols[cellIdx]!;
    const baseRaw = this._fdRawBase;
    const Cplus = this._fdScratch;
    const Cminus = (this._fdScratch2 ??= new Float64Array(this.rows));
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
        // First derivative (forward diff for symmetry with handcoded).
        J[r * dim + k]! = (Cplus[r]! - baseRaw[r]!) * invH;
        // Second derivative: |∂²C/∂x_k²| via central diff. We
        // store its absolute magnitude (the geometric stiffness is
        // multiplied by |force| in the solver, so sign cancels).
        const d2 = (Cplus[r]! - 2 * baseRaw[r]! + Cminus[r]!) * invH2;
        Hcols[r * dim + k]! = d2 < 0 ? -d2 : d2;
      }
    }
  }
}

// Second scratch buffer for central-difference Hessian.
declare module "./constraints" {
  interface GenericForce {
    _fdScratch2?: Float64Array;
  }
}

// ─── User-facing factories ───────────────────────────────────────────
//
// Each registers the force with the solver and returns the force
// instance. Mutating the returned force (e.g., `f.fmin[0] = ...`)
// adjusts behaviour for the next step.

export function eq(s: Solver, a: Bindable, b: Bindable): EqForce {
  const f = new EqForce(asCell(s, a), asCell(s, b));
  s.addForce(f);
  return f;
}

export function lensNum(
  s: Solver,
  a: Bindable,
  b: Bindable,
  fwd: (x: number) => number,
): LensNumForce {
  const f = new LensNumForce(asCell(s, a), asCell(s, b), fwd);
  s.addForce(f);
  return f;
}

export function distance(s: Solver, a: Bindable, b: Bindable, rest: number): DistanceForce {
  const f = new DistanceForce(asCell(s, a), asCell(s, b), rest);
  s.addForce(f);
  return f;
}

export function spring(
  s: Solver,
  a: Bindable,
  b: Bindable,
  rest: number,
  stiffness: number,
): DistanceForce {
  const f = new DistanceForce(asCell(s, a), asCell(s, b), rest, false, stiffness);
  s.addForce(f);
  return f;
}

/** 1D range constraint: `lo ≤ x ≤ hi`. Hard by default. Synonym
 *  for the older `clamp` name. */
export function bounded(s: Solver, x: NumCell | Bindable, lo: number, hi: number): BoundsForce {
  return clamp(s, x, lo, hi);
}

export function clamp(s: Solver, cell: Bindable, lo: number, hi: number): BoundsForce {
  const f = new BoundsForce(asCell(s, cell), lo, hi);
  s.addForce(f);
  return f;
}

/** Hard inequality `a ≤ b` between two scalar cells.
 *
 *  Encoded as the feasibility residual `C = b − a ≥ 0`, with the
 *  multiplier clamped to `λ ≤ 0` (`fmax = 0`). When `a > b`, the
 *  dual builds up negative magnitude and pushes `a` down / `b` up.
 *  When feasible, the dual saturates at zero → zero force. */
export function leq(s: Solver, a: Bindable, b: Bindable): GenericForce {
  const f = generic(s, [asCell(s, a), asCell(s, b)], 1, (pos, out) => {
    out[0]! = pos[1]![0]! - pos[0]![0]!;
  });
  f.fmax[0]! = 0;
  return f;
}

/** Hard inequality `a ≥ b` (symmetric of `leq`). */
export function geq(s: Solver, a: Bindable, b: Bindable): GenericForce {
  return leq(s, b, a);
}

export function softTarget(
  s: Solver,
  cell: Bindable,
  target: ArrayLike<number>,
  stiffness: number,
): SoftTargetForce {
  const f = new SoftTargetForce(asCell(s, cell), target, stiffness);
  s.addForce(f);
  return f;
}

/** General-purpose constraint factory: write the residual function,
 *  framework handles derivatives via finite difference. Slower per
 *  iteration than hand-derived primitives (roughly 2-5× per cell-DOF)
 *  but trivially correct. Use for prototyping or one-off constraints. */
export function generic(
  s: Solver,
  cells: readonly Bindable[],
  rows: number,
  fn: ResidualFn,
  opts?: { fdStep?: number; hard?: boolean; stiffness?: number },
): GenericForce {
  const f = new GenericForce(cells.map(c => asCell(s, c)), rows, fn, opts);
  s.addForce(f);
  return f;
}

// ─── Sketchpad primitives via `generic` ──────────────────────────────
//
// These are 1-2 line constraint definitions on top of the FD framework.
// Hand-derived versions would be faster, but these are correct out of
// the box and demonstrate end-user extensibility.

/** Interior angle ABC = θ. Three points + a target angle. */
export function angle(s: Solver, A: Bindable, B: Bindable, C: Bindable, theta: number): GenericForce {
  return generic(s, [A, B, C], 1, (pos, out) => {
    const a = pos[0]!,
      b = pos[1]!,
      c = pos[2]!;
    const ux = a[0]! - b[0]!,
      uy = a[1]! - b[1]!;
    const vx = c[0]! - b[0]!,
      vy = c[1]! - b[1]!;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1e-12 || lv < 1e-12) {
      out[0]! = 0;
      return;
    }
    const cosA = (ux * vx + uy * vy) / (lu * lv);
    const cur = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
    out[0]! = cur - theta;
  });
}

/** Lines AB and CD parallel: cross product of direction vectors = 0. */
export function parallel(
  s: Solver,
  A: Bindable,
  B: Bindable,
  C: Bindable,
  D: Bindable,
): GenericForce {
  return generic(s, [A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!,
      b = pos[1]!,
      c = pos[2]!,
      d = pos[3]!;
    const ux = b[0]! - a[0]!,
      uy = b[1]! - a[1]!;
    const vx = d[0]! - c[0]!,
      vy = d[1]! - c[1]!;
    out[0]! = ux * vy - uy * vx; // = |u||v|sin(θ)
  });
}

/** Lines AB and CD perpendicular: dot product = 0. */
export function perpendicular(
  s: Solver,
  A: Bindable,
  B: Bindable,
  C: Bindable,
  D: Bindable,
): GenericForce {
  return generic(s, [A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!,
      b = pos[1]!,
      c = pos[2]!,
      d = pos[3]!;
    const ux = b[0]! - a[0]!,
      uy = b[1]! - a[1]!;
    const vx = d[0]! - c[0]!,
      vy = d[1]! - c[1]!;
    out[0]! = ux * vx + uy * vy;
  });
}

/** Point P collinear with A and B (P on line through A, B): cross = 0. */
export function collinear(s: Solver, P: Bindable, A: Bindable, B: Bindable): GenericForce {
  return generic(s, [P, A, B], 1, (pos, out) => {
    const p = pos[0]!,
      a = pos[1]!,
      b = pos[2]!;
    const ux = p[0]! - a[0]!,
      uy = p[1]! - a[1]!;
    const vx = b[0]! - a[0]!,
      vy = b[1]! - a[1]!;
    out[0]! = ux * vy - uy * vx;
  });
}

/** Point P on a circle: |P - center| = radius. Center is a cell;
 *  radius is a constant (use a Num cell + extra constraint if you
 *  need a reactive radius). */
export function onCircle(
  s: Solver,
  P: Bindable,
  center: Bindable,
  radius: number,
): GenericForce {
  return generic(s, [P, center], 1, (pos, out) => {
    const p = pos[0]!,
      c = pos[1]!;
    const dx = p[0]! - c[0]!,
      dy = p[1]! - c[1]!;
    out[0]! = Math.hypot(dx, dy) - radius;
  });
}

/** Equal distance: |AB| = |CD|. */
export function equalDist(
  s: Solver,
  A: Bindable,
  B: Bindable,
  C: Bindable,
  D: Bindable,
): GenericForce {
  return generic(s, [A, B, C, D], 1, (pos, out) => {
    const a = pos[0]!,
      b = pos[1]!,
      c = pos[2]!,
      d = pos[3]!;
    const ab = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
    const cd = Math.hypot(c[0]! - d[0]!, c[1]! - d[1]!);
    out[0]! = ab - cd;
  });
}

/** Midpoint: M = (A + B) / 2 → 2M - A - B = 0 (per axis). */
export function midpoint(s: Solver, M: Bindable, A: Bindable, B: Bindable): GenericForce {
  return generic(s, [M, A, B], 2, (pos, out) => {
    const m = pos[0]!,
      a = pos[1]!,
      b = pos[2]!;
    out[0]! = 2 * m[0]! - a[0]! - b[0]!;
    out[1]! = 2 * m[1]! - a[1]! - b[1]!;
  });
}
