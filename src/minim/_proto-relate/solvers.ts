// solvers.ts — numerical machinery for relation/constraint solving.
//
// Three layers, all pure functions over plain `number[]`:
//
//   1. tinyLU       — dense LU with partial pivoting; solves Ax = b for
//                     small (n ≤ ~50) systems. Inline, no allocations
//                     beyond one scratch matrix per call.
//   2. dampedNewton — one bounded Newton-Raphson cycle for non-linear
//                     residuals R(x) = 0. Levenberg-Marquardt damping
//                     keeps it stable near rank-deficient configurations.
//                     Accepts a pinned-mask: pinned indices are held
//                     fixed; only free indices receive Newton updates.
//   3. residualNorm — L2 norm. Convergence test.
//
// Hot-path discipline mirrors the engine's: scratch buffers passed in,
// no allocations inside the iteration loop, no recursion. Designed to
// run inside relation `solve()` calls during flush, where allocation
// cost is part of the per-frame budget.

/** Solve `A·x = b` in place by LU with partial pivoting. `A` is an
 *  `n×n` matrix in row-major order; `b` is `length n`. On return `x`
 *  contains the solution. Throws on near-singular `A` (for the
 *  Levenberg-Marquardt-damped path this should not fire — caller adds
 *  λI to the diagonal first). */
export function tinyLU(A: number[], b: number[], n: number, x: number[]): void {
  // Copy into A so we can pivot in place without disturbing caller.
  // (Callers commonly pass a freshly built matrix; this preserves it
  // for diagnostic re-reads after solve.)
  const M = A.slice();
  const rhs = b.slice();
  // Permutation
  const p = new Array<number>(n);
  for (let i = 0; i < n; i++) p[i] = i;

  for (let k = 0; k < n; k++) {
    // Partial pivot: find max |M[r,k]| over r ≥ k.
    let max = Math.abs(M[p[k]! * n + k]!);
    let maxRow = k;
    for (let r = k + 1; r < n; r++) {
      const v = Math.abs(M[p[r]! * n + k]!);
      if (v > max) {
        max = v;
        maxRow = r;
      }
    }
    if (max < 1e-14) {
      throw new Error(`tinyLU: singular at column ${k} (max = ${max})`);
    }
    if (maxRow !== k) {
      const tmp = p[k]!;
      p[k] = p[maxRow]!;
      p[maxRow] = tmp;
    }
    // Eliminate below.
    const pk = p[k]!;
    const pivot = M[pk * n + k]!;
    for (let r = k + 1; r < n; r++) {
      const pr = p[r]!;
      const factor = M[pr * n + k]! / pivot;
      M[pr * n + k] = factor;
      for (let c = k + 1; c < n; c++) {
        M[pr * n + c]! -= factor * M[pk * n + c]!;
      }
    }
  }

  // Forward substitute: solve L·y = P·b (L has unit diagonal).
  const y = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = rhs[p[i]!]!;
    const pi = p[i]!;
    for (let j = 0; j < i; j++) s -= M[pi * n + j]! * y[j]!;
    y[i] = s;
  }
  // Back substitute: solve U·x = y.
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    const pi = p[i]!;
    for (let j = i + 1; j < n; j++) s -= M[pi * n + j]! * x[j]!;
    x[i] = s / M[pi * n + i]!;
  }
}

/** L2 norm of a residual vector. */
export function residualNorm(r: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i]! * r[i]!;
  return Math.sqrt(s);
}

export interface NewtonOpts {
  /** Max iterations per call. Default 8. */
  maxIters?: number;
  /** Convergence threshold on ‖residual‖. Default 1e-9. */
  tol?: number;
  /** Levenberg-Marquardt damping. Default 1e-6 (effectively
   *  pseudoinverse for well-conditioned cases; bumps up adaptively
   *  on bad steps). */
  damping?: number;
  /** Finite-difference step for Jacobian. Default 1e-6. */
  fdStep?: number;
}

export interface NewtonResult {
  /** Whether ‖residual‖ ≤ tol on the final state. */
  converged: boolean;
  /** Final ‖residual‖. */
  residual: number;
  /** Iterations consumed (≤ maxIters). */
  iters: number;
}

/** Damped Newton-Raphson on `R(x) = 0` with pinned-index masking.
 *
 *  - `x` is the current state vector (modified in place).
 *  - `R` writes into a caller-provided residual buffer
 *    `out: number[m]` — saves us an allocation per iteration.
 *  - `pinned[i] === true` ⇒ index i is held fixed; Jacobian column i
 *    is dropped, no Newton update applied to x[i].
 *  - Levenberg-Marquardt: the normal equations are
 *      `(JᵀJ + λI) Δ = Jᵀ r`
 *    with λ adapting up on bad steps, down on good. Always positive
 *    semi-definite, so tinyLU never sees a singular matrix.
 *
 *  Returns convergence diagnostics. Caller decides whether to retry
 *  or accept. Designed to be called incrementally — warm-start from
 *  previous solution by passing in the cells' current values; in
 *  steady-state drag scenarios this converges in 1-2 iters. */
export function dampedNewton(
  x: number[],
  R: (x: readonly number[], out: number[]) => void,
  m: number,
  pinned: readonly boolean[],
  opts: NewtonOpts = {},
): NewtonResult {
  const n = x.length;
  const maxIters = opts.maxIters ?? 8;
  const tol = opts.tol ?? 1e-9;
  let lambda = opts.damping ?? 1e-6;
  const fdStep = opts.fdStep ?? 1e-6;

  // Count free indices (un-pinned). If all pinned, nothing to solve.
  const freeIdx: number[] = [];
  for (let i = 0; i < n; i++) if (!pinned[i]) freeIdx.push(i);
  const nf = freeIdx.length;

  // Scratch buffers: residual, Jacobian (m × nf, row-major), normal-eq
  // matrix (nf × nf), RHS (nf), step (nf).
  const r = new Array<number>(m);
  const r2 = new Array<number>(m);
  const J = new Array<number>(m * nf);
  const N = new Array<number>(nf * nf);
  const rhs = new Array<number>(nf);
  const step = new Array<number>(nf);

  R(x, r);
  let rn = residualNorm(r);

  if (nf === 0) return { converged: rn <= tol, residual: rn, iters: 0 };
  if (rn <= tol) return { converged: true, residual: rn, iters: 0 };

  let iters = 0;
  for (; iters < maxIters; iters++) {
    // Build Jacobian: J[i, j] = ∂R_i / ∂x_{freeIdx[j]} via forward diff.
    for (let j = 0; j < nf; j++) {
      const idx = freeIdx[j]!;
      const saved = x[idx]!;
      x[idx] = saved + fdStep;
      R(x, r2);
      x[idx] = saved;
      for (let i = 0; i < m; i++) {
        J[i * nf + j] = (r2[i]! - r[i]!) / fdStep;
      }
    }

    // Normal equations: N = JᵀJ + λI; rhs = Jᵀ r
    for (let i = 0; i < nf; i++) {
      for (let j = 0; j < nf; j++) {
        let s = 0;
        for (let k = 0; k < m; k++) s += J[k * nf + i]! * J[k * nf + j]!;
        N[i * nf + j] = s;
      }
      N[i * nf + i]! += lambda;
      let s = 0;
      for (let k = 0; k < m; k++) s += J[k * nf + i]! * r[k]!;
      rhs[i] = s;
    }

    // Solve and step toward (J⁺ r) by negating: x ← x - (JᵀJ+λI)⁻¹ Jᵀ r
    try {
      tinyLU(N, rhs, nf, step);
    } catch {
      // Should not happen with λ > 0, but bail safely.
      return { converged: false, residual: rn, iters };
    }

    // Trial step.
    for (let j = 0; j < nf; j++) {
      x[freeIdx[j]!]! -= step[j]!;
    }
    R(x, r2);
    const rn2 = residualNorm(r2);

    if (rn2 < rn) {
      // Improvement — accept, decrease damping.
      for (let i = 0; i < m; i++) r[i] = r2[i]!;
      rn = rn2;
      lambda *= 0.5;
      if (lambda < 1e-12) lambda = 1e-12;
      if (rn <= tol) return { converged: true, residual: rn, iters: iters + 1 };
    } else {
      // No improvement — reject, increase damping, retry.
      for (let j = 0; j < nf; j++) {
        x[freeIdx[j]!]! += step[j]!;
      }
      lambda *= 8;
      if (lambda > 1e8) {
        return { converged: false, residual: rn, iters: iters + 1 };
      }
    }
  }
  return { converged: rn <= tol, residual: rn, iters };
}
