// solver.ts — Augmented Vertex Block Descent (AVBD) numerical kernel.
//
// SOA layout: per-cell state in packed Float64/Uint buffers indexed
// by integer cell id. No per-cell allocation; the hot loop streams
// contiguous memory.
//
// Cell-free. Cells are integer handles from `addCell`; terms read
// positions via `positions[offsets[id] + k]`. Reactive integration
// layers on top in `cluster.ts`; physics factories (`physics`,
// `world`) mutate `anchors` between `prepare()` and `solve(dt)`.
//
// Core problem: given anchor `y` and constraints, find `x` near `y`
// (weighted by `M/dt²`) that satisfies them. The math is generic, not
// physics-specific:
//   - `y` (anchors): regularizer reference. Physics: inertial
//     extrapolation; sketchpad/IK: `x⁻`; Adam: `x − lr·m̂/√v̂`.
//   - `M` (masses): per-DOF anchor weight. Physics: inertia; layout:
//     stickiness; Adam: `1/√v̂` preconditioner.
//   - `dt`: regularizer-vs-constraints scale. dt → 0: hard projection;
//     dt → ∞: stay-put.

import { clamp, solveSPD } from "./linalg";
import { LAMBDA_MAX, PENALTY_MAX, PENALTY_MIN, type Term } from "./term";

export interface SolverOpts {
  /** Primal+dual iterations per solve. Default 10. */
  iterations?: number;
  /** Stabilisation α ∈ [0, 1]. With `postStabilize` off: applied
   *  every iteration as `C(x) − α·C(x⁻)` and as the λ warm-start
   *  factor `α·γ`. With it on: regular iters force α = 1 and the
   *  post-stab iter uses α = 0, but the field still controls
   *  inter-frame λ decay. Paper: `0.99` physics, `0` static. */
  alpha?: number;
  /** Penalty ramp β. Default 1e5. */
  beta?: number;
  /** Warm-start decay γ ∈ [0, 1). Default 0.99. */
  gamma?: number;
  /** Run a final primal-only `α = 0` iteration per `solve(dt)` (and
   *  force `α = 1` on the regular iters — drift-tolerant: λ still
   *  grows when violated but the primal step doesn't unwind existing
   *  residual). AVBD's physics default. Default `false` so static
   *  `solve()` keeps its iter-N Newton behaviour. */
  postStabilize?: boolean;
  /** Initial buffer capacity in scalar slots; doubles on demand.
   *  Default 64. */
  initialCapacity?: number;
}

const TINY = 1e-14;

/** O(1) remove-by-swap; does not preserve element ordering. */
function swapPop<T>(arr: T[], idx: number): void {
  if (idx < 0 || idx >= arr.length) return;
  const last = arr.length - 1;
  if (idx !== last) arr[idx] = arr[last]!;
  arr.pop();
}

export class Solver {
  iterations: number;
  alpha: number;
  beta: number;
  gamma: number;
  postStabilize: boolean;

  // ─── Per-cell SOA state ──────────────────────────────────────────
  /** Packed positions; `positions[offsets[id] + k]` is component k
   *  of cell `id`. */
  positions: Float64Array;
  /** Positions at start of step (`x⁻`). */
  initials: Float64Array;
  /** Anchor positions (`y`) the regularizer pulls toward. Defaults to
   *  `initials` after `prepare()`; integrating factories overwrite
   *  before `solve(dt)`. */
  anchors: Float64Array;
  /** Anchor weight per scalar slot (mass/inertia, stickiness, or
   *  preconditioner). Slot-0 `0` means pinned (primal update skipped).
   *  Set via `setMass` (uniform) or `setMassDiag` (per-DOF). */
  masses: Float64Array;
  /** Per-cell dim (Uint8). */
  dims: Uint8Array;
  /** Start of each cell in `positions` (cumulative `dims`, Uint32). */
  offsets: Uint32Array;

  // ─── Adjacency ───────────────────────────────────────────────────
  /** Per-cell incident terms. */
  cellTerms: Term[][] = [];
  /** `cellTermIdx[id][k]` = this cell's index within
   *  `cellTerms[id][k].cells`; avoids an `indexOf` per visit. */
  cellTermIdx: number[][] = [];

  // ─── Terms ───────────────────────────────────────────────────────
  private readonly _terms: Term[] = [];
  /** Read-only view of registered terms. */
  get terms(): readonly Term[] {
    return this._terms;
  }

  // ─── Internal ────────────────────────────────────────────────────
  private _capacity: number; // current buffer length in scalar slots
  private _totalDof = 0; // current used scalar slots
  private _cellCount = 0;
  private _maxDim = 0;
  private _lhs = new Float64Array(0); // dim×dim local Newton scratch
  private _rhs = new Float64Array(0);

  /** Number of cells currently registered. */
  get cellCount(): number {
    return this._cellCount;
  }

  constructor(opts: SolverOpts = {}) {
    this.iterations = opts.iterations ?? 10;
    this.alpha = opts.alpha ?? 0;
    this.beta = opts.beta ?? 1e5;
    this.gamma = opts.gamma ?? 0.99;
    this.postStabilize = opts.postStabilize ?? false;
    const cap = opts.initialCapacity ?? 64;
    this._capacity = cap;
    this.positions = new Float64Array(cap);
    this.initials = new Float64Array(cap);
    this.anchors = new Float64Array(cap);
    // Per-DOF mass — same length as positions/initials/anchors.
    this.masses = new Float64Array(cap);
    // dims/offsets are per-cell.
    this.dims = new Uint8Array(16);
    this.offsets = new Uint32Array(16);
  }

  /** Add a cell with the given dim. Optionally seed initial value
   *  via `init`. Returns the cell's integer id. */
  addCell(dim: number, init?: ArrayLike<number>): number {
    const id = this._cellCount;
    if (id >= this.dims.length) this._growCellArrays();
    if (this._totalDof + dim > this._capacity) this._growScalarBuffers(dim);

    const off = this._totalDof;
    this.dims[id] = dim;
    this.offsets[id] = off;
    for (let k = 0; k < dim; k++) {
      const v = init?.[k] ?? 0;
      this.positions[off + k] = v;
      this.initials[off + k] = v;
      this.anchors[off + k] = v;
      this.masses[off + k] = 1;
    }
    this._totalDof += dim;
    this._cellCount++;
    this.cellTerms.push([]);
    this.cellTermIdx.push([]);

    if (dim > this._maxDim) {
      this._maxDim = dim;
      this._lhs = new Float64Array(dim * dim);
      this._rhs = new Float64Array(dim);
    }
    return id;
  }

  addTerm(term: Term): void {
    this._terms.push(term);
  }

  removeTerm(term: Term): void {
    swapPop(this._terms, this._terms.indexOf(term));
    const cells = term.cells;
    for (let ci = 0; ci < cells.length; ci++) {
      const cid = cells[ci]!;
      const list = this.cellTerms[cid]!;
      const idxList = this.cellTermIdx[cid]!;
      const k = list.indexOf(term);
      if (k < 0) continue;
      swapPop(list, k);
      swapPop(idxList, k);
    }
  }

  /** @internal — wire cell ↔ term adjacency (from `Term` ctor). */
  _connectTerm(term: Term, cellId: number, cellIndex: number): void {
    this.cellTerms[cellId]!.push(term);
    this.cellTermIdx[cellId]!.push(cellIndex);
  }

  /** Read cell `id`'s position into `out` (or a fresh array). */
  read(id: number, out: number[] = []): number[] {
    const off = this.offsets[id]!;
    const dim = this.dims[id]!;
    for (let k = 0; k < dim; k++) out[k] = this.positions[off + k]!;
    out.length = dim;
    return out;
  }

  /** Write cell `id`'s position from `value`. */
  write(id: number, value: ArrayLike<number>): void {
    const off = this.offsets[id]!;
    const dim = this.dims[id]!;
    for (let k = 0; k < dim; k++) this.positions[off + k] = value[k] ?? 0;
  }

  /** Get the (slot-0) mass of cell `id`. `0` means pinned. For
   *  cells with non-uniform mass (`setMassDiag`), this returns the
   *  first DOF's mass; the others may differ. */
  massOf(id: number): number {
    return this.masses[this.offsets[id]!]!;
  }

  /** Set every DOF of cell `id` to the same mass. Call with `0`
   *  to pin (skip in primal sweep, value preserved). */
  setMass(id: number, m: number): void {
    const off = this.offsets[id]!;
    const dim = this.dims[id]!;
    for (let k = 0; k < dim; k++) this.masses[off + k] = m;
  }

  /** Set per-DOF mass (`m.length` must equal the cell's dim). For
   *  rigid bodies with differing linear/rotational inertia, e.g.
   *  `[mass, mass, moment]`. All-zero pins. */
  setMassDiag(id: number, m: ArrayLike<number>): void {
    const off = this.offsets[id]!;
    const dim = this.dims[id]!;
    for (let k = 0; k < dim; k++) this.masses[off + k] = m[k] ?? 0;
  }

  /** Snapshot `initials = anchors = positions` and warm-start each
   *  term. Callers may overwrite `anchors` before `solve(dt)`. */
  prepare(): void {
    // Term initialisation + warm-start.
    for (let fi = this._terms.length - 1; fi >= 0; fi--) {
      const t = this._terms[fi]!;
      if (t.disabled) {
        this.removeTerm(t);
        continue;
      }
      if (!t.initialize()) {
        this.removeTerm(t);
        continue;
      }
      t.computeConstraint(0);
      for (let r = 0; r < t.rows; r++) t.C0[r]! = t.C[r]!;
      // λ + penalty warm-start with AVBD §3.7 forgetting factor γ.
      // Must decay every frame regardless of mode: otherwise stacked /
      // sliding contacts accumulate dual impulse forever (rest jitter,
      // oscillation under perturbation).
      const ag = this.alpha * this.gamma;
      for (let r = 0; r < t.rows; r++) {
        t.lambda[r]! *= ag;
        t.penalty[r]! = clamp(t.penalty[r]! * this.gamma, PENALTY_MIN, PENALTY_MAX);
        const k = t.stiffness[r]!;
        if (Number.isFinite(k) && t.penalty[r]! > k) t.penalty[r]! = k;
      }
    }
    // Cell warm-start: y = x⁻ by default.
    const N = this._totalDof;
    for (let i = 0; i < N; i++) {
      this.initials[i] = this.positions[i]!;
      this.anchors[i] = this.positions[i]!;
    }
  }

  /** Run the iteration loop against the current `anchors`. `dt`
   *  scales the regularizer `M / dt²` vs the constraints (default 1,
   *  static editing). With `postStabilize`, regular iters use α = 1
   *  and a final α = 0 iter zeros the residual; otherwise every iter
   *  uses `this.alpha`.
   *
   *  `beforePostStab` fires at the regular/post-stab boundary (or
   *  once after the final iter when post-stab is off). Physics hooks
   *  it to read velocity from the physical trajectory, before the
   *  post-stab projection unwinds drift. */
  solve(dt: number = 1, beforePostStab?: () => void): void {
    const inv_dt2 = 1 / (dt * dt);
    if (this.postStabilize) {
      for (let it = 0; it < this.iterations; it++) {
        this._primalSweep(1, inv_dt2);
        this._dualPass(1);
      }
      if (beforePostStab) beforePostStab();
      this._primalSweep(0, inv_dt2);
    } else {
      const a = this.alpha;
      for (let it = 0; it < this.iterations; it++) {
        this._primalSweep(a, inv_dt2);
        this._dualPass(a);
      }
      if (beforePostStab) beforePostStab();
    }
  }

  /** Compute `‖C‖` for diagnostics. */
  residualNorm(): number {
    let s = 0;
    for (const t of this._terms) {
      if (t.disabled) continue;
      t.computeConstraint(0);
      for (let r = 0; r < t.rows; r++) s += t.C[r]! * t.C[r]!;
    }
    return Math.sqrt(s);
  }

  // ─── Inner loops ─────────────────────────────────────────────────

  /** Forward Gauss-Seidel sweep over cells. Hot path. */
  private _primalSweep(currentAlpha: number, inv_dt2: number): void {
    const lhs = this._lhs;
    const rhs = this._rhs;
    const positions = this.positions;
    const anchors = this.anchors;
    const masses = this.masses;
    const dims = this.dims;
    const offsets = this.offsets;
    const cellTerms = this.cellTerms;
    const cellTermIdx = this.cellTermIdx;
    const N = this._cellCount;

    for (let cellI = 0; cellI < N; cellI++) {
      const dim = dims[cellI]!;
      const off = offsets[cellI]!;
      const m0 = masses[off]!;
      // Pinned cells have slot-0 mass = 0; skip the primal step.
      if (m0 <= 0) continue;

      // Initialise lhs = diag(masses[off + k]) / dt², rhs = same · (x − y).
      // Hand-unrolled for dim=2 and dim=3 (rigid body); generic loop otherwise.
      if (dim === 2) {
        const m1 = masses[off + 1]!;
        const m0Dt2 = m0 * inv_dt2;
        const m1Dt2 = m1 * inv_dt2;
        lhs[0]! = m0Dt2;
        lhs[1]! = 0;
        lhs[2]! = 0;
        lhs[3]! = m1Dt2;
        rhs[0]! = m0Dt2 * (positions[off]! - anchors[off]!);
        rhs[1]! = m1Dt2 * (positions[off + 1]! - anchors[off + 1]!);
      } else if (dim === 3) {
        const m1 = masses[off + 1]!;
        const m2 = masses[off + 2]!;
        const m0Dt2 = m0 * inv_dt2;
        const m1Dt2 = m1 * inv_dt2;
        const m2Dt2 = m2 * inv_dt2;
        lhs[0]! = m0Dt2;
        lhs[1]! = 0;
        lhs[2]! = 0;
        lhs[3]! = 0;
        lhs[4]! = m1Dt2;
        lhs[5]! = 0;
        lhs[6]! = 0;
        lhs[7]! = 0;
        lhs[8]! = m2Dt2;
        rhs[0]! = m0Dt2 * (positions[off]! - anchors[off]!);
        rhs[1]! = m1Dt2 * (positions[off + 1]! - anchors[off + 1]!);
        rhs[2]! = m2Dt2 * (positions[off + 2]! - anchors[off + 2]!);
      } else {
        for (let i = 0; i < dim * dim; i++) lhs[i]! = 0;
        for (let k = 0; k < dim; k++) {
          const mk = masses[off + k]!;
          const mkDt2 = mk * inv_dt2;
          lhs[k * dim + k]! = mkDt2;
          rhs[k]! = mkDt2 * (positions[off + k]! - anchors[off + k]!);
        }
      }

      // Accumulate term contributions.
      const termList = cellTerms[cellI]!;
      const termCiList = cellTermIdx[cellI]!;
      const flen = termList.length;
      for (let fi = 0; fi < flen; fi++) {
        const t = termList[fi]!;
        if (t.disabled) continue;
        const ci = termCiList[fi]!;
        t.computeConstraint(currentAlpha);
        t.computeDerivatives(ci);
        const Jblock = t.J[ci]!;
        const Hcols = t.HCols[ci]!;
        const fStiff = t.stiffness;
        const fLambda = t.lambda;
        const fPenalty = t.penalty;
        const fC = t.C;
        const fMin = t.lambdaMin;
        const fMax = t.lambdaMax;
        const rows = t.rows;
        for (let r = 0; r < rows; r++) {
          const lambda = fStiff[r]! === Number.POSITIVE_INFINITY ? fLambda[r]! : 0;
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
          } else if (dim === 3) {
            const j0 = Jblock[baseJ]!;
            const j1 = Jblock[baseJ + 1]!;
            const j2 = Jblock[baseJ + 2]!;
            rhs[0]! += j0 * fc;
            rhs[1]! += j1 * fc;
            rhs[2]! += j2 * fc;
            const pj0 = penalty_r * j0;
            const pj1 = penalty_r * j1;
            const pj2 = penalty_r * j2;
            lhs[0]! += pj0 * j0;
            lhs[1]! += pj0 * j1;
            lhs[2]! += pj0 * j2;
            lhs[3]! += pj1 * j0;
            lhs[4]! += pj1 * j1;
            lhs[5]! += pj1 * j2;
            lhs[6]! += pj2 * j0;
            lhs[7]! += pj2 * j1;
            lhs[8]! += pj2 * j2;
            if (absF > TINY) {
              lhs[0]! += Hcols[baseJ]! * absF;
              lhs[4]! += Hcols[baseJ + 1]! * absF;
              lhs[8]! += Hcols[baseJ + 2]! * absF;
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

      // Solve `lhs · delta = -rhs`, write `position -= delta`. Skip on
      // rank-deficiency or non-finite results (would poison positions
      // with NaN).
      if (!solveSPD(lhs, rhs, dim)) continue;
      if (dim === 2) {
        const r0 = rhs[0]!;
        const r1 = rhs[1]!;
        if (!Number.isFinite(r0) || !Number.isFinite(r1)) continue;
        positions[off]! -= r0;
        positions[off + 1]! -= r1;
      } else if (dim === 3) {
        const r0 = rhs[0]!;
        const r1 = rhs[1]!;
        const r2 = rhs[2]!;
        if (!Number.isFinite(r0) || !Number.isFinite(r1) || !Number.isFinite(r2)) continue;
        positions[off]! -= r0;
        positions[off + 1]! -= r1;
        positions[off + 2]! -= r2;
      } else {
        let bad = false;
        for (let k = 0; k < dim; k++) {
          if (!Number.isFinite(rhs[k]!)) {
            bad = true;
            break;
          }
        }
        if (bad) continue;
        for (let k = 0; k < dim; k++) positions[off + k]! -= rhs[k]!;
      }
    }
  }

  /** Dual update over all terms. */
  private _dualPass(currentAlpha: number): void {
    const beta = this.beta;
    const allTerms = this._terms;
    for (let fi = 0; fi < allTerms.length; fi++) {
      const t = allTerms[fi]!;
      if (t.disabled) continue;
      t.computeConstraint(currentAlpha);
      const fLambda = t.lambda;
      const fPenalty = t.penalty;
      const fC = t.C;
      const fMin = t.lambdaMin;
      const fMax = t.lambdaMax;
      const fStiff = t.stiffness;
      const fFracture = t.fracture;
      const rows = t.rows;
      for (let r = 0; r < rows; r++) {
        const lambda = fStiff[r]! === Number.POSITIVE_INFINITY ? fLambda[r]! : 0;
        const kC = fPenalty[r]! * fC[r]! + lambda;
        const lo = fMin[r]!;
        const hi = fMax[r]!;
        // Two clamps: user-supplied `[lambdaMin, lambdaMax]` (one-sided
        // for inequalities), and the unconditional `±LAMBDA_MAX` to
        // prevent runaway under infeasibility — see term.ts header.
        let newLambda = kC < lo ? lo : kC > hi ? hi : kC;
        if (newLambda > LAMBDA_MAX) newLambda = LAMBDA_MAX;
        else if (newLambda < -LAMBDA_MAX) newLambda = -LAMBDA_MAX;
        fLambda[r]! = newLambda;
        const absLambda = newLambda < 0 ? -newLambda : newLambda;
        if (absLambda >= fFracture[r]!) {
          t.dispose();
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

  // ─── Buffer growth ───────────────────────────────────────────────

  private _growCellArrays(): void {
    const newLen = this.dims.length * 2;
    const newDims = new Uint8Array(newLen);
    const newOffsets = new Uint32Array(newLen);
    newDims.set(this.dims);
    newOffsets.set(this.offsets);
    this.dims = newDims;
    this.offsets = newOffsets;
  }

  private _growScalarBuffers(needed: number): void {
    let cap = this._capacity || 1;
    while (cap < this._totalDof + needed) cap *= 2;
    const newPositions = new Float64Array(cap);
    const newInitials = new Float64Array(cap);
    const newAnchors = new Float64Array(cap);
    const newMasses = new Float64Array(cap);
    newPositions.set(this.positions);
    newInitials.set(this.initials);
    newAnchors.set(this.anchors);
    newMasses.set(this.masses);
    this.positions = newPositions;
    this.initials = newInitials;
    this.anchors = newAnchors;
    this.masses = newMasses;
    this._capacity = cap;
  }
}
