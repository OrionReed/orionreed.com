// argmin.ts — generalised N-input lens via weighted least squares.
//
// One Newton-pseudoinverse step per write. Each input is a writable
// Num; `forward` computes the output from current inputs; `weights`
// controls which inputs absorb the residual (0 = frozen, 1 = uniform,
// larger = absorbs more).
//
// This is the unifying primitive for "drag a derived value, multiple
// upstream knobs adjust." Specializations:
//
//   - polar's four policies (rotate / translate / radial / circular)
//     are weight choices on [cx, cy, r, a].
//   - mean's even-distribution is weights [1, 1, …, 1] on summed inputs.
//   - pulley conservation is [1, 1] on `a + b`.
//   - IK is finite-difference Jacobian on N joint angles → 2D tip.
//
// Jacobian is finite-differenced (no autodiff dep). For N inputs the
// per-write cost is N+1 forward evaluations. Damping (Levenberg-
// Marquardt) avoids blow-up near rank-deficient configurations.

import { batch, lensCls } from "./signal";
import { Num } from "./values/num";
import { Vec } from "./values/vec";
import { type Writable } from "./writable";

export interface ArgminOpts {
  /** Finite-difference epsilon for the Jacobian. Default 1e-4. */
  eps?: number;
  /** Levenberg-Marquardt damping. Default `1e-6` for `argminNum`
   *  (Jacobian is always well-conditioned for linear constraints) and
   *  `1e-3` for `argminVec` (IK chains hit rank-deficient regimes at
   *  full extension). Larger → smaller, more stable updates; smaller
   *  → closer to pure pseudoinverse. */
  damping?: number;
}

/** Optional target-shaping for `argminVec`. Lets callers project an
 *  incoming write into the algorithm's reachable workspace BEFORE the
 *  Jacobian step — sidesteps the rank-deficient regime that causes
 *  unbounded swings at the workspace boundary.
 *
 *  For an N-link chain rooted at `R` with total reach `L`, pass
 *  `clampToDisc(R, L)`. The arm reaches the boundary cleanly and stops
 *  trying to extend further. */
export interface ArgminVecOpts extends ArgminOpts {
  /** Pre-write hook: transform the requested target into one that's
   *  guaranteed solvable. Most useful as a workspace clamp. */
  clampTarget?: (
    target: { x: number; y: number },
    currentInputs: readonly number[],
  ) => { x: number; y: number };
}

/** Project `p` into the closed disc of radius `r` centred on `c`. If
 *  inside, returned unchanged; outside, returned at the boundary. Pass
 *  to `argminVec`'s `clampTarget` as the principled fix for IK
 *  explosion at maximum reach. */
export function clampToDisc(
  c: { x: number; y: number },
  r: number,
): (p: { x: number; y: number }) => { x: number; y: number } {
  return (p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d <= r) return p;
    const k = r / d;
    return { x: c.x + dx * k, y: c.y + dy * k };
  };
}

/** Scalar-output argmin lens.
 *
 *  Reads: `forward(currentInputs)`. Writes: one Newton step toward
 *  `target`, distributing into inputs according to `weights`. */
export function argminNum(
  inputs: readonly Writable<Num>[],
  forward: (xs: readonly number[]) => number,
  weights: readonly number[],
  opts: ArgminOpts = {},
): Writable<Num> {
  if (weights.length !== inputs.length) {
    throw new Error("argminNum: weights/inputs length mismatch");
  }
  const eps = opts.eps ?? 1e-4;
  const damping = opts.damping ?? 1e-6;
  return lensCls(
    Num,
    () => forward(inputs.map((i) => i.value)),
    (target) => {
      const xs = inputs.map((i) => i.peek());
      const y0 = forward(xs);
      const dy = target - y0;
      // J[i] = ∂y/∂xᵢ (forward diff).
      const J: number[] = new Array(xs.length);
      for (let i = 0; i < xs.length; i++) {
        const saved = xs[i];
        xs[i] = saved + eps;
        J[i] = (forward(xs) - y0) / eps;
        xs[i] = saved;
      }
      // Δx = W·Jᵀ·(J·W·Jᵀ + λI)⁻¹·dy. Scalar output: J·W·Jᵀ = Σ wᵢJᵢ².
      let denom = damping;
      for (let i = 0; i < J.length; i++) denom += weights[i] * J[i] * J[i];
      const k = dy / denom;
      batch(() => {
        for (let i = 0; i < inputs.length; i++) {
          if (weights[i] === 0) continue;
          inputs[i].value = xs[i] + weights[i] * J[i] * k;
        }
      });
    },
  ) as unknown as Writable<Num>;
}

/** 2D-output argmin lens.
 *
 *  Inputs are scalar Nums; forward returns `{x, y}`. Enough for IK
 *  arms, multi-input draggable points, parametric handle projection,
 *  etc. For Vec inputs, decompose to pairs of Nums at the call site
 *  (use `vec.x` / `vec.y` field lenses). */
export function argminVec(
  inputs: readonly Writable<Num>[],
  forward: (xs: readonly number[]) => { x: number; y: number },
  weights: readonly number[],
  opts: ArgminVecOpts = {},
): Writable<Vec> {
  if (weights.length !== inputs.length) {
    throw new Error("argminVec: weights/inputs length mismatch");
  }
  const eps = opts.eps ?? 1e-4;
  const damping = opts.damping ?? 1e-3;
  const clamp = opts.clampTarget;
  return lensCls(
    Vec,
    () => forward(inputs.map((i) => i.value)),
    (rawTarget) => {
      const xs = inputs.map((i) => i.peek());
      const target = clamp ? clamp(rawTarget, xs) : rawTarget;
      const y0 = forward(xs);
      const dx = target.x - y0.x;
      const dy = target.y - y0.y;
      // J[i] = (∂fx/∂xᵢ, ∂fy/∂xᵢ).
      const Jx: number[] = new Array(xs.length);
      const Jy: number[] = new Array(xs.length);
      for (let i = 0; i < xs.length; i++) {
        const saved = xs[i];
        xs[i] = saved + eps;
        const ye = forward(xs);
        xs[i] = saved;
        Jx[i] = (ye.x - y0.x) / eps;
        Jy[i] = (ye.y - y0.y) / eps;
      }
      // J·W·Jᵀ is the 2×2 [a b; b c]. Add damping to the diagonal, invert.
      let a = damping;
      let b = 0;
      let c = damping;
      for (let i = 0; i < xs.length; i++) {
        const w = weights[i];
        a += w * Jx[i] * Jx[i];
        b += w * Jx[i] * Jy[i];
        c += w * Jy[i] * Jy[i];
      }
      const det = a * c - b * b;
      if (Math.abs(det) < 1e-14) return; // singular — bail.
      const invA = c / det;
      const invB = -b / det;
      const invC = a / det;
      const kx = invA * dx + invB * dy;
      const ky = invB * dx + invC * dy;
      batch(() => {
        for (let i = 0; i < inputs.length; i++) {
          const w = weights[i];
          if (w === 0) continue;
          inputs[i].value = xs[i] + w * (Jx[i] * kx + Jy[i] * ky);
        }
      });
    },
  ) as unknown as Writable<Vec>;
}
