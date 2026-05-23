// solvers-sparse.ts — sparse Newton-LM for clusters with structured
// sparsity. Asymptotically beats the dense path for chain/lattice/
// tree topologies where each constraint touches few cells.
//
// Design notes:
//   1. Sparsity pattern (which constraint touches which slot) is
//      computed ONCE at cluster construction and cached on a
//      `SparseInfo` object. The per-call cost on hot drag frames
//      reads from this cache; nothing is rebuilt unless the
//      topology changes.
//
//   2. Scratch buffers (Jacobian-as-triples, banded JᵀJ, RHS,
//      step) live on a `SparseScratch` object passed in by the
//      caller. The relation runtime keeps one per cluster and
//      reuses across solves — zero allocations in the hot loop.
//
//   3. Banded Cholesky on JᵀJ + λI. SPD, so Cholesky is faster
//      and simpler than LU. Lower-band-only storage = O(n × b).
//
//   4. Float64Array for the band matrix and packed Jacobian. ~2×
//      speedup vs `number[]` on V8 (typed-array optimisations,
//      better cache behaviour).
//
// Asymptotic per Newton iter (for cluster size n, bandwidth b,
// constraint count m, total non-zero Jacobian entries N = Σ|Cᵢ|):
//
//   FD Jacobian          O(N)         each non-zero independently
//   JᵀJ assembly         O(Σ|Cᵢ|²)    only same-row pairs contribute
//   Cholesky factor      O(n × b²)
//   Forward/back solve   O(n × b)
//   Total                O(n × b² + N)
//
// For chain topologies (b ≈ 4-6, N ≈ 4n), this is O(n) per iter
// — at the asymptotic floor for the problem class.

// ─── Sparsity descriptor (cached per topology) ───────────────────────

/** Pre-computed sparsity structure for a cluster. Computed once at
 *  cluster construction and re-used across drag frames; rebuilt
 *  only when constraints are added or removed.
 *
 *  Includes a Reverse Cuthill-McKee permutation that minimises
 *  the bandwidth of JᵀJ. For natural orderings already with low
 *  bandwidth (chains, lattices), RCM is roughly a no-op; for
 *  arbitrary topologies (trees, mixed-construction figures) it
 *  can drop bandwidth from O(n) to O(√n) or better, extending
 *  the sparse-banded path's reach. */
export interface SparseInfo {
  /** For each constraint i, the list of slot indices it depends on. */
  constraintSlots: readonly (readonly number[])[];
  /** For each slot j, the list of constraint indices that depend on it. */
  slotConstraints: readonly (readonly number[])[];
  /** RCM ordering: `slotByRank[r]` is the original slot index
   *  occupying rank `r` in the band-friendly ordering. Solver
   *  iterates slots in this order when building free-index lists,
   *  so consecutively-indexed positions in the band matrix
   *  correspond to slots that are actually close in the constraint
   *  graph. */
  slotByRank: Int32Array;
  /** Inverse of `slotByRank`: `slotRank[s]` is the band-matrix
   *  rank of slot `s`. */
  slotRank: Int32Array;
  /** Bandwidth of JᵀJ in the RCM-permuted ordering: max
   *  `|slotRank[a] - slotRank[b]|` over (a, b) co-occurring in
   *  some constraint's slot list. */
  bandwidth: number;
  /** Number of slots. */
  totalSlots: number;
  /** Total non-zero count of the Jacobian: Σ |Cᵢ|. */
  totalNNZ: number;
}

export function buildSparseInfo(
  constraintSlots: readonly (readonly number[])[],
  totalSlots: number,
): SparseInfo {
  const slotConstraints: number[][] = Array.from({ length: totalSlots }, () => []);
  let totalNNZ = 0;
  for (let i = 0; i < constraintSlots.length; i++) {
    const slots = constraintSlots[i]!;
    totalNNZ += slots.length;
    for (const s of slots) slotConstraints[s]!.push(i);
  }

  // Build adjacency graph: slots a, b adjacent iff they co-occur in
  // some constraint. RCM operates on this graph.
  const adjacency: number[][] = Array.from({ length: totalSlots }, () => []);
  const seenEdge = new Set<number>();
  for (const slots of constraintSlots) {
    for (let i = 0; i < slots.length; i++) {
      const a = slots[i]!;
      for (let j = i + 1; j < slots.length; j++) {
        const b = slots[j]!;
        // Encode (min, max) as a single number to dedupe.
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        const key = lo * totalSlots + hi;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        adjacency[a]!.push(b);
        adjacency[b]!.push(a);
      }
    }
  }
  const slotByRank = reverseCuthillMcKee(adjacency, totalSlots);
  const slotRank = new Int32Array(totalSlots);
  for (let r = 0; r < totalSlots; r++) slotRank[slotByRank[r]!] = r;

  // Compute bandwidth in the RCM-permuted coordinates.
  let bandwidth = 0;
  for (const slots of constraintSlots) {
    if (slots.length === 0) continue;
    let lo = slotRank[slots[0]!]!;
    let hi = lo;
    for (const s of slots) {
      const r = slotRank[s]!;
      if (r < lo) lo = r;
      if (r > hi) hi = r;
    }
    if (hi - lo > bandwidth) bandwidth = hi - lo;
  }

  return {
    constraintSlots,
    slotConstraints,
    slotByRank,
    slotRank,
    bandwidth,
    totalSlots,
    totalNNZ,
  };
}

// ─── Reverse Cuthill-McKee bandwidth-reducing ordering ───────────────
//
// Standard graph-reordering algorithm that minimises matrix bandwidth
// for sparse symmetric systems. Roughly:
//   1. Pick a starting node — usually the lowest-degree node, which
//      tends to be peripheral.
//   2. BFS from start; within each level visit unvisited neighbours
//      in increasing-degree order.
//   3. Reverse the resulting node order. (The "Reverse" trick lowers
//      the band matrix profile in addition to the bandwidth.)
//
// Disconnected components: any unvisited slots after the BFS get
// appended in arbitrary order. That doesn't affect within-component
// bandwidth.
//
// Cost: O(|V| log |V| + |E|) due to per-level degree sorts. Run once
// at cluster construction; not on the hot path.

function reverseCuthillMcKee(adjacency: number[][], n: number): Int32Array {
  // Pick starting node: lowest-degree (excluding isolated nodes).
  let startNode = -1;
  let minDeg = Infinity;
  for (let i = 0; i < n; i++) {
    const d = adjacency[i]!.length;
    if (d > 0 && d < minDeg) {
      minDeg = d;
      startNode = i;
    }
  }
  // If all nodes are isolated, identity ordering.
  const result = new Int32Array(n);
  if (startNode === -1) {
    for (let i = 0; i < n; i++) result[i] = i;
    return result;
  }

  const visited = new Uint8Array(n);
  const order: number[] = [];
  let frontier: number[] = [startNode];
  visited[startNode] = 1;

  while (frontier.length > 0) {
    // Sort current frontier by degree (ascending) — affects within-
    // level ordering. Stable sort, so ties keep insertion order.
    frontier.sort((a, b) => adjacency[a]!.length - adjacency[b]!.length);
    const next: number[] = [];
    for (const u of frontier) {
      order.push(u);
      // Collect unvisited neighbours, sorted by degree.
      const neighbours = adjacency[u]!.filter(v => !visited[v]);
      neighbours.sort((a, b) => adjacency[a]!.length - adjacency[b]!.length);
      for (const v of neighbours) {
        if (!visited[v]) {
          visited[v] = 1;
          next.push(v);
        }
      }
    }
    frontier = next;
  }
  // Append disconnected nodes (or isolated ones).
  for (let i = 0; i < n; i++) {
    if (!visited[i]) {
      order.push(i);
      visited[i] = 1;
    }
  }
  // Reverse for "Reverse" Cuthill-McKee.
  order.reverse();
  for (let r = 0; r < order.length; r++) result[r] = order[r]!;
  return result;
}

// ─── Scratch container (one per cluster, allocated lazily) ──────────

export interface SparseScratch {
  r: Float64Array;
  r2: Float64Array;
  rSaved: Float64Array;
  /** Jacobian as triples: (jRow[k], jCol[k], jVal[k]). Allocated to
   *  size `info.totalNNZ`; nnz never exceeds this. */
  jVal: Float64Array;
  jRow: Int32Array;
  jCol: Int32Array;
  /** Banded JᵀJ + λI in lower-band storage. Size `nf × (bandwidth + 1)`. */
  band: Float64Array;
  rhs: Float64Array;
  step: Float64Array;
  /** Free-slot list and inverse map (slot → free-index). */
  freeIdx: Int32Array;
  freeRank: Int32Array;
  /** Sized to support the current cluster's (m, totalNNZ, bandwidth, nf). */
  capacityM: number;
  capacityNNZ: number;
  capacityBandLen: number;
  capacityNf: number;
}

export function makeSparseScratch(): SparseScratch {
  return {
    r: new Float64Array(0),
    r2: new Float64Array(0),
    rSaved: new Float64Array(0),
    jVal: new Float64Array(0),
    jRow: new Int32Array(0),
    jCol: new Int32Array(0),
    band: new Float64Array(0),
    rhs: new Float64Array(0),
    step: new Float64Array(0),
    freeIdx: new Int32Array(0),
    freeRank: new Int32Array(0),
    capacityM: 0,
    capacityNNZ: 0,
    capacityBandLen: 0,
    capacityNf: 0,
  };
}

function ensureScratch(s: SparseScratch, m: number, nnz: number, bandLen: number, nf: number): void {
  if (s.capacityM < m) {
    s.r = new Float64Array(m);
    s.r2 = new Float64Array(m);
    s.rSaved = new Float64Array(m);
    s.capacityM = m;
  }
  if (s.capacityNNZ < nnz) {
    s.jVal = new Float64Array(nnz);
    s.jRow = new Int32Array(nnz);
    s.jCol = new Int32Array(nnz);
    s.capacityNNZ = nnz;
  }
  if (s.capacityBandLen < bandLen) {
    s.band = new Float64Array(bandLen);
    s.capacityBandLen = bandLen;
  }
  if (s.capacityNf < nf) {
    s.rhs = new Float64Array(nf);
    s.step = new Float64Array(nf);
    s.freeIdx = new Int32Array(nf);
    s.freeRank = new Int32Array(nf);
    s.capacityNf = nf;
  }
}

// ─── Banded Cholesky (lower band storage) ────────────────────────────
//
// Storage: `band[i × (b + 1) + c]` represents `A[i][i - b + c]` for
// `c ∈ [0, b]`. The diagonal is at `c = b`. We don't store the upper
// band — the matrix is symmetric.

/** In-place banded Cholesky factorization. Returns false if not PD. */
export function bandedCholesky(A: Float64Array, n: number, b: number): boolean {
  const stride = b + 1;
  for (let i = 0; i < n; i++) {
    const rowI = i * stride;
    // Compute L[i][j] for j ∈ [max(0, i-b), i-1].
    const jStart = Math.max(0, i - b);
    for (let j = jStart; j < i; j++) {
      const ci = j - i + b;
      let s = A[rowI + ci]!;
      const kStart = Math.max(0, i - b, j - b);
      const rowJ = j * stride;
      for (let k = kStart; k < j; k++) {
        const cik = k - i + b;
        const cjk = k - j + b;
        s -= A[rowI + cik]! * A[rowJ + cjk]!;
      }
      const Ljj = A[rowJ + b]!;
      if (Ljj === 0) return false;
      A[rowI + ci] = s / Ljj;
    }
    // Diagonal: L[i][i] = sqrt(A[i][i] - Σ L[i][k]²)
    let d = A[rowI + b]!;
    const kStart = Math.max(0, i - b);
    for (let k = kStart; k < i; k++) {
      const cik = k - i + b;
      const lik = A[rowI + cik]!;
      d -= lik * lik;
    }
    if (d <= 0) return false;
    A[rowI + b] = Math.sqrt(d);
  }
  return true;
}

export function bandedCholeskySolve(
  A: Float64Array,
  rhs: Float64Array,
  n: number,
  b: number,
  x: Float64Array,
): void {
  const stride = b + 1;
  // Forward solve L y = rhs (y in x).
  for (let i = 0; i < n; i++) {
    const rowI = i * stride;
    let s = rhs[i]!;
    const jStart = Math.max(0, i - b);
    for (let j = jStart; j < i; j++) {
      s -= A[rowI + (j - i + b)]! * x[j]!;
    }
    x[i] = s / A[rowI + b]!;
  }
  // Back solve L^T x = y.
  for (let i = n - 1; i >= 0; i--) {
    const rowI = i * stride;
    let s = x[i]!;
    const jEnd = Math.min(n - 1, i + b);
    for (let j = i + 1; j <= jEnd; j++) {
      // L^T[i][j] = L[j][i]
      const rowJ = j * stride;
      s -= A[rowJ + (i - j + b)]! * x[j]!;
    }
    x[i] = s / A[rowI + b]!;
  }
}

// ─── Sparse Newton-LM ───────────────────────────────────────────────

export interface SparseNewtonOpts {
  maxIters?: number;
  tol?: number;
  damping?: number;
  fdStep?: number;
}

export interface SparseNewtonResult {
  converged: boolean;
  residual: number;
  iters: number;
  lambda: number;
}

export function dampedNewtonSparse(
  x: number[],
  R: (x: readonly number[], out: Float64Array) => void,
  Rsubset: (x: readonly number[], which: readonly number[], out: Float64Array) => void,
  m: number,
  pinned: readonly boolean[],
  info: SparseInfo,
  scratch: SparseScratch,
  opts: SparseNewtonOpts = {},
): SparseNewtonResult {
  const n = x.length;
  const maxIters = opts.maxIters ?? 8;
  const tol = opts.tol ?? 1e-9;
  let lambda = opts.damping ?? 1e-6;
  const fdStep = opts.fdStep ?? 1e-6;
  const bw = info.bandwidth;

  // Build free-slot list.
  let nf = 0;
  for (let i = 0; i < n; i++) if (!pinned[i]) nf++;

  ensureScratch(scratch, m, info.totalNNZ, nf * (bw + 1), nf);
  const { r, r2, rSaved, jVal, jRow, jCol, band, rhs, step, freeIdx, freeRank } = scratch;
  for (let i = 0; i < n; i++) freeRank[i] = -1;
  // Build freeIdx in RCM rank order. Free-slot positions in the
  // band matrix end up minimising bandwidth this way.
  let fi = 0;
  for (let rank = 0; rank < n; rank++) {
    const i = info.slotByRank[rank]!;
    if (!pinned[i]) {
      freeIdx[fi] = i;
      freeRank[i] = fi;
      fi++;
    }
  }

  R(x, r);
  let rn = residualNormFloat(r, m);
  if (nf === 0) return { converged: rn <= tol, residual: rn, iters: 0, lambda };
  if (rn <= tol) return { converged: true, residual: rn, iters: 0, lambda };
  if (!Number.isFinite(rn)) return { converged: false, residual: rn, iters: 0, lambda };

  let iters = 0;
  for (; iters < maxIters; iters++) {
    // ── Sparse FD Jacobian (slot-major) ──
    let nnz = 0;
    for (let jf = 0; jf < nf; jf++) {
      const idx = freeIdx[jf]!;
      const affected = info.slotConstraints[idx]!;
      if (affected.length === 0) continue;
      // Save residuals at affected indices.
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
    // Build rhs = Jᵀ r in same pass.
    band.fill(0, 0, nf * (bw + 1));
    for (let jf = 0; jf < nf; jf++) rhs[jf] = 0;
    // Group nnz entries by row (constraint). Cheaper than rebuilding
    // a per-call grouping array: since each constraint's nnz entries
    // were added consecutively per slot, they're not row-grouped.
    // For symmetric outer product, walk all pairs: O(nnz²) worst
    // case, but we exploit that rows with at most |Cᵢ| nnz contribute
    // |Cᵢ|² entries — capped.
    {
      // Group nnz triples by row (constraint index) using a stable
      // counting sort — O(nnz + m), worst-case independent of input
      // order. Plain insertion sort would degrade to O(nnz²) on
      // reverse-sorted input (which RCM ordering can produce).
      const perm =
        scratch._perm && scratch._perm.length >= nnz
          ? scratch._perm
          : (scratch._perm = new Int32Array(Math.max(nnz, info.totalNNZ)));
      const rowCount =
        scratch._rowCount && scratch._rowCount.length >= m
          ? scratch._rowCount
          : (scratch._rowCount = new Int32Array(m));
      const rowFill =
        scratch._rowFill && scratch._rowFill.length >= m
          ? scratch._rowFill
          : (scratch._rowFill = new Int32Array(m));
      // Reset counters used this iter.
      for (let i = 0; i < m; i++) {
        rowCount[i] = 0;
        rowFill[i] = 0;
      }
      for (let k = 0; k < nnz; k++) rowCount[jRow[k]!]!++;
      // Prefix-sum to get bucket starts.
      const rowStart = scratch._rowStart && scratch._rowStart.length >= m
        ? scratch._rowStart
        : (scratch._rowStart = new Int32Array(m));
      let acc = 0;
      for (let i = 0; i < m; i++) {
        rowStart[i] = acc;
        acc += rowCount[i]!;
      }
      // Place each nnz index at its bucket position (stable order).
      for (let k = 0; k < nnz; k++) {
        const row = jRow[k]!;
        perm[rowStart[row]! + rowFill[row]!]! = k;
        rowFill[row]!++;
      }
      const pp = perm;
      // Walk row blocks.
      let s = 0;
      while (s < nnz) {
        let e = s + 1;
        const rowVal = jRow[pp[s]!]!;
        while (e < nnz && jRow[pp[e]!]! === rowVal) e++;
        // Block [s..e) all share row = rowVal.
        for (let a = s; a < e; a++) {
          const ka = pp[a]!;
          const ca = jCol[ka]!;
          const va = jVal[ka]!;
          // rhs += J^T r
          rhs[ca]! += va * r[rowVal]!;
          // Diagonal of JᵀJ at col ca, plus pairs with cb ≤ ca (lower band only).
          for (let b2 = a; b2 >= s; b2--) {
            const kb = pp[b2]!;
            const cb = jCol[kb]!;
            const vb = jVal[kb]!;
            const hi = ca > cb ? ca : cb;
            const lo = ca < cb ? ca : cb;
            if (hi - lo > bw) continue;
            const c = lo - hi + bw;
            band[hi * (bw + 1) + c]! += va * vb;
          }
        }
        s = e;
      }
      // Add λI on the diagonal.
      for (let i = 0; i < nf; i++) band[i * (bw + 1) + bw]! += lambda;
    }

    // ── Cholesky factor + solve ──
    if (!bandedCholesky(band, nf, bw)) {
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
    const rn2 = residualNormFloat(r2, m);

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

declare module "./solvers-sparse" {
  interface SparseScratch {
    _perm?: Int32Array;
    _rowCount?: Int32Array;
    _rowFill?: Int32Array;
    _rowStart?: Int32Array;
  }
}

function residualNormFloat(r: Float64Array, m: number): number {
  let s = 0;
  for (let i = 0; i < m; i++) s += r[i]! * r[i]!;
  return Math.sqrt(s);
}
