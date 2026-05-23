// solvers-sparse.ts — sparse Newton-LM for clusters with structured
// sparsity. Asymptotically beats the dense path for chain/lattice/
// tree topologies where each constraint touches few cells.
//
// Three asymptotic regimes (per Newton iter; warm-started drag is
// usually 1-3 iters):
//
//   Dense LU (existing tinyLU):
//     FD       O(m × n)       per slot perturb evaluates ALL constraints
//     Assembly O(m × n²)      JᵀJ build by full outer product
//     Solve    O(n³)          dense LU
//     Total    O(n³)
//
//   Sparse FD + dense Cholesky (this file, simplest variant):
//     FD       O(Σ |Cᵢ|)      perturb only affects dependent constraints
//     Assembly O(Σ |Cᵢ|²)     JᵀJ entry only when two slots co-occur
//     Solve    O(n³)          still dense
//     Total    O(n³) but with much smaller FD constant
//
//   Sparse FD + banded Cholesky:
//     FD       O(Σ |Cᵢ|)
//     Assembly O(n × b)
//     Solve    O(n × b²)      banded Cholesky
//     Total    O(n × b²)      where b = JᵀJ bandwidth
//
// For typical chain-like problems (b ≈ 6-8), the banded path is
// ~O(n) per iter — matching Cassowary's amortised O(1) per resolve
// behaviour for incremental linear constraint solving. We measure
// to confirm we hit the asymptotic.
//
// Symmetric positive definite — JᵀJ + λI always is — so we use
// Cholesky (not LU). About 2× faster than LU and numerically
// stable.

// ─── Sparsity descriptor ─────────────────────────────────────────────

/** Pre-computed sparsity structure for a cluster. Computed once at
 *  cluster construction; reused across solves. */
export interface SparseInfo {
  /** For each constraint i, the list of slot indices it depends on. */
  constraintSlots: readonly (readonly number[])[];
  /** For each slot j, the list of constraint indices that depend on it. */
  slotConstraints: readonly (readonly number[])[];
  /** Bandwidth of the JᵀJ matrix: max |a - b| over (a, b) co-occurring
   *  in some constraint's slot list. Banded Cholesky cost scales as
   *  `n × bandwidth²`. */
  bandwidth: number;
  /** Number of slots (= length of slotConstraints, dimension of the
   *  flat state vector). */
  totalSlots: number;
}

/** Build sparsity info from per-constraint slot dependencies. */
export function buildSparseInfo(constraintSlots: readonly (readonly number[])[], totalSlots: number): SparseInfo {
  // Inverse map.
  const slotConstraints: number[][] = Array.from({ length: totalSlots }, () => []);
  for (let i = 0; i < constraintSlots.length; i++) {
    for (const s of constraintSlots[i]!) {
      slotConstraints[s]!.push(i);
    }
  }
  // Bandwidth = max (max - min) in any constraint's slot list.
  let bandwidth = 0;
  for (const slots of constraintSlots) {
    if (slots.length === 0) continue;
    let lo = slots[0]!;
    let hi = slots[0]!;
    for (const s of slots) {
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    if (hi - lo > bandwidth) bandwidth = hi - lo;
  }
  return { constraintSlots, slotConstraints, bandwidth, totalSlots };
}

// ─── Banded Cholesky (lower band storage) ────────────────────────────
//
// Storage: `band[i × (b + 1) + c]` represents `A[i][i - b + c]` for
// `c ∈ [0, b]`. So the diagonal is at `c = b`, first sub-diagonal at
// `c = b - 1`, etc. We don't store the upper band (matrix is
// symmetric).
//
// Out-of-range entries (c < 0 or i - b + c < 0) are ignored by
// guards in the inner loops.

/** In-place banded Cholesky factorization. `A` becomes `L` (lower
 *  triangular with unit diagonal not stored — we store the actual
 *  diagonal of L). For symmetric positive definite `A`. Returns
 *  false if the matrix is not strictly PD (some pivot ≤ 0). */
export function bandedCholesky(A: number[], n: number, b: number): boolean {
  for (let i = 0; i < n; i++) {
    // Compute L[i][j] for j ∈ [max(0, i-b), i-1]
    const jStart = Math.max(0, i - b);
    for (let j = jStart; j < i; j++) {
      // A[i][j] - Σ L[i][k] × L[j][k] for k ∈ [max(0, i-b, j-b), j-1]
      let s = bandGet(A, n, b, i, j);
      const kStart = Math.max(0, i - b, j - b);
      for (let k = kStart; k < j; k++) {
        s -= bandGet(A, n, b, i, k) * bandGet(A, n, b, j, k);
      }
      const Ljj = bandGet(A, n, b, j, j);
      if (Ljj === 0) return false;
      bandSet(A, n, b, i, j, s / Ljj);
    }
    // Compute L[i][i] = sqrt(A[i][i] - Σ L[i][k]²)
    let d = bandGet(A, n, b, i, i);
    const kStart = Math.max(0, i - b);
    for (let k = kStart; k < i; k++) {
      const lik = bandGet(A, n, b, i, k);
      d -= lik * lik;
    }
    if (d <= 0) return false;
    bandSet(A, n, b, i, i, Math.sqrt(d));
  }
  return true;
}

/** Solve `L L^T x = b` (in-place: x is filled). `A` holds the
 *  banded Cholesky factor (output of `bandedCholesky`). */
export function bandedCholeskySolve(
  A: readonly number[],
  rhs: readonly number[],
  n: number,
  b: number,
  x: number[],
): void {
  // Forward solve L y = rhs.  y goes into x.
  for (let i = 0; i < n; i++) {
    let s = rhs[i]!;
    const jStart = Math.max(0, i - b);
    for (let j = jStart; j < i; j++) {
      s -= bandGet(A, n, b, i, j) * x[j]!;
    }
    x[i] = s / bandGet(A, n, b, i, i);
  }
  // Back solve L^T x = y.  y is currently in x; overwrite with x.
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i]!;
    const jEnd = Math.min(n - 1, i + b);
    for (let j = i + 1; j <= jEnd; j++) {
      s -= bandGet(A, n, b, j, i) * x[j]!;
    }
    x[i] = s / bandGet(A, n, b, i, i);
  }
}

/** Read `A[i][j]` from band storage. Returns 0 if out of band. */
function bandGet(A: readonly number[], _n: number, b: number, i: number, j: number): number {
  if (j > i) {
    // Symmetric — read transpose.
    return bandGet(A, _n, b, j, i);
  }
  if (i - j > b) return 0;
  const c = j - i + b;
  return A[i * (b + 1) + c]!;
}

/** Write `A[i][j]` into band storage (lower triangular only).
 *  Caller must ensure `j ≤ i` and `i - j ≤ b`. */
function bandSet(A: number[], _n: number, b: number, i: number, j: number, v: number): void {
  const c = j - i + b;
  A[i * (b + 1) + c] = v;
}

/** Zero-fill the band-storage array. */
function bandZero(A: number[], n: number, b: number): void {
  const len = n * (b + 1);
  for (let i = 0; i < len; i++) A[i] = 0;
}

// ─── Sparse Newton-LM solver ─────────────────────────────────────────

export interface SparseNewtonOpts {
  /** Max iterations per call. Default 8. */
  maxIters?: number;
  /** Convergence threshold on ‖residual‖. Default 1e-9. */
  tol?: number;
  /** Levenberg-Marquardt damping. Default 1e-6. */
  damping?: number;
  /** Finite-difference step for Jacobian. Default 1e-6. */
  fdStep?: number;
  /** Optional: provide a banded-LU scratch buffer to reuse across
   *  calls. Length must be `n × (bandwidth + 1)`. If not provided
   *  the solver allocates one each call. */
  scratchBand?: number[];
}

export interface SparseNewtonResult {
  converged: boolean;
  residual: number;
  iters: number;
  /** Final λ (caller may persist for warm-start, though we found
   *  no benefit in practice — see relate.ts comment). */
  lambda: number;
}

/** Damped Newton-LM with sparse FD Jacobian and banded-Cholesky
 *  normal-equation solve. Asymptotically beats the dense path when
 *  the constraint graph has small bandwidth.
 *
 *  Inputs:
 *    - `x`: state vector (modified in place)
 *    - `R`: full residual eval — `R(x, out)` writes m residuals
 *      into `out`. Used only for the initial / final residual norm
 *      and for accept/reject trial steps.
 *    - `Rsubset`: sparse residual eval — `Rsubset(x, which, out)`
 *      writes residuals only at constraint indices in `which`.
 *      Other entries of `out` are NOT modified. Used for FD
 *      Jacobian construction (perturbing slot j only requires
 *      re-evaluating constraints in `info.slotConstraints[j]`).
 *    - `m`: number of residual components.
 *    - `pinned`: per-slot mask; true = held fixed, false = free.
 *    - `info`: pre-computed sparsity descriptor.
 */
export function dampedNewtonSparse(
  x: number[],
  R: (x: readonly number[], out: number[]) => void,
  Rsubset: (x: readonly number[], which: readonly number[], out: number[]) => void,
  m: number,
  pinned: readonly boolean[],
  info: SparseInfo,
  opts: SparseNewtonOpts = {},
): SparseNewtonResult {
  const n = x.length;
  const maxIters = opts.maxIters ?? 8;
  const tol = opts.tol ?? 1e-9;
  let lambda = opts.damping ?? 1e-6;
  const fdStep = opts.fdStep ?? 1e-6;

  // Free indices.
  const freeIdx: number[] = [];
  const freeRank = new Int32Array(n); // slot → free index, or -1
  freeRank.fill(-1);
  for (let i = 0; i < n; i++) {
    if (!pinned[i]) {
      freeRank[i] = freeIdx.length;
      freeIdx.push(i);
    }
  }
  const nf = freeIdx.length;

  // Scratch buffers.
  const r = new Array<number>(m).fill(0);
  const r2 = new Array<number>(m).fill(0);
  const rSaved = new Array<number>(m).fill(0);
  // Sparse J as triples (constraint, slot, value). Allocated based
  // on max non-zero count = Σ |Cᵢ|.
  let maxNNZ = 0;
  for (const slots of info.constraintSlots) maxNNZ += slots.length;
  const jVal = new Array<number>(maxNNZ).fill(0);
  const jRow = new Array<number>(maxNNZ).fill(0);
  const jCol = new Array<number>(maxNNZ).fill(0);
  // Banded JᵀJ + λI.
  const bw = info.bandwidth;
  const bandLen = nf * (bw + 1);
  const band = opts.scratchBand && opts.scratchBand.length >= bandLen ? opts.scratchBand : new Array<number>(bandLen).fill(0);
  const rhs = new Array<number>(nf).fill(0);
  const step = new Array<number>(nf).fill(0);

  R(x, r);
  let rn = residualNorm(r);

  if (nf === 0) return { converged: rn <= tol, residual: rn, iters: 0, lambda };
  if (rn <= tol) return { converged: true, residual: rn, iters: 0, lambda };
  if (!Number.isFinite(rn)) return { converged: false, residual: rn, iters: 0, lambda };

  let iters = 0;
  for (; iters < maxIters; iters++) {
    // ── Sparse FD Jacobian ──
    let nnz = 0;
    for (let jf = 0; jf < nf; jf++) {
      const idx = freeIdx[jf]!;
      const affected = info.slotConstraints[idx]!;
      if (affected.length === 0) continue;
      // Save residuals at affected indices, perturb, re-eval, restore.
      for (let a = 0; a < affected.length; a++) rSaved[affected[a]!] = r[affected[a]!]!;
      const saved = x[idx]!;
      x[idx] = saved + fdStep;
      Rsubset(x, affected, r2);
      x[idx] = saved;
      for (let a = 0; a < affected.length; a++) {
        const i = affected[a]!;
        const Jij = (r2[i]! - rSaved[i]!) / fdStep;
        if (Jij !== 0) {
          jRow[nnz] = i;
          jCol[nnz] = jf;
          jVal[nnz] = Jij;
          nnz++;
        }
      }
    }

    // ── Sparse JᵀJ + λI ──
    bandZero(band, nf, bw);
    // Outer product: for each pair (a, b) of nnz entries with same row,
    // contribute J[a].val × J[b].val to JᵀJ[J[a].col][J[b].col].
    // Since J is sparse but small per constraint (rows are clustered
    // by constraint i), group by row.
    {
      // Sort triples by row for efficient grouping. (Or maintain
      // groups during construction.) For simplicity, do an O(nnz)
      // sweep grouping consecutive same-row entries — they're
      // already consecutive due to construction order? No — we
      // iterated by free slot, not by constraint. Need a per-
      // constraint grouping pass.
      const byConstraint: number[][] = Array.from({ length: m }, () => []);
      for (let k = 0; k < nnz; k++) byConstraint[jRow[k]!]!.push(k);
      for (let i = 0; i < m; i++) {
        const row = byConstraint[i]!;
        for (let a = 0; a < row.length; a++) {
          for (let b = 0; b <= a; b++) {
            const ka = row[a]!;
            const kb = row[b]!;
            const ca = jCol[ka]!;
            const cb = jCol[kb]!;
            // Add to band[max(ca,cb)][min(ca,cb)].
            const hi = Math.max(ca, cb);
            const lo = Math.min(ca, cb);
            if (hi - lo > bw) continue; // out of bandwidth — would happen if our bw estimate is wrong
            const c = lo - hi + bw;
            band[hi * (bw + 1) + c]! += jVal[ka]! * jVal[kb]!;
          }
        }
      }
      // Add λI to diagonal.
      for (let i = 0; i < nf; i++) {
        band[i * (bw + 1) + bw]! += lambda;
      }
    }

    // ── Cholesky factor + solve ──
    // Build rhs = Jᵀ r.
    for (let jf = 0; jf < nf; jf++) rhs[jf] = 0;
    for (let k = 0; k < nnz; k++) {
      rhs[jCol[k]!]! += jVal[k]! * r[jRow[k]!]!;
    }

    if (!bandedCholesky(band, nf, bw)) {
      // Not PD — bump λ and retry next iter.
      lambda *= 8;
      if (lambda > 1e8) return { converged: false, residual: rn, iters: iters + 1, lambda };
      continue;
    }
    bandedCholeskySolve(band, rhs, nf, bw, step);

    // NaN guard.
    let stepFinite = true;
    for (let jf = 0; jf < nf; jf++) {
      if (!Number.isFinite(step[jf]!)) {
        stepFinite = false;
        break;
      }
    }
    if (!stepFinite) return { converged: false, residual: rn, iters, lambda };

    // Trial step.
    for (let jf = 0; jf < nf; jf++) x[freeIdx[jf]!]! -= step[jf]!;
    R(x, r2);
    const rn2 = residualNorm(r2);

    if (!Number.isFinite(rn2)) {
      for (let jf = 0; jf < nf; jf++) x[freeIdx[jf]!]! += step[jf]!;
      return { converged: false, residual: rn, iters: iters + 1, lambda };
    }

    if (rn2 < rn) {
      // Accept.
      for (let i = 0; i < m; i++) r[i] = r2[i]!;
      rn = rn2;
      lambda *= 0.5;
      if (lambda < 1e-12) lambda = 1e-12;
      if (rn <= tol) return { converged: true, residual: rn, iters: iters + 1, lambda };
    } else {
      // Reject — restore + bump λ.
      for (let jf = 0; jf < nf; jf++) x[freeIdx[jf]!]! += step[jf]!;
      lambda *= 8;
      if (lambda > 1e8) return { converged: false, residual: rn, iters: iters + 1, lambda };
    }
  }
  return { converged: rn <= tol, residual: rn, iters, lambda };
}

function residualNorm(r: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i]! * r[i]!;
  return Math.sqrt(s);
}
