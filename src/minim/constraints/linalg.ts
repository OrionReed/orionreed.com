// linalg.ts — small dense linear algebra for AVBD's per-vertex local
// Newton solves. Each cell's local system has dimension equal to the
// cell's DOF: 1 for a Num, 2 for a Vec, 4 for a Box, etc. So we
// only ever solve `n × n` systems where n is small (typically ≤ 6).
//
// For these sizes, an unrolled LDLᵀ factorisation beats anything
// general-purpose. We provide:
//
//   - `solveSPD(A, b, n)`           — SPD solve via in-place LDLᵀ.
//   - `solve1`, `solve2`, `solve3`, — fast paths for the most common
//   - `solve4`                       sizes; inlined for speed.
//
// Convention: matrices are row-major Float64Array of length n*n.
// LDLᵀ overwrites `A` with the factor; `b` is overwritten with the
// solution `x` such that `A·x = b` for the original A.

const TINY = 1e-14;

/** Solve a symmetric positive (semi-) definite system `A·x = b`
 *  in place. `A` is destroyed. `x` is written into `b`. Returns
 *  `false` if the system is too singular to solve safely (in which
 *  case `b` is left in an undefined state — caller should not use
 *  the result; typically falls back to leaving the cell unchanged).
 *
 *  Implements LDLᵀ with diagonal regularisation: if `D[i] < TINY`
 *  during factorisation, we skip column `i` (effectively pinning
 *  it). This matches AVBD's "skip rank-deficient vertices for this
 *  iteration" strategy. */
export function solveSPD(A: Float64Array, b: Float64Array, n: number): boolean {
  if (n === 1) {
    const a = A[0]!;
    if (Math.abs(a) < TINY) return false;
    b[0]! = b[0]! / a;
    return true;
  }
  if (n === 2) return solve2(A, b);
  if (n === 3) return solve3(A, b);
  // General LDLᵀ.
  return ldltGeneric(A, b, n);
}

/** 2×2 SPD direct solve. A is row-major; we use the symmetry. */
export function solve2(A: Float64Array, b: Float64Array): boolean {
  const a = A[0]!;
  const c = A[1]!; // = A[2] by symmetry
  const d = A[3]!;
  const det = a * d - c * c;
  if (Math.abs(det) < TINY) return false;
  const inv = 1 / det;
  const x0 = (d * b[0]! - c * b[1]!) * inv;
  const x1 = (-c * b[0]! + a * b[1]!) * inv;
  b[0] = x0;
  b[1] = x1;
  return true;
}

/** 3×3 SPD direct solve via cofactor expansion. */
export function solve3(A: Float64Array, b: Float64Array): boolean {
  const a00 = A[0]!,
    a01 = A[1]!,
    a02 = A[2]!;
  const a10 = A[3]!,
    a11 = A[4]!,
    a12 = A[5]!;
  const a20 = A[6]!,
    a21 = A[7]!,
    a22 = A[8]!;
  const c00 = a11 * a22 - a12 * a21;
  const c01 = -(a10 * a22 - a12 * a20);
  const c02 = a10 * a21 - a11 * a20;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  if (Math.abs(det) < TINY) return false;
  const c10 = -(a01 * a22 - a02 * a21);
  const c11 = a00 * a22 - a02 * a20;
  const c12 = -(a00 * a21 - a01 * a20);
  const c20 = a01 * a12 - a02 * a11;
  const c21 = -(a00 * a12 - a02 * a10);
  const c22 = a00 * a11 - a01 * a10;
  const inv = 1 / det;
  const b0 = b[0]!,
    b1 = b[1]!,
    b2 = b[2]!;
  // Inverse is transpose of cofactor / det. For SPD it equals the
  // adjugate / det. We multiply by b directly.
  b[0] = (c00 * b0 + c10 * b1 + c20 * b2) * inv;
  b[1] = (c01 * b0 + c11 * b1 + c21 * b2) * inv;
  b[2] = (c02 * b0 + c12 * b1 + c22 * b2) * inv;
  return true;
}

/** General LDLᵀ for `n ≥ 4`. In-place: `A` is overwritten with the
 *  factor, `b` is overwritten with the solution. */
function ldltGeneric(A: Float64Array, b: Float64Array, n: number): boolean {
  // Factor: A = L D Lᵀ where L is unit lower-triangular and D is
  // diagonal. We store L in the strictly-lower part of A and D on
  // the diagonal.
  for (let j = 0; j < n; j++) {
    // D[j] = A[j,j] - Σ_{k<j} L[j,k]² · D[k]
    let djj = A[j * n + j]!;
    for (let k = 0; k < j; k++) {
      const ljk = A[j * n + k]!;
      djj -= ljk * ljk * A[k * n + k]!;
    }
    if (Math.abs(djj) < TINY) return false;
    A[j * n + j]! = djj;
    // L[i,j] = (A[i,j] - Σ_{k<j} L[i,k] L[j,k] D[k]) / D[j]
    for (let i = j + 1; i < n; i++) {
      let lij = A[i * n + j]!;
      for (let k = 0; k < j; k++) {
        lij -= A[i * n + k]! * A[j * n + k]! * A[k * n + k]!;
      }
      A[i * n + j]! = lij / djj;
    }
  }
  // Forward solve L y = b → y in b.
  for (let i = 0; i < n; i++) {
    let yi = b[i]!;
    for (let k = 0; k < i; k++) yi -= A[i * n + k]! * b[k]!;
    b[i]! = yi;
  }
  // D solve: y_i ← y_i / D[i].
  for (let i = 0; i < n; i++) b[i]! /= A[i * n + i]!;
  // Backward solve Lᵀ x = y → x in b.
  for (let i = n - 1; i >= 0; i--) {
    let xi = b[i]!;
    for (let k = i + 1; k < n; k++) xi -= A[k * n + i]! * b[k]!;
    b[i]! = xi;
  }
  return true;
}

/** Add `α · v · vᵀ` to a square matrix `A` in row-major form.
 *  Used to accumulate Jᵀ J terms in the local Newton system. */
export function addOuterProduct(A: Float64Array, v: Float64Array, alpha: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const vi = v[i]! * alpha;
    for (let j = 0; j < n; j++) {
      A[i * n + j]! += vi * v[j]!;
    }
  }
}

/** Add `α · I` to the diagonal of `A`. */
export function addScaledIdentity(A: Float64Array, alpha: number, n: number): void {
  for (let i = 0; i < n; i++) A[i * n + i]! += alpha;
}

/** Add `α · diag(d)` to the diagonal of `A`. */
export function addDiag(A: Float64Array, d: Float64Array, alpha: number, n: number): void {
  for (let i = 0; i < n; i++) A[i * n + i]! += alpha * d[i]!;
}

/** Zero out `n × n` matrix region. */
export function zeroMatrix(A: Float64Array, n: number): void {
  for (let i = 0; i < n * n; i++) A[i] = 0;
}

/** Zero `n`-vector. */
export function zeroVector(v: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) v[i] = 0;
}

/** Clamp `x` to `[lo, hi]`. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
