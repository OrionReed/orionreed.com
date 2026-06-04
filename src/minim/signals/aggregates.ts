// aggregates.ts — N→1 aggregate lens primitives over `Cls.lens` /
// `Cls.derive`.
//
// All route through the engine's N-input lens path. Stateless-bwd
// (`(target) => updates`) skips the peek loop on the hot path;
// stateful-bwd (`(target, vals) => updates`) reads the scratch.

import type { Cell, Writable } from "./signal";
import type { Linear } from "./traits";
import { Num } from "./values/num";
import { Vec } from "./values/vec";

type V = { x: number; y: number };

// ─── Linear-aggregate merges (Num + Vec, etc.) ──────────────────────

/** Equal-weight mean of N Linear values; writes distribute the delta evenly. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape, mirrors Cls.lens
export function meanLens<T, C extends new (...args: never[]) => Cell<any>>(
  Cls: C,
  parents: readonly Cell<T>[],
): Writable<InstanceType<C>> {
  const lin = ((Cls as unknown as { traits?: { linear?: Linear<T> } }).traits?.linear ??
    (() => {
      throw new Error("meanLens: value class has no 'linear' trait");
    })()) as Linear<T>;
  const n = parents.length;
  const inv = 1 / n;

  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Cls.lens
  return (Cls as any).lens(
    parents as never,
    // biome-ignore lint/suspicious/noExplicitAny: tuple-vs-array variance
    (vals: any) => {
      let acc = vals[0] as T;
      for (let i = 1; i < n; i++) acc = lin.add(acc, vals[i]);
      return lin.scale(acc, inv);
    },
    // biome-ignore lint/suspicious/noExplicitAny: tuple-vs-array variance
    (target: any, vals: any) => {
      let cur = vals[0] as T;
      for (let i = 1; i < n; i++) cur = lin.add(cur, vals[i]);
      cur = lin.scale(cur, inv);
      const delta = lin.sub(target as T, cur);
      const out = new Array<T>(n);
      for (let i = 0; i < n; i++) out[i] = lin.add(vals[i], delta);
      return out as never;
    },
  );
}

// ─── Vec aggregates (geometric helpers) ─────────────────────────────

/** Midpoint of two writable Vecs. Drag-translates both endpoints. */
export function midpointLens(a: Cell<V>, b: Cell<V>): Writable<Vec> {
  return Vec.lens(
    [a, b] as const,
    vals => {
      const [av, bv] = vals;
      return { x: (av.x + bv.x) / 2, y: (av.y + bv.y) / 2 };
    },
    (target, vals) => {
      const [av, bv] = vals;
      const dx = target.x - (av.x + bv.x) / 2;
      const dy = target.y - (av.y + bv.y) / 2;
      return [
        { x: av.x + dx, y: av.y + dy },
        { x: bv.x + dx, y: bv.y + dy },
      ];
    },
  );
}

/** Centroid of N writable Vecs. Drag-translates all members. */
export function centroidLens(parents: readonly Cell<V>[]): Writable<Vec> {
  const n = parents.length;
  const inv = 1 / n;
  return Vec.lens(
    parents as never,
    vals => {
      const arr = vals as readonly V[];
      let sx = 0,
        sy = 0;
      for (let i = 0; i < n; i++) {
        sx += arr[i]!.x;
        sy += arr[i]!.y;
      }
      return { x: sx * inv, y: sy * inv };
    },
    (target, vals) => {
      const arr = vals as readonly V[];
      let sx = 0,
        sy = 0;
      for (let i = 0; i < n; i++) {
        sx += arr[i]!.x;
        sy += arr[i]!.y;
      }
      const dx = target.x - sx * inv;
      const dy = target.y - sy * inv;
      const out = new Array(n) as V[];
      for (let i = 0; i < n; i++) {
        out[i] = { x: arr[i]!.x + dx, y: arr[i]!.y + dy };
      }
      return out as never;
    },
  );
}

// ─── Argmin via the lens primitive (numerical pseudoinverse) ────────
//
// N-input lens via weighted least squares: one Newton-pseudoinverse
// step per write. `forward` computes the output; `weights` controls
// which inputs absorb the residual (0 = frozen, larger = absorbs more).
// Many policies are just weight choices (polar's four, mean's [1…1],
// pulley's [1,1], IK over joint angles).
//
// Jacobian is finite-differenced (N+1 forward evals per write);
// Levenberg-Marquardt damping avoids blow-up near rank-deficiency.

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

/** Target-shaping for `argminVec`: project a write into the reachable
 *  workspace before the Jacobian step, sidestepping the rank-deficient
 *  swings at the boundary. For an N-link chain rooted at `R` with reach
 *  `L`, pass `clampToDisc(R, L)`. */
export interface ArgminVecOpts extends ArgminOpts {
  /** Pre-write hook: transform the requested target into one that's
   *  guaranteed solvable. Most useful as a workspace clamp. */
  clampTarget?: (
    target: { x: number; y: number },
    currentInputs: readonly number[],
  ) => { x: number; y: number };
}

/** Project `p` into the closed disc of radius `r` centred on `c` (points
 *  inside pass through). Use as `argminVec`'s `clampTarget` to fix IK
 *  explosion at maximum reach. */
export function clampToDisc(
  c: { x: number; y: number },
  r: number,
): (p: { x: number; y: number }) => { x: number; y: number } {
  return p => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d <= r) return p;
    const k = r / d;
    return { x: c.x + dx * k, y: c.y + dy * k };
  };
}

/** Scalar-output argmin lens: write does one Newton step against the FD
 *  Jacobian, distributing the residual by `weights`. For typed/multi-
 *  output cases use `factor()`; this M=1 path is kept for its hand-rolled
 *  inner loop. */
export function argminNum(
  inputs: readonly Num[],
  forward: (xs: readonly number[]) => number,
  weights: readonly number[],
  opts: ArgminOpts = {},
): Writable<Num> {
  if (weights.length !== inputs.length) {
    throw new Error("argminNum: weights/inputs length mismatch");
  }
  const eps = opts.eps ?? 1e-4;
  const damping = opts.damping ?? 1e-6;
  const n = inputs.length;
  // Pre-allocated to avoid per-write allocations.
  const J = new Array<number>(n);
  const out = new Array<number | undefined>(n);
  return Num.lens(
    inputs as never,
    vals => forward(vals as readonly number[]),
    (target, vals) => {
      const xs = vals as number[];
      const y0 = forward(xs);
      const dy = target - y0;
      for (let i = 0; i < n; i++) {
        const saved = xs[i]!;
        xs[i] = saved + eps;
        J[i] = (forward(xs) - y0) / eps;
        xs[i] = saved;
      }
      let denom = damping;
      for (let i = 0; i < n; i++) denom += weights[i]! * J[i]! * J[i]!;
      const k = dy / denom;
      for (let i = 0; i < n; i++) {
        if (weights[i] === 0) {
          out[i] = undefined;
        } else {
          out[i] = xs[i]! + weights[i]! * J[i]! * k;
        }
      }
      return out as never;
    },
  );
}

/** 2D-output argmin lens (scalar Num inputs, `{x, y}` forward). For IK
 *  arms, draggable points, handle projection. Kept for its hand-rolled
 *  2×2 inverse + `clampTarget` hook; see `factor()` for other M. */
export function argminVec(
  inputs: readonly Num[],
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
  const n = inputs.length;
  // Pre-allocated to avoid per-write allocations.
  const Jx = new Array<number>(n);
  const Jy = new Array<number>(n);
  const out = new Array<number | undefined>(n);
  return Vec.lens(
    inputs as never,
    vals => forward(vals as readonly number[]),
    (rawTarget, vals) => {
      const xs = vals as number[];
      const target = clamp ? clamp(rawTarget, xs) : rawTarget;
      const y0 = forward(xs);
      const dx = target.x - y0.x;
      const dy = target.y - y0.y;
      for (let i = 0; i < n; i++) {
        const saved = xs[i]!;
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
      for (let i = 0; i < n; i++) {
        const w = weights[i]!;
        a += w * Jx[i]! * Jx[i]!;
        b += w * Jx[i]! * Jy[i]!;
        c += w * Jy[i]! * Jy[i]!;
      }
      const det = a * c - b * b;
      if (Math.abs(det) < 1e-14) {
        // Singular; leave inputs unchanged.
        for (let i = 0; i < n; i++) out[i] = undefined;
        return out as never;
      }
      const invA = c / det;
      const invB = -b / det;
      const invC = a / det;
      const kx = invA * dx + invB * dy;
      const ky = invB * dx + invC * dy;
      for (let i = 0; i < n; i++) {
        const w = weights[i]!;
        if (w === 0) {
          out[i] = undefined;
        } else {
          out[i] = xs[i]! + w * (Jx[i]! * kx + Jy[i]! * ky);
        }
      }
      return out as never;
    },
  );
}
