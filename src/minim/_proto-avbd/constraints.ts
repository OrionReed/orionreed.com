// constraints.ts — concrete Force subclasses + user-facing factories.
//
// Each subclass operates on cell **ids** (`number`) into the solver's
// SOA buffers. Subclasses read positions via `solver.positions` /
// `solver.offsets`. The user-facing factories accept reactive
// `Signal`s and bind them through `solver.bind()`; tests or low-
// level callers that already have cell ids can construct the
// Force subclass directly.

import { type Signal } from "../signals";
import { Force } from "./force";
import { Solver } from "./solver";

// ─── Strength constants ──────────────────────────────────────────────
//
// Conventional weight values for soft constraints. Use as
// `s.spring(a, b, 1, Strength.MEDIUM)`. Values outside this scale
// also work; the constants are reading aids.

export const Strength = {
  WEAK: 1,
  MEDIUM: 1e3,
  STRONG: 1e6,
  REQUIRED: 1e9,
  /** True hard constraint: solved via the augmented Lagrangian
   *  path rather than penalty weighting. The default for `eq`,
   *  `distance`, `bounded`, `lensNum`, etc. */
  HARD: Infinity,
} as const;

// ─── Pinning ─────────────────────────────────────────────────────────
//
// To fix a cell at a position, set its mass to 0 and write the
// desired value:
//
//   const a = vec(3, 4);
//   const aId = s.bind(a);
//   s.setMass(aId, 0);
//
// or use the reactive `pin(sig)` helper which does this for you.

/** A signal accepted by the constraint factories. Typed as
 *  `Signal<any>` because TypeScript treats `Signal<T>.setter` as
 *  contravariant in `T`; concrete `Writable<Num>` etc. don't
 *  structurally match `Signal<unknown>`. The runtime contract is
 *  "a signal whose class declares the `pack` trait." */
// biome-ignore lint/suspicious/noExplicitAny: variance escape; runtime contract is "Signal carrying pack trait"
export type Bindable = Signal<any>;

// ─── Equality between two same-dim cells ─────────────────────────────

export class EqForce extends Force {
  constructor(solver: Solver, a: number, b: number, hard = true) {
    if (solver.dims[a]! !== solver.dims[b]!) {
      throw new Error("eq: cell dims must match");
    }
    super(solver, [a, b], solver.dims[a]!);
    if (!hard) {
      this.stiffness.fill(1e6);
      this.refreshHardFlags();
    }
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    const positions = this.solver.positions;
    const aOff = this.solver.offsets[this.cells[0]!]!;
    const bOff = this.solver.offsets[this.cells[1]!]!;
    for (let k = 0; k < this.rows; k++) {
      const Cn = positions[aOff + k]! - positions[bOff + k]!;
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
    const aOff = this.solver.offsets[this.cells[0]!]!;
    const bOff = this.solver.offsets[this.cells[1]!]!;
    const a = positions[aOff]!;
    const b = positions[bOff]!;
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
    if (!hard) {
      this.stiffness.fill(stiffness);
      this.refreshHardFlags();
    }
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(alpha: number): void {
    const positions = this.solver.positions;
    const aOff = this.solver.offsets[this.cells[0]!]!;
    const bOff = this.solver.offsets[this.cells[1]!]!;
    const dx = positions[aOff]! - positions[bOff]!;
    const dy = positions[aOff + 1]! - positions[bOff + 1]!;
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
    const off = this.solver.offsets[this.cells[0]!]!;
    const x = positions[off]!;
    const c0 = x - this.lo;
    const c1 = this.hi - x;
    this.C[0]! = this.isHard(0) ? c0 - alpha * this.C0[0]! : c0;
    this.C[1]! = this.isHard(1) ? c1 - alpha * this.C0[1]! : c1;
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
    this.refreshHardFlags();
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(_alpha: number): void {
    const positions = this.solver.positions;
    const off = this.solver.offsets[this.cells[0]!]!;
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
    this._fdPositions = cells.map(id => new Float64Array(solver.dims[id]!));
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
    const positions = this.solver.positions;
    const offsets = this.solver.offsets;
    const dims = this.solver.dims;
    for (let i = 0; i < this.cells.length; i++) {
      const id = this.cells[i]!;
      const off = offsets[id]!;
      const dim = dims[id]!;
      const into = this._fdPositions[i]!;
      for (let k = 0; k < dim; k++) into[k]! = positions[off + k]!;
    }
    this.fn(this._fdPositions, this._fdRawBase);
    for (let r = 0; r < this.rows; r++) {
      const raw = this._fdRawBase[r]!;
      this.C[r]! = this.hard[r] === 1 ? raw - alpha * this.C0[r]! : raw;
    }
  }

  computeDerivatives(cellIdx: number): void {
    const id = this.cells[cellIdx]!;
    const dim = this.solver.dims[id]!;
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

// ─── User-facing factories (signal-driven) ──────────────────────────

export function eq(s: Solver, a: Bindable, b: Bindable): EqForce {
  const f = new EqForce(s, s.bind(a), s.bind(b));
  s.addForce(f);
  return f;
}

export function lensNum(
  s: Solver,
  a: Bindable,
  b: Bindable,
  fwd: (x: number) => number,
): LensNumForce {
  const f = new LensNumForce(s, s.bind(a), s.bind(b), fwd);
  s.addForce(f);
  return f;
}

export function distance(s: Solver, a: Bindable, b: Bindable, rest: number): DistanceForce {
  const f = new DistanceForce(s, s.bind(a), s.bind(b), rest);
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
  const f = new DistanceForce(s, s.bind(a), s.bind(b), rest, false, stiffness);
  s.addForce(f);
  return f;
}

/** 1D range constraint: `lo ≤ x ≤ hi`. Hard by default. */
export function clamp(s: Solver, x: Bindable, lo: number, hi: number): BoundsForce {
  const f = new BoundsForce(s, s.bind(x), lo, hi);
  s.addForce(f);
  return f;
}

/** Synonym for `clamp`. */
export function bounded(s: Solver, x: Bindable, lo: number, hi: number): BoundsForce {
  return clamp(s, x, lo, hi);
}

/** Hard inequality `a ≤ b` between two scalar cells. */
export function leq(s: Solver, a: Bindable, b: Bindable): GenericForce {
  const f = generic(s, [a, b], 1, (pos, out) => {
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
  const f = new SoftTargetForce(s, s.bind(cell), target, stiffness);
  s.addForce(f);
  return f;
}

/** General-purpose FD constraint factory. */
export function generic(
  s: Solver,
  cells: readonly Bindable[],
  rows: number,
  fn: ResidualFn,
  opts?: { fdStep?: number; hard?: boolean; stiffness?: number },
): GenericForce {
  const f = new GenericForce(s, cells.map(c => s.bind(c)), rows, fn, opts);
  s.addForce(f);
  return f;
}

// ─── Sketchpad primitives via `generic` ──────────────────────────────

/** Interior angle ABC = θ. */
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
    out[0]! = ux * vy - uy * vx;
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

/** Point P collinear with line AB: cross product = 0. */
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

/** Point P on a circle of given center and radius. */
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

/** Midpoint: M = (A + B) / 2. */
export function midpoint(s: Solver, M: Bindable, A: Bindable, B: Bindable): GenericForce {
  return generic(s, [M, A, B], 2, (pos, out) => {
    const m = pos[0]!,
      a = pos[1]!,
      b = pos[2]!;
    out[0]! = 2 * m[0]! - a[0]! - b[0]!;
    out[1]! = 2 * m[1]! - a[1]! - b[1]!;
  });
}
