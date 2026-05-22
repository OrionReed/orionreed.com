// _proto-policy/policy.ts — sandbox: unify polar's policy enum with
// argminVec's weight vector under one primitive.
//
// Hypothesis: every "N inputs → 1 output, write back with policy"
// lens fits the same shape:
//
//   policyLensVec(inputs, forward, weights, { inverse? })
//
// Where:
//   - `weights` is a number[]; per-input absorption coefficient.
//      0 = frozen; 1 = uniform; higher = preferred absorber.
//   - `inverse` is optional. If provided, used directly (closed-form
//      fast path). If absent, finite-difference Jacobian + LM step
//      (the argmin fallback).
//
// Then `polar(...,"circular")` and `argminVec(...)` are both wrappers
// over this primitive — the closed-form polar provides `inverse`; the
// numerical argmin doesn't.

import { batch, lensCls } from "../signal";
import { Num } from "../values/num";
import { Vec } from "../values/vec";
import { type Writable } from "../writable";

export interface PolicyLensVecOpts {
  /** Finite-difference epsilon for the Jacobian (numerical fallback). */
  eps?: number;
  /** Levenberg-Marquardt damping (numerical fallback). */
  damping?: number;
  /** Optional closed-form inverse. If provided, used directly — skips
   *  the Jacobian. Receives the (possibly clamped) target, current
   *  input values, and weights; returns the new input values. */
  inverse?: (
    target: { x: number; y: number },
    currentInputs: readonly number[],
    weights: readonly number[],
  ) => readonly number[];
  /** Pre-write hook (e.g. clamp into the workspace disc). */
  clampTarget?: (
    target: { x: number; y: number },
    currentInputs: readonly number[],
  ) => { x: number; y: number };
}

/** 2D-output policy lens. Subsumes both `polar` (closed-form, via
 *  `inverse`) and `argminVec` (numerical, via finite-difference). */
export function policyLensVec(
  inputs: readonly Writable<Num>[],
  forward: (xs: readonly number[]) => { x: number; y: number },
  weights: readonly number[],
  opts: PolicyLensVecOpts = {},
): Writable<Vec> {
  if (weights.length !== inputs.length) {
    throw new Error("policyLensVec: weights/inputs length mismatch");
  }
  const eps = opts.eps ?? 1e-4;
  const damping = opts.damping ?? 1e-3;
  const clamp = opts.clampTarget;
  const userInverse = opts.inverse;

  return lensCls(
    Vec,
    () => forward(inputs.map(i => i.value)),
    rawTarget => {
      const xs = inputs.map(i => i.peek());
      const target = clamp ? clamp(rawTarget, xs) : rawTarget;

      // Closed-form path: ask the user for the new inputs.
      if (userInverse) {
        const newXs = userInverse(target, xs, weights);
        batch(() => {
          for (let i = 0; i < inputs.length; i++) {
            if (weights[i] === 0) continue;
            inputs[i].value = newXs[i];
          }
        });
        return;
      }

      // Numerical path: finite-difference Jacobian + damped LM step.
      const y0 = forward(xs);
      const dx = target.x - y0.x;
      const dy = target.y - y0.y;
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
      let a = damping,
        b = 0,
        c = damping;
      for (let i = 0; i < xs.length; i++) {
        const w = weights[i];
        a += w * Jx[i] * Jx[i];
        b += w * Jx[i] * Jy[i];
        c += w * Jy[i] * Jy[i];
      }
      const det = a * c - b * b;
      if (Math.abs(det) < 1e-14) return;
      const invA = c / det,
        invB = -b / det,
        invC = a / det;
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

// ── Derived wrappers ─────────────────────────────────────────────

const TAU = 2 * Math.PI;
const wrapToPi = (x: number) => x - TAU * Math.round(x / TAU);
const nearestAngle = (target: number, current: number) => current + wrapToPi(target - current);

export type PolarPolicy = "rotate" | "translate" | "radial" | "circular";

/** Polar lens via policyLens. Closed-form inverse for performance and
 *  for the nearest-angle (shortest-arc) semantics on cyclic writes. */
export function polarViaPolicy(
  cx: Writable<Num>,
  cy: Writable<Num>,
  r: Writable<Num>,
  a: Writable<Num>,
  policy: PolarPolicy = "rotate",
): Writable<Vec> {
  const w =
    policy === "rotate"
      ? [0, 0, 1, 1]
      : policy === "translate"
        ? [1, 1, 0, 0]
        : policy === "radial"
          ? [0, 0, 1, 0]
          : [0, 0, 0, 1];
  return policyLensVec(
    [cx, cy, r, a],
    ([Cx, Cy, R, A]) => ({ x: Cx + R * Math.cos(A), y: Cy + R * Math.sin(A) }),
    w,
    {
      inverse: (p, [Cx, Cy, R, A], ww) => {
        const fx = Cx + R * Math.cos(A);
        const fy = Cy + R * Math.sin(A);
        const dxw = p.x - Cx,
          dyw = p.y - Cy;
        return [
          ww[0] > 0 ? Cx + (p.x - fx) : Cx,
          ww[1] > 0 ? Cy + (p.y - fy) : Cy,
          ww[2] > 0 ? Math.hypot(dxw, dyw) : R,
          ww[3] > 0 ? nearestAngle(Math.atan2(dyw, dxw), A) : A,
        ];
      },
    },
  );
}

/** argminVec re-expressed as policyLens with no closed-form inverse —
 *  the numerical path is the default. Same semantics as the existing
 *  argminVec; included here just to verify the consolidation. */
export function argminVecViaPolicy(
  inputs: readonly Writable<Num>[],
  forward: (xs: readonly number[]) => { x: number; y: number },
  weights: readonly number[],
  opts: PolicyLensVecOpts = {},
): Writable<Vec> {
  return policyLensVec(inputs, forward, weights, opts);
}
