// =====================================================================
// factor-lens.ts — N→M lens design exploration.
//
// Prototypes for the "missing cell" in the lens table:
// N inputs → M coupled writable outputs, where each output is a
// different ASPECT of the joint state and writes to one output
// preserve the readings of the other M−1 (cross-channel invariance).
//
// Two regimes are explored:
//
//   1. Numerical / Jacobian-LSQ   — `factorLens` generalises
//      `argminVec` to M outputs. The bwd builds an M×N Jacobian by
//      finite differences and solves `(J W Jᵀ + λI) k = δy` for
//      Lagrange multipliers `k`, then writes `δx = W Jᵀ k`. δy is
//      sparse (only the channel being written is non-zero), so the
//      solve naturally tries to leave the other M−1 channels
//      stationary. Works for any forward map; quality of cross-
//      channel invariance depends on the local condition number.
//
//   2. Closed-form / geometric    — `procrustesLens`, `bboxLens`,
//      `meanDiffLens`. Hand-rolled bwd that achieves EXACT cross-
//      channel invariance by constructing the right group action
//      (rigid translate, rotate-about-centroid, scale-about-centroid,
//      …). No iteration, no damping, no rank issues. The cost is
//      that they're hand-crafted per topology.
//
// The 1→M dual case (a single source factored into M coupled views,
// e.g. Pose → {position, rotation, rotateAbout}) is straightforward
// once the N→M case works — sketched in `bundleLens` below.
//
// Property axes the test file probes:
//   - Forward correctness
//   - Round-trip identity (write T, read = T)
//   - Cross-channel invariance (write A, B&C readings stay)
//   - Idempotence (write T twice = write T once)
//   - Long-run stability (random writes don't drift)
//   - Conservation (where applicable)
//   - Performance (factorLens vs independent N→1 chains)
// =====================================================================

import { Num, type Signal, Vec, type Writable } from "../index";

// ─── 1. factorLens — generic Jacobian-LSQ N→M ──────────────────────────
//
// Returns M writable scalar cells. Writing cell k pushes δy = [0,…,
// target − current_k, …, 0] through the pseudoinverse of J ∈ R^{M×N},
// so the LSQ solve tries to land EXACTLY on target_k while moving
// the other M−1 outputs as little as possible.
//
// Costs per write:
//   - M·N forward evaluations to build J (FD column-by-column)
//   - M×M Gauss-Jordan inversion (O(M³); M is small, ~1–6)
//   - M·N scalar multiplies to compute δx
//
// Limitations vs. closed-form:
//   - O(N+1) forward calls per write — fine for K ~ 10 shapes, hot
//     for K ~ 1000.
//   - Cross-channel invariance is only approximate (the LSQ minimises
//     |J δx − δy|² which leaks into other channels when J is ill-
//     conditioned). Damping makes it bleed more — there's a trade-off.
//   - Not exact at large δ — Newton step is local.
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
// (a, b) → (mean, diff) = ((a+b)/2, a−b). This is a square, full-rank
// linear lens: M = N = 2. The bwd is the inverse change of basis
// (rotation by 45° in (a, b) space) — exact, cross-channel invariant
// by construction. Useful as a sanity baseline for the property tests:
// any genuine M=2 N→M primitive should match this on the 2-input case.
// =====================================================================

export function meanDiffLens(
  a: Num,
  b: Num,
): { mean: Writable<Num>; diff: Writable<Num> } {
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
// K writable Vecs → 3 writable aspects:
//   centroid : Writable<Vec>  — mean of the points
//   rotation : Writable<Num>  — angle of point[0] relative to centroid
//   scale    : Writable<Num>  — distance from centroid to point[0]
//
// All three bwd paths are closed-form rigid/similarity transforms
// of the K points about their centroid:
//
//   write centroid c  →  translate every point by (c − old c)
//   write rotation θ  →  rotate every point about centroid by (θ − old θ)
//   write scale    s  →  scale every point about centroid by (s / old s)
//
// These are commuting actions on the cluster's similarity-group orbit:
//   - translation preserves centroid by definition? no, REPLACES centroid
//     with target. Preserves relative positions → rotation/scale unchanged.
//   - rotation-about-centroid preserves centroid (fixed point) AND
//     preserves all radial distances → centroid AND scale unchanged.
//   - scale-about-centroid preserves centroid (fixed point) AND
//     preserves all angles → centroid AND rotation unchanged.
//
// So the three outputs have EXACT cross-channel invariance, by geometry.
// (Compare: a Jacobian-LSQ on the same forward map only approximates
// this — see `procrustesJacobianLens` below.)
//
// Degenerate configurations:
//   - K < 2:                  rotation/scale undefined.
//   - scale → 0 (collapsed):  rotation singular; scale write is no-op
//                             (no information about direction to inflate).
//   - target scale = 0:       collapses all points to centroid. Recovery
//                             requires writing rotation separately to
//                             re-establish orientation… which is impossible
//                             because all radii are 0. Caller's problem.
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

  const scale = Num.lens(
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
      return Math.hypot(vals[0]!.x - cx, vals[0]!.y - cy);
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
      const oldS = Math.hypot(vals[0]!.x - cx, vals[0]!.y - cy);
      if (oldS < 1e-12) return vals.map(() => undefined) as never;
      const k = target / oldS;
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) {
        out[i] = { x: cx + k * (vals[i]!.x - cx), y: cy + k * (vals[i]!.y - cy) };
      }
      return out as never;
    },
  );

  return { centroid, rotation, scale };
}

// ─── 4. bboxLens — closed-form axis-aligned bounding box ───────────────
//
// K Vecs → { center: Vec, size: Vec }. Forward uses min/max (which
// has a piecewise-constant Jacobian — fatal for any FD-based scheme).
// Closed-form bwd is exact:
//
//   write center c  →  translate all points by (c − old c)
//   write size   s  →  scale all points about center by component-wise
//                       ratio (s.x / old.x, s.y / old.y)
//
// Notes:
//   - Writing center preserves size (translation is rigid).
//   - Writing size preserves center (scaling is about center).
//   - Degenerate axes (old size component = 0): writes that axis are
//     no-ops (no info about direction to inflate into).
//   - Negative size: reflects the cluster (component-wise). Some
//     callers might prefer to clamp at 0 — keep it permissive here.
// =====================================================================

export function bboxLens(points: readonly Writable<Vec>[]): {
  center: Writable<Vec>;
  size: Writable<Vec>;
} {
  const K = points.length;
  if (K < 1) throw new Error("bboxLens: need ≥ 1 point");
  type V = { x: number; y: number };

  const computeBox = (vals: readonly V[]): { cx: number; cy: number; sx: number; sy: number } => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
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

  // Symmetric: the complement is per-point fractional offsets relative
  // to the current bbox center/half-size, captured at the last non-
  // degenerate read/write. On a write to `size`, points are placed at
  // `center + frac_i * (target / 2)` from stored fractions — surviving
  // a per-axis collapse to a line and reinflating cleanly. Stored
  // fractions are updated component-wise: only the axes that are
  // currently non-degenerate get refreshed.
  const initVals = points.map(s => s.peek());
  const initBox = computeBox(initVals);
  const halfX0 = initBox.sx > 1e-12 ? initBox.sx / 2 : 1;
  const halfY0 = initBox.sy > 1e-12 ? initBox.sy / 2 : 1;
  const initFracs = initVals.map(v => ({
    x: initBox.sx > 1e-12 ? (v.x - initBox.cx) / halfX0 : 0,
    y: initBox.sy > 1e-12 ? (v.y - initBox.cy) / halfY0 : 0,
  }));

  type C = { fracs: V[] };
  const size = Vec.symmetricLens(points as readonly Writable<Vec>[], {
    missing: { fracs: initFracs } as C,
    putr: (vals: readonly V[], c: C) => {
      const b = computeBox(vals);
      const fracs = c.fracs;
      const hx = b.sx > 1e-12 ? b.sx / 2 : 0;
      const hy = b.sy > 1e-12 ? b.sy / 2 : 0;
      for (let i = 0; i < K; i++) {
        const f = fracs[i]!;
        if (hx > 0) f.x = (vals[i]!.x - b.cx) / hx;
        if (hy > 0) f.y = (vals[i]!.y - b.cy) / hy;
      }
      return { x: b.sx, y: b.sy };
    },
    putl: (target: V, vals: readonly V[], c: C) => {
      const b = computeBox(vals);
      const fracs = c.fracs;
      const hx = b.sx > 1e-12 ? b.sx / 2 : 0;
      const hy = b.sy > 1e-12 ? b.sy / 2 : 0;
      for (let i = 0; i < K; i++) {
        const f = fracs[i]!;
        if (hx > 0) f.x = (vals[i]!.x - b.cx) / hx;
        if (hy > 0) f.y = (vals[i]!.y - b.cy) / hy;
      }
      const halfTx = target.x / 2;
      const halfTy = target.y / 2;
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) {
        const f = fracs[i]!;
        out[i] = { x: b.cx + f.x * halfTx, y: b.cy + f.y * halfTy };
      }
      return out;
    },
  });

  return { center, size };
}

// ─── 5. procrustesJacobianLens — comparison point ──────────────────────
//
// Same forward map as `procrustesLens` but bwd is the generic
// Jacobian-LSQ from `factorLens` rather than closed-form. Lets us
// quantify the cost of the generic numerical path vs. hand-crafted
// geometric one — both in cross-channel invariance and in perf.
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
// Given a single source `Pose = {x, y, theta}` and a virtual pivot
// `rotateAbout: Vec` (a plain ref object, not reactive), expose:
//
//   position : Writable<Vec>  — (x, y)
//   rotation : Writable<Num>  — theta, but rotates around rotateAbout
//
// Writing `rotation = θ_new`:
//   1. compute Δθ = θ_new − pose.theta
//   2. rotate (x, y) about rotateAbout by Δθ
//   3. set pose to (newX, newY, θ_new)
//
// This is the dual of factorLens: instead of N independent sources
// folded into M aspects, a single product source split into M views
// with a coupling invariant on writes. The natural place this lives
// is "field with side-policy" — `field()` today is independent-bwd;
// this would be coupled-bwd.
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
