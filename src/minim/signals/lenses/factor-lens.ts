// =====================================================================
// factor-lens.ts — N→M lens prototypes (Vec-specific monoliths).
//
// N inputs → M coupled writable outputs, where writing one output
// preserves the readings of the other M−1 (cross-channel invariance).
// Two regimes:
//
//   1. Numerical (Jacobian-LSQ): `factorLens` builds an M×N Jacobian by
//      finite differences and solves `(J W Jᵀ + λI) k = δy` for `k`,
//      then writes `δx = W Jᵀ k`. δy is sparse (only the written
//      channel), so the solve leaves other channels near-stationary.
//      Invariance is approximate, set by the local condition number.
//
//   2. Closed-form (geometric): `procrustesLens`, `bboxLens`,
//      `meanDiffLens` — hand-rolled bwd via the right group action, so
//      cross-channel invariance is EXACT. Cost: crafted per topology.
//
// `bundleLens` sketches the 1→M dual (single source → M coupled views).
// =====================================================================

import { Num, type Signal, Vec, type Writable } from "../index";

// ─── 1. factorLens — generic Jacobian-LSQ N→M ──────────────────────────
//
// M writable scalars. Writing cell k pushes a sparse δy through the
// pseudoinverse of J ∈ R^{M×N} to land on target_k while moving the
// other outputs minimally. Per write: M·N forward evals (FD), an M×M
// inversion, M·N multiplies. Approximate when J is ill-conditioned and
// local (Newton step) — see closed-form lenses for the exact path.
// =====================================================================

export interface FactorLensOpts {
  /** Per-input mobility weights. 0 = pinned input. Defaults to all 1. */
  inputWeights?: readonly number[];
  /** Levenberg-Marquardt damping on the M×M normal matrix. Default 1e-6. */
  damping?: number;
  /** Finite-difference epsilon. Default 1e-5. */
  eps?: number;
}

export function factorLens(
  inputs: readonly Num[],
  forwards: readonly ((xs: readonly number[]) => number)[],
  opts: FactorLensOpts = {},
): Writable<Num>[] {
  const N = inputs.length;
  const M = forwards.length;
  if (M === 0) return [];
  const w = opts.inputWeights ?? new Array<number>(N).fill(1);
  const eps = opts.eps ?? 1e-5;
  const lambda = opts.damping ?? 1e-6;

  // Per-call (NOT per-cell) scratch; safe because writes execute
  // synchronously inside `_setWithExclusion`.
  const J = new Array<number>(M * N);
  const A = new Array<number>(M * M);
  const Ainv = new Array<number>(M * M);
  const ys = new Array<number>(M);
  const dy = new Array<number>(M);
  const kvec = new Array<number>(M);

  const outputs: Writable<Num>[] = [];
  for (let outIdx = 0; outIdx < M; outIdx++) {
    const idx = outIdx;
    const out = new Array<number>(N);
    const cell = Num.lens(
      inputs as never,
      (vals: readonly number[]) => forwards[idx]!(vals),
      (target: number, valsReadonly: readonly number[]) => {
        // Snapshot inputs into a mutable scratch so FD perturbations
        // don't leak into upstream signal state.
        const xs = valsReadonly as readonly number[];
        const xsm = xs.slice();
        for (let j = 0; j < M; j++) ys[j] = forwards[j]!(xsm);
        for (let j = 0; j < M; j++) dy[j] = 0;
        dy[idx] = target - ys[idx]!;

        // Build Jacobian column-by-column.
        for (let i = 0; i < N; i++) {
          const saved = xsm[i]!;
          xsm[i] = saved + eps;
          for (let j = 0; j < M; j++) {
            J[j * N + i] = (forwards[j]!(xsm) - ys[j]!) / eps;
          }
          xsm[i] = saved;
        }

        // A = J W Jᵀ + λI
        for (let r = 0; r < M; r++) {
          for (let c = 0; c < M; c++) {
            let s = 0;
            for (let i = 0; i < N; i++) s += J[r * N + i]! * w[i]! * J[c * N + i]!;
            A[r * M + c] = s + (r === c ? lambda : 0);
          }
        }

        if (!invertMatrix(A, M, Ainv)) {
          // Singular — leave inputs unchanged.
          for (let i = 0; i < N; i++) (out as (number | undefined)[])[i] = undefined;
          return out as never;
        }
        for (let r = 0; r < M; r++) {
          let s = 0;
          for (let c = 0; c < M; c++) s += Ainv[r * M + c]! * dy[c]!;
          kvec[r] = s;
        }
        for (let i = 0; i < N; i++) {
          let dxi = 0;
          for (let r = 0; r < M; r++) dxi += J[r * N + i]! * kvec[r]!;
          out[i] = xsm[i]! + w[i]! * dxi;
        }
        return out as never;
      },
    );
    outputs.push(cell);
  }
  return outputs;
}

/** Gauss-Jordan inverse of a row-major M×M matrix. Returns false if
 *  singular (pivot below 1e-14). Allocates one 2M-wide row buffer.
 *  For M ≤ ~10 this is competitive with LAPACK and avoids the dep. */
function invertMatrix(A: readonly number[], M: number, out: number[]): boolean {
  const W = 2 * M;
  const aug = new Array<number>(M * W);
  for (let r = 0; r < M; r++) {
    for (let c = 0; c < M; c++) aug[r * W + c] = A[r * M + c]!;
    for (let c = 0; c < M; c++) aug[r * W + M + c] = r === c ? 1 : 0;
  }
  for (let i = 0; i < M; i++) {
    let p = i;
    let pv = Math.abs(aug[i * W + i]!);
    for (let r = i + 1; r < M; r++) {
      const v = Math.abs(aug[r * W + i]!);
      if (v > pv) {
        pv = v;
        p = r;
      }
    }
    if (pv < 1e-14) return false;
    if (p !== i) {
      for (let c = 0; c < W; c++) {
        const t = aug[i * W + c]!;
        aug[i * W + c] = aug[p * W + c]!;
        aug[p * W + c] = t;
      }
    }
    const inv = 1 / aug[i * W + i]!;
    for (let c = 0; c < W; c++) aug[i * W + c] = aug[i * W + c]! * inv;
    for (let r = 0; r < M; r++) {
      if (r === i) continue;
      const f = aug[r * W + i]!;
      if (f === 0) continue;
      for (let c = 0; c < W; c++) aug[r * W + c] = aug[r * W + c]! - f * aug[i * W + c]!;
    }
  }
  for (let r = 0; r < M; r++) {
    for (let c = 0; c < M; c++) out[r * M + c] = aug[r * W + M + c]!;
  }
  return true;
}

// ─── 2. meanDiffLens — M=2 isomorphism baseline ────────────────────────
//
// (a, b) → ((a+b)/2, a−b). Square full-rank linear lens; bwd is the
// inverse change of basis — exact, cross-channel invariant. Sanity
// baseline for the property tests.
// =====================================================================

export function meanDiffLens(a: Num, b: Num): { mean: Writable<Num>; diff: Writable<Num> } {
  const mean = Num.lens(
    [a, b] as const,
    vals => (vals[0] + vals[1]) / 2,
    (target, vals) => {
      const d = vals[0] - vals[1];
      return [target + d / 2, target - d / 2];
    },
  );
  const diff = Num.lens(
    [a, b] as const,
    vals => vals[0] - vals[1],
    (target, vals) => {
      const m = (vals[0] + vals[1]) / 2;
      return [m + target / 2, m - target / 2];
    },
  );
  return { mean, diff };
}

// ─── 3. procrustesLens — closed-form similarity (the showcase) ─────────
//
// K writable Vecs → {centroid, rotation (angle of point[0] about
// centroid), scale (its distance from centroid)}. Each bwd is a
// closed-form transform about the centroid:
//   write centroid → translate every point by (c − old c)
//   write rotation → rotate every point about centroid by (θ − old θ)
//   write scale    → scale every point about centroid by (s / old s)
// These commute on the cluster's similarity orbit, so the three outputs
// have EXACT cross-channel invariance (cf. `procrustesJacobianLens`'s
// approximate version). Degenerate: K < 2 leaves rotation/scale
// undefined; a collapsed cluster (scale → 0) makes rotation singular and
// scale writes no-ops; target scale = 0 collapses to the centroid.
// =====================================================================

export function procrustesLens(points: readonly Writable<Vec>[]): {
  centroid: Writable<Vec>;
  rotation: Writable<Num>;
  scale: Writable<Num>;
} {
  const K = points.length;
  if (K < 2) throw new Error("procrustesLens: need ≥ 2 points");

  type V = { x: number; y: number };

  const centroid = Vec.lens(
    points as never,
    (vals: readonly V[]) => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < K; i++) {
        sx += vals[i]!.x;
        sy += vals[i]!.y;
      }
      return { x: sx / K, y: sy / K };
    },
    (target: V, vals: readonly V[]) => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < K; i++) {
        sx += vals[i]!.x;
        sy += vals[i]!.y;
      }
      const dx = target.x - sx / K;
      const dy = target.y - sy / K;
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) out[i] = { x: vals[i]!.x + dx, y: vals[i]!.y + dy };
      return out as never;
    },
  );

  const rotation = Num.lens(
    points as never,
    (vals: readonly V[]) => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < K; i++) {
        sx += vals[i]!.x;
        sy += vals[i]!.y;
      }
      const cx = sx / K;
      const cy = sy / K;
      return Math.atan2(vals[0]!.y - cy, vals[0]!.x - cx);
    },
    (target: number, vals: readonly V[]) => {
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < K; i++) {
        sx += vals[i]!.x;
        sy += vals[i]!.y;
      }
      const cx = sx / K;
      const cy = sy / K;
      const rx0 = vals[0]!.x - cx;
      const ry0 = vals[0]!.y - cy;
      if (rx0 * rx0 + ry0 * ry0 < 1e-24) {
        // Collapsed cluster; no angle to rotate from.
        return vals.map(() => undefined) as never;
      }
      const oldθ = Math.atan2(ry0, rx0);
      const dθ = target - oldθ;
      const cos = Math.cos(dθ);
      const sin = Math.sin(dθ);
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) {
        const rx = vals[i]!.x - cx;
        const ry = vals[i]!.y - cy;
        out[i] = { x: cx + cos * rx - sin * ry, y: cy + sin * rx + cos * ry };
      }
      return out as never;
    },
  );

  // Complement: per-point deviations from the centroid at the last
  // non-degenerate state. View is point 0's radius; writing T places each
  // point at `centroid + (T/|dev_0|) * dev_i`, so a collapse to the
  // centroid recovers from the stored shape. `step` refreshes each offset
  // (keeping the last good one for a collapsed point).
  type C = { devs: V[] };
  const centroidOf = (vals: readonly V[]): V => {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < K; i++) {
      sx += vals[i]!.x;
      sy += vals[i]!.y;
    }
    return { x: sx / K, y: sy / K };
  };
  const refreshDevs = (devs: V[], vals: readonly V[]): V[] => {
    const c = centroidOf(vals);
    return devs.map((d, i) => {
      const dx = vals[i]!.x - c.x;
      const dy = vals[i]!.y - c.y;
      return dx * dx + dy * dy > 1e-18 ? { x: dx, y: dy } : d;
    });
  };

  const scale = Num.lens(points as readonly Writable<Vec>[], {
    init: (vals: readonly V[]): C => {
      const c = centroidOf(vals);
      return { devs: vals.map(v => ({ x: v.x - c.x, y: v.y - c.y })) };
    },
    step: (vals: readonly V[], c: C): C => ({ devs: refreshDevs(c.devs, vals) }),
    fwd: (vals: readonly V[]): number => {
      const c = centroidOf(vals);
      return Math.hypot(vals[0]!.x - c.x, vals[0]!.y - c.y);
    },
    bwd: (target: number, vals: readonly V[], c: C) => {
      const cen = centroidOf(vals);
      const d0 = c.devs[0]!;
      const r0 = Math.hypot(d0.x, d0.y);
      if (r0 < 1e-12) return { updates: vals.map(() => undefined), complement: c };
      const k = target / r0;
      const out = c.devs.map(d => ({ x: cen.x + k * d.x, y: cen.y + k * d.y }));
      return { updates: out, complement: c };
    },
  });

  return { centroid, rotation, scale };
}

// ─── 4. bboxLens — closed-form axis-aligned bounding box ───────────────
//
// K Vecs → {center, size}. Forward is min/max (piecewise-constant
// Jacobian — fatal for FD), but the closed-form bwd is exact:
//   write center → translate all points by (c − old c)
//   write size   → scale all about center by component-wise ratio
// Center↔size invariance is exact. Degenerate axes (size = 0) write
// as no-ops; negative size reflects (kept permissive).
// =====================================================================

export function bboxLens(points: readonly Writable<Vec>[]): {
  center: Writable<Vec>;
  size: Writable<Vec>;
} {
  const K = points.length;
  if (K < 1) throw new Error("bboxLens: need ≥ 1 point");
  type V = { x: number; y: number };

  const computeBox = (vals: readonly V[]): { cx: number; cy: number; sx: number; sy: number } => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < K; i++) {
      const x = vals[i]!.x;
      const y = vals[i]!.y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      sx: maxX - minX,
      sy: maxY - minY,
    };
  };

  const center = Vec.lens(
    points as never,
    (vals: readonly V[]) => {
      const b = computeBox(vals);
      return { x: b.cx, y: b.cy };
    },
    (target: V, vals: readonly V[]) => {
      const b = computeBox(vals);
      const dx = target.x - b.cx;
      const dy = target.y - b.cy;
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) out[i] = { x: vals[i]!.x + dx, y: vals[i]!.y + dy };
      return out as never;
    },
  );

  // Complement: per-point fractions of the bbox half-size at the last
  // non-degenerate state. A `size` write places points at
  // `center + frac_i * (target/2)`, surviving a per-axis collapse to a
  // line. `step` refreshes component-wise on non-degenerate axes.
  type C = { fracs: V[] };
  const refreshFracs = (fracs: V[], vals: readonly V[]): V[] => {
    const b = computeBox(vals);
    const hx = b.sx > 1e-12 ? b.sx / 2 : 0;
    const hy = b.sy > 1e-12 ? b.sy / 2 : 0;
    return fracs.map((f, i) => ({
      x: hx > 0 ? (vals[i]!.x - b.cx) / hx : f.x,
      y: hy > 0 ? (vals[i]!.y - b.cy) / hy : f.y,
    }));
  };

  const size = Vec.lens(points as readonly Writable<Vec>[], {
    init: (vals: readonly V[]): C => {
      const b = computeBox(vals);
      const halfX0 = b.sx > 1e-12 ? b.sx / 2 : 1;
      const halfY0 = b.sy > 1e-12 ? b.sy / 2 : 1;
      return {
        fracs: vals.map(v => ({
          x: b.sx > 1e-12 ? (v.x - b.cx) / halfX0 : 0,
          y: b.sy > 1e-12 ? (v.y - b.cy) / halfY0 : 0,
        })),
      };
    },
    step: (vals: readonly V[], c: C): C => ({ fracs: refreshFracs(c.fracs, vals) }),
    fwd: (vals: readonly V[]): V => {
      const b = computeBox(vals);
      return { x: b.sx, y: b.sy };
    },
    bwd: (target: V, vals: readonly V[], c: C) => {
      const b = computeBox(vals);
      const halfTx = target.x / 2;
      const halfTy = target.y / 2;
      const out = c.fracs.map(f => ({ x: b.cx + f.x * halfTx, y: b.cy + f.y * halfTy }));
      return { updates: out, complement: c };
    },
  });

  return { center, size };
}

// ─── 5. procrustesJacobianLens — comparison point ──────────────────────
//
// Same forward map as `procrustesLens` but with the generic Jacobian-LSQ
// bwd, to quantify the numerical path vs. the closed-form one.
// =====================================================================

export function procrustesJacobianLens(points: readonly Writable<Vec>[]): {
  centroidX: Writable<Num>;
  centroidY: Writable<Num>;
  rotation: Writable<Num>;
  scale: Writable<Num>;
} {
  const K = points.length;
  if (K < 2) throw new Error("procrustesJacobianLens: need ≥ 2 points");

  // Flatten K Vecs into 2K scalar field lenses.
  const xs: Writable<Num>[] = [];
  const ys: Writable<Num>[] = [];
  for (const p of points) {
    xs.push(
      Num.lens(
        [p] as const,
        v => v[0]!.x,
        (t, v) => [{ x: t, y: v[0]!.y }],
      ),
    );
    ys.push(
      Num.lens(
        [p] as const,
        v => v[0]!.y,
        (t, v) => [{ x: v[0]!.x, y: t }],
      ),
    );
  }
  // factorLens wants a flat input array.
  const flat: Num[] = [];
  for (let i = 0; i < K; i++) {
    flat.push(xs[i]!, ys[i]!);
  }
  // Indexing helpers
  const xAt = (a: readonly number[], i: number): number => a[2 * i]!;
  const yAt = (a: readonly number[], i: number): number => a[2 * i + 1]!;

  const fwdCx = (a: readonly number[]): number => {
    let s = 0;
    for (let i = 0; i < K; i++) s += xAt(a, i);
    return s / K;
  };
  const fwdCy = (a: readonly number[]): number => {
    let s = 0;
    for (let i = 0; i < K; i++) s += yAt(a, i);
    return s / K;
  };
  const fwdRot = (a: readonly number[]): number => {
    return Math.atan2(yAt(a, 0) - fwdCy(a), xAt(a, 0) - fwdCx(a));
  };
  const fwdScale = (a: readonly number[]): number => {
    return Math.hypot(xAt(a, 0) - fwdCx(a), yAt(a, 0) - fwdCy(a));
  };

  const [centroidX, centroidY, rotation, scale] = factorLens(
    flat,
    [fwdCx, fwdCy, fwdRot, fwdScale],
    { damping: 1e-4 },
  ) as [Writable<Num>, Writable<Num>, Writable<Num>, Writable<Num>];
  return { centroidX, centroidY, rotation, scale };
}

// ─── 6. bundleLens — 1→M dual case (coupled field bundle) ──────────────
//
// A single source `Pose = {x, y, theta}` and a fixed pivot `rotateAbout`
// → {position: (x,y), rotation: theta but rotating about the pivot}.
// Writing rotation rotates (x, y) about the pivot by Δθ and sets theta.
// The dual of factorLens: one product source split into M coupled views.
// =====================================================================

type PoseV = { x: number; y: number; theta: number };

export function bundleLens(
  pose: Writable<Signal<PoseV>>,
  rotateAbout: { x: number; y: number },
): { position: Writable<Vec>; rotation: Writable<Num> } {
  const position = Vec.lens(
    [pose] as const,
    (v: readonly PoseV[]) => ({ x: v[0]!.x, y: v[0]!.y }),
    (target: { x: number; y: number }, v: readonly PoseV[]) =>
      [{ ...v[0]!, x: target.x, y: target.y }] as never,
  );
  const rotation = Num.lens(
    [pose] as const,
    (v: readonly PoseV[]) => v[0]!.theta,
    (target: number, v: readonly PoseV[]) => {
      const cur = v[0]!;
      const dθ = target - cur.theta;
      const cos = Math.cos(dθ);
      const sin = Math.sin(dθ);
      const rx = cur.x - rotateAbout.x;
      const ry = cur.y - rotateAbout.y;
      return [
        {
          x: rotateAbout.x + cos * rx - sin * ry,
          y: rotateAbout.y + sin * rx + cos * ry,
          theta: target,
        },
      ] as never;
    },
  );
  return { position, rotation };
}
