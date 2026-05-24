// solver.ts — Augmented Vertex Block Descent (AVBD) numerical kernel.
//
// SOA layout: per-cell state lives in packed Float64/Uint typed-
// array buffers indexed by integer cell id. No per-cell heap
// allocation; the hot loop streams contiguous memory and the JIT
// keeps hidden classes stable.
//
// Signal-free. Cells are integer handles returned by `addCell`.
// Terms store cell ids and read positions via
// `positions[offsets[id] + k]`. Reactive integration is layered
// on top in `cluster.ts`; time evolution and physics-flavored
// extensions live in factories (`physics`, `world`) that mutate
// `anchors` between `prepare()` and `solve(dt)`.
//
// Solver answers: "given an anchor `y` and a set of constraints,
// find `x` near `y` (weighted by `M/dt²`) that satisfies them."
//
// The math is deliberately not specialized to physics:
//   - `y` (anchors): the regularizer's reference point.
//     Physics: `x⁻ + dt·v + dt²·g` (inertial extrapolation).
//     Sketchpad / IK: `x⁻` (just stay where you were).
//     Adam-flavored opt: `x − lr · m̂ / √v̂`.
//     Annealing: `x + noise(T)`.
//   - `M` (masses): per-DOF anchor weight.
//     Physics: linear + rotational inertia.
//     Layout: stickiness.
//     Adam: `1 / √v̂` preconditioner.
//   - `dt`: scale parameter on the regularizer vs constraints.
//     dt → 0: hard projection (constraints dominate).
//     dt → ∞: stay-put (regularizer dominates).

import { clamp, solveSPD } from "./linalg";
import { LAMBDA_MAX, PENALTY_MAX, PENALTY_MIN, type Term } from "./term";

export interface SolverOpts {
  /** Number of primal+dual iterations per solve. Default 10. */
  iterations?: number;
  /** Stabilisation parameter α ∈ [0, 1]. With `postStabilize`
   *  off, used for every iteration as `C(x) − α·C(x⁻)` and as the
   *  per-frame λ warm-start factor `α·γ`. With `postStabilize`
   *  on, the regular iters override α to 1 (don't fight existing
   *  violation; let the dual step accumulate λ) and the post-stab
   *  iter uses α = 0 to zero residual exactly; the field still
   *  controls the inter-frame λ decay. AVBD paper recommends
   *  `0.99` for physics, `0` for static editing. */
  alpha?: number;
  /** Penalty ramp parameter β. Default 1e5 (paper recommends
   *  [1, 1000]; 1e5 worked for the reference 2D demo). */
  beta?: number;
  /** Warm-start decay γ ∈ [0, 1). Default 0.99. */
  gamma?: number;
  /** Run an extra primal-only iteration with `α = 0` at the end
   *  of each `solve(dt)`. With `postStabilize` on, regular iters
   *  use `α = 1` (drift-tolerant: lambda still grows when violated,
   *  but the primal step doesn't actively unwind the existing
   *  residual), and the post-stab iter zeros the residual exactly.
   *  This is the AVBD paper's default for physics — strongly
   *  recommended whenever a physics-flavored factory is in use.
   *  Default `false` so static `solver.solve()` retains its iter-N
   *  Newton behaviour. */
  postStabilize?: boolean;
  /** Initial buffer capacity in scalar slots. Buffers grow by
   *  doubling when needed; seeding a generous capacity avoids
   *  the cost of early reallocations. Default 64. */
  initialCapacity?: number;
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
  iterations: number;
  alpha: number;
  beta: number;
  gamma: number;
  postStabilize: boolean;

  // ─── Per-cell SOA state ──────────────────────────────────────────
  /** Packed cell positions. `positions[offsets[id] + k]` reads the
   *  k-th component of cell `id`. Solver writes here directly. */
  positions: Float64Array;
  /** Packed cell positions at start of step (`x⁻`). */
  initials: Float64Array;
  /** Packed anchor positions (`y`) — the point the regularizer
   *  pulls `x` toward. Defaults to `initials` after `prepare()`;
   *  factories (physics, Adam, …) overwrite between `prepare()`
   *  and `solve(dt)` to install their own warm-start. */
  anchors: Float64Array;
  /** Anchor weight per scalar slot — same length as `positions`.
   *  In physics this is mass / inertia; in layout it's stickiness;
   *  in Adam it's the preconditioner. The hot loop reads per slot.
   *  `0` on the first slot means "pinned" (primal update is
   *  skipped, value stays put); other slots are ignored when slot
   *  0 is zero. For uniform-mass cells use `setMass(id, m)`; for
   *  non-uniform (e.g. a 2D rigid body's `(m, m, I)`) use
   *  `setMassDiag`. */
  masses: Float64Array;
  /** Per-cell dim. Stored as Uint8 since dims are small. */
  dims: Uint8Array;
  /** Start of each cell within `positions`. Cumulative sum of
   *  `dims`. Stored as Uint32 for size up to 4G slots. */
  offsets: Uint32Array;

  // ─── Adjacency ───────────────────────────────────────────────────
  /** Per-cell list of incident terms. Order doesn't matter
   *  (solver iterates all). */
  cellTerms: Term[][] = [];
  /** Parallel array: `cellTermIdx[id][k]` is this cell's index
   *  within `cellTerms[id][k].cells`. Avoids an O(n) `indexOf`
   *  per cell-visit-per-iteration. */
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
    // Grow per-cell arrays if needed.
    if (id >= this.dims.length) this._growCellArrays();
    // Grow scalar buffers if needed.
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

  /** @internal — for `Term` constructors to wire the cell ↔ term
   *  adjacency. Subclasses should not call this directly. */
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

  /** Set per-DOF mass for cell `id`. Length of `m` must equal the
   *  cell's dim. Used for rigid bodies whose linear and rotational
   *  inertia differ — typically `setMassDiag(id, [mass, mass, moment])`
   *  for a 2D rigid body cell of dim 3. To "pin", pass all zeros
   *  (or use `setMass(id, 0)` for the same effect). */
  setMassDiag(id: number, m: ArrayLike<number>): void {
    const off = this.offsets[id]!;
    const dim = this.dims[id]!;
    for (let k = 0; k < dim; k++) this.masses[off + k] = m[k] ?? 0;
  }

  /** Snapshot positions (initials = positions), set anchor =
   *  positions, and warm-start each term. After this, callers may
   *  overwrite `anchors` (e.g. physics adds inertial extrapolation)
   *  before invoking `solve(dt)`. */
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
      // Lambda + penalty warm-start: AVBD §3.7 "forgetting factor" γ.
      // Both decay each frame regardless of stabilization mode —
      // failing to decay λ lets stacked / sliding contacts accumulate
      // dual impulse forever, which manifests as stack jitter at rest
      // and oscillation under perturbation.
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

  /** Run the iteration loop using the current `anchors` as the
   *  warm-start anchor. `dt` scales the regularizer term `M / dt²`
   *  vs the constraint terms. Default `dt = 1` (static editing).
   *
   *  With `postStabilize`, regular iterations use `α = 1`
   *  (the dual update accumulates λ for any growth in residual,
   *  but the primal step doesn't actively unwind existing
   *  violation), and one final iteration with `α = 0` zeros the
   *  residual at frame end. Without it, every iteration uses
   *  `this.alpha`.
   *
   *  `beforePostStab` runs once at the boundary between the regular
   *  iterations and the post-stabilization iter — physics uses this
   *  hook to compute velocity from the *physical* trajectory rather
   *  than from positions after the post-stab projection (matching
   *  the AVBD reference; see solver.cpp's `if (it == iterations - 1)`
   *  block). With `postStabilize` off, the hook fires once after
   *  the final iteration. */
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
          const lambda = fStiff[r]! === Infinity ? fLambda[r]! : 0;
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

      // Solve `lhs · delta = -rhs`, write `position -= delta`.
      // Skip if the local system is rank-deficient (rhs in undefined
      // state) or if anything went non-finite (would otherwise poison
      // `positions` with NaN, which propagates everywhere).
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
        const lambda = fStiff[r]! === Infinity ? fLambda[r]! : 0;
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
