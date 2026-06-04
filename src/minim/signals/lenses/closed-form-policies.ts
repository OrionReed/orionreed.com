// =====================================================================
// closed-form-policies.ts — exact group-action lenses for point clouds.
//
// When an aggregate lens has a closed-form inverse, its bwd applies a
// GROUP ELEMENT to the source set. Translation, rotation-about-pivot,
// and scale-about-pivot are the building blocks; Procrustes, best-fit
// line/circle, and PCA decompose into combinations of them.
//
// Layout: building-block actions (rigidTranslate, rotateAbout,
// scaleAbout, scaleAboutXY), Procrustes re-expressed via them, then
// closed-form decompositions (bestFitLine, bestFitCircle, pcaLens,
// totalLens). All exact, idempotent, cross-channel invariant by
// construction, on the same `Cls.lens` machinery — no engine changes.
// =====================================================================

import {
  centroidLens,
  Num,
  type Pivotal,
  type Read,
  type Cell,
  type Traits,
  Vec,
  type Writable,
} from "../index";

type V = { x: number; y: number };

// Pivotal trait lookup via the value class's `static traits.pivotal` slot.
// biome-ignore lint/suspicious/noExplicitAny: dynamic trait lookup
function pivotalOf<T>(input: Writable<any>): Pivotal<T> {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic class lookup
  const Cls = (input as any).constructor as { traits?: { pivotal?: Pivotal<T> } };
  const p = Cls.traits?.pivotal;
  if (!p) {
    const name = (Cls as { name?: string }).name ?? "?";
    throw new Error(`closed-form-policies: ${name} has no traits.pivotal`);
  }
  return p;
}

// ─── 1. Building-block group actions ───────────────────────────────────

/** Writable centroid; on write, translates every point by the delta.
 *  Alias of `centroidLens` under the "policy" naming. */
export function rigidTranslate(points: readonly Writable<Vec>[]): Writable<Vec> {
  return centroidLens(points as never);
}

/** Writable angle from `pivot` to `points[0]`; write rotates every input
 *  about `pivot` by (target − current) via its `Pivotal` trait.
 *
 *  Trait-generic: Vec rotates position; Pose rotates position AND
 *  orientation. Rotation-about-pivot fixes the pivot and preserves radial
 *  distances, so scale-about-pivot reads unchanged. `pivot` is reactive
 *  (re-read per write); pass `centroidLens(points)` for rotation about
 *  the cluster's own centroid. */
// biome-ignore lint/suspicious/noExplicitAny: variance escape — T constrained at run by Pivotal lookup
export function rotateAbout<T extends { x: number; y: number }>(
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  points: readonly Writable<Traits<T, "pivotal"> & Cell<T>>[],
  pivot: Read<V>,
): Writable<Num> {
  const K = points.length;
  if (K < 1) throw new Error("rotateAbout: need ≥ 1 point");
  const pv = pivotalOf<T>(points[0]!);
  // biome-ignore lint/suspicious/noExplicitAny: variance escape on Num.lens
  return Num.lens(
    points as never,
    (vals: readonly T[]) => {
      const p = pivot.peek();
      return Math.atan2(vals[0]!.y - p.y, vals[0]!.x - p.x);
    },
    (target: number, vals: readonly T[]) => {
      const p = pivot.peek();
      const rx0 = vals[0]!.x - p.x;
      const ry0 = vals[0]!.y - p.y;
      if (rx0 * rx0 + ry0 * ry0 < 1e-24) {
        return vals.map(() => undefined) as never;
      }
      const oldθ = Math.atan2(ry0, rx0);
      const dθ = target - oldθ;
      const out = new Array<T>(K);
      for (let i = 0; i < K; i++) out[i] = pv.rotateAbout(vals[i]!, p, dθ);
      return out as never;
    },
  );
}

/** Writable radial distance from pivot to `points[0]`; write scales every
 *  input radially about `pivot` (negative target reflects). Exact
 *  cross-channel invariance with `rotateAbout`.
 *
 *  Complement carries per-point offsets from the pivot at the last
 *  non-degenerate state, so a collapse onto the pivot (radius ≈ 0)
 *  reinflates from the stored shape. Pose `theta` survives the round-trip
 *  (only spatial offset is stored). */
export function scaleAbout<T extends { x: number; y: number }>(
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  points: readonly Writable<Traits<T, "pivotal"> & Cell<T>>[],
  pivot: Read<V>,
): Writable<Num> {
  const K = points.length;
  if (K < 1) throw new Error("scaleAbout: need ≥ 1 point");
  // Eager lookup so an undeclared class fails at construction:
  pivotalOf<T>(points[0]!);

  // Complement: per-point offset from the pivot at the last non-degenerate
  // state. `step` refreshes each from the live source (keeping the last
  // good one for a collapsed point); `bwd` scales them to the target radius.
  type C = { devs: V[] };
  const refresh = (devs: V[], vals: readonly T[], p: V): V[] =>
    devs.map((d, i) => {
      const dx = vals[i]!.x - p.x;
      const dy = vals[i]!.y - p.y;
      return dx * dx + dy * dy > 1e-18 ? { x: dx, y: dy } : d;
    });

  // biome-ignore lint/suspicious/noExplicitAny: variance escape — spec is checked structurally
  return (Num as any).lens(points as unknown as readonly Writable<Cell<T>>[], {
    init: (vals: readonly T[]): C => {
      const p = pivot.peek();
      return { devs: vals.map(v => ({ x: v.x - p.x, y: v.y - p.y })) };
    },
    step: (vals: readonly T[], c: C): C => ({ devs: refresh(c.devs, vals, pivot.peek()) }),
    fwd: (vals: readonly T[]): number => {
      const p = pivot.peek();
      return Math.hypot(vals[0]!.x - p.x, vals[0]!.y - p.y);
    },
    bwd: (target: number, vals: readonly T[], c: C) => {
      const p = pivot.peek();
      // Lossy magnitude view: |−r| = r, so a same-magnitude target
      // re-projects to the current radius and is absorbed (sources put).
      const rNow = Math.hypot(vals[0]!.x - p.x, vals[0]!.y - p.y);
      if (Math.abs(target) === rNow) return { updates: vals.map(() => undefined), complement: c };
      const d0 = c.devs[0]!;
      const r0 = Math.hypot(d0.x, d0.y);
      if (r0 < 1e-12) return { updates: vals.map(() => undefined), complement: c };
      const k = target / r0;
      const out = vals.map((v, i) => ({
        ...v,
        x: p.x + k * c.devs[i]!.x,
        y: p.y + k * c.devs[i]!.y,
      }));
      return { updates: out, complement: c };
    },
  }) as Writable<Num>;
}

/** Per-axis scale about a pivot. Vec-specific (Pivotal has no per-axis
 *  method yet). Complement carries per-point per-axis fractions of
 *  point 0's offset, so a per-axis collapse is recoverable (cf.
 *  `bboxLens.size`). */
export function scaleAboutXY(points: readonly Writable<Vec>[], pivot: Read<V>): Writable<Vec> {
  const K = points.length;
  if (K < 1) throw new Error("scaleAboutXY: need ≥ 1 point");

  // Complement: per-point per-axis fraction of point 0's offset from the
  // pivot, refreshed per non-degenerate axis. `bwd` places point i at
  // `pivot + (fx_i·target.x, fy_i·target.y)`.
  type C = { fracs: V[] };
  const refresh = (fracs: V[], vals: readonly V[], p: V): V[] => {
    const ox = vals[0]!.x - p.x;
    const oy = vals[0]!.y - p.y;
    const okx = Math.abs(ox) > 1e-12;
    const oky = Math.abs(oy) > 1e-12;
    return fracs.map((f, i) => ({
      x: okx ? (vals[i]!.x - p.x) / ox : f.x,
      y: oky ? (vals[i]!.y - p.y) / oy : f.y,
    }));
  };

  return Vec.lens(points as readonly Writable<Vec>[], {
    init: (vals: readonly V[]): C => {
      const p = pivot.peek();
      const ox = vals[0]!.x - p.x;
      const oy = vals[0]!.y - p.y;
      return {
        fracs: vals.map(v => ({
          x: Math.abs(ox) > 1e-12 ? (v.x - p.x) / ox : 0,
          y: Math.abs(oy) > 1e-12 ? (v.y - p.y) / oy : 0,
        })),
      };
    },
    step: (vals: readonly V[], c: C): C => ({ fracs: refresh(c.fracs, vals, pivot.peek()) }),
    fwd: (vals: readonly V[]): V => {
      const p = pivot.peek();
      return { x: vals[0]!.x - p.x, y: vals[0]!.y - p.y };
    },
    bwd: (target: V, _vals: readonly V[], c: C) => {
      const p = pivot.peek();
      const out = c.fracs.map(f => ({ x: p.x + f.x * target.x, y: p.y + f.y * target.y }));
      return { updates: out, complement: c };
    },
  });
}

// ─── 2. Decomposed procrustes (refactor via building blocks) ───────────

/** Same semantics as `factor-lens.ts`'s `procrustesLens`, decomposed
 *  into three building-block lenses sharing a centroid. */
export function procrustesViaBuildingBlocks(points: readonly Writable<Vec>[]): {
  centroid: Writable<Vec>;
  rotation: Writable<Num>;
  scale: Writable<Num>;
} {
  if (points.length < 2) throw new Error("procrustes: need ≥ 2 points");
  const centroid = rigidTranslate(points);
  const rotation = rotateAbout(points, centroid);
  const scale = scaleAbout(points, centroid);
  return { centroid, rotation, scale };
}

// ─── 3. Best-fit line ──────────────────────────────────────────────────
//
// K points → {point: centroid, direction: principal-axis angle}.
//   write point     → rigidTranslate
//   write direction → rotate all about centroid to set principal axis
// Invariance: principal axis is translation-invariant; centroid is
// invariant under rotation-about-itself.
// =====================================================================

/** Angle of the dominant eigenvector of symmetric 2×2 [[cxx,cxy],[cxy,cyy]]. */
function dominantAxisAngle(cxx: number, cxy: number, cyy: number): number {
  return 0.5 * Math.atan2(2 * cxy, cxx - cyy);
}

function covariance(
  points: readonly V[],
  cx: number,
  cy: number,
): { cxx: number; cxy: number; cyy: number } {
  const K = points.length;
  let cxx = 0;
  let cxy = 0;
  let cyy = 0;
  for (let i = 0; i < K; i++) {
    const dx = points[i]!.x - cx;
    const dy = points[i]!.y - cy;
    cxx += dx * dx;
    cxy += dx * dy;
    cyy += dy * dy;
  }
  return { cxx: cxx / K, cxy: cxy / K, cyy: cyy / K };
}

/** Wrap to (-m/2, m/2]. Picks the representative nearest a reference,
 *  modulo `m` (π for axes, 2π for full-vector angles). */
const wrapMod = (x: number, m: number): number => x - m * Math.round(x / m);

export function bestFitLineLens(points: readonly Writable<Vec>[]): {
  point: Writable<Vec>;
  direction: Writable<Num>;
} {
  const K = points.length;
  if (K < 2) throw new Error("bestFitLine: need ≥ 2 points");

  const point = rigidTranslate(points);

  // The principal axis is an eigenvector — defined only up to sign, so
  // raw atan2 jumps by π as the cloud rotates. The complement stores the
  // last-emitted angle and we unwrap the raw value to the nearest
  // representative (mod π, since axis ≡ axis + π) for a continuous angle.
  // On a collapsed cloud (direction undefined) `bwd` stashes the target
  // with no source move.
  type C = { θ: number };
  // Centroid + dominant-axis raw angle; `degenerate` when covariance vanishes.
  const axisOf = (
    vals: readonly V[],
  ): { cx: number; cy: number; rawθ: number; degenerate: boolean } => {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < K; i++) {
      sx += vals[i]!.x;
      sy += vals[i]!.y;
    }
    const cx = sx / K;
    const cy = sy / K;
    const { cxx, cxy, cyy } = covariance(vals, cx, cy);
    if (cxx + cyy < 1e-18) return { cx, cy, rawθ: 0, degenerate: true };
    return { cx, cy, rawθ: dominantAxisAngle(cxx, cxy, cyy), degenerate: false };
  };
  // Unwrap the raw axis angle to the representative nearest the stored θ.
  const unwrap = (rawθ: number, prevθ: number): number => prevθ + wrapMod(rawθ - prevθ, Math.PI);

  const direction = Num.lens(points as readonly Writable<Vec>[], {
    init: (vals: readonly V[]): C => {
      const { rawθ, degenerate } = axisOf(vals);
      return { θ: degenerate ? 0 : rawθ };
    },
    step: (vals: readonly V[], c: C): C => {
      const { rawθ, degenerate } = axisOf(vals);
      return degenerate ? c : { θ: unwrap(rawθ, c.θ) };
    },
    fwd: (vals: readonly V[], c: C): number => {
      const { rawθ, degenerate } = axisOf(vals);
      return degenerate ? c.θ : unwrap(rawθ, c.θ);
    },
    bwd: (target: number, vals: readonly V[], c: C) => {
      const { cx, cy, rawθ, degenerate } = axisOf(vals);
      if (degenerate) {
        return {
          updates: vals.map(() => undefined) as readonly (V | undefined)[],
          complement: { θ: target },
        };
      }
      const dθ = target - unwrap(rawθ, c.θ);
      const cos = Math.cos(dθ);
      const sin = Math.sin(dθ);
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) {
        const rx = vals[i]!.x - cx;
        const ry = vals[i]!.y - cy;
        out[i] = { x: cx + cos * rx - sin * ry, y: cy + sin * rx + cos * ry };
      }
      return { updates: out as readonly (V | undefined)[], complement: { θ: target } };
    },
  });

  return { point, direction };
}

// ─── 4. Best-fit circle ────────────────────────────────────────────────
//
// K points → {center: centroid, radius: mean distance from center}.
//   write center → rigidTranslate
//   write radius → scale all about center by target/current
// Simplest closed-form fit (mean center). Invariance: translation
// preserves radii; uniform scale-about-center preserves the center.
// =====================================================================

export function bestFitCircleLens(points: readonly Writable<Vec>[]): {
  center: Writable<Vec>;
  radius: Writable<Num>;
} {
  const K = points.length;
  if (K < 1) throw new Error("bestFitCircle: need ≥ 1 point");

  const center = rigidTranslate(points);

  // Complement: per-point deviations normalized by the cluster's mean
  // radial distance, so writing `radius = T` places each point at
  // `centroid + normDev_i * T` (relative distribution preserved). `step`
  // refreshes while non-degenerate; `bwd` scales the live devs (fast path)
  // or, when collapsed (mean ≈ 0), reinflates the stored SHAPE.
  type C = { norms: V[] };
  const centroidOf = (vals: readonly V[]): V => {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < K; i++) {
      sx += vals[i]!.x;
      sy += vals[i]!.y;
    }
    return { x: sx / K, y: sy / K };
  };
  const meanRadius = (vals: readonly V[], c: V): number => {
    let sum = 0;
    for (let i = 0; i < K; i++) sum += Math.hypot(vals[i]!.x - c.x, vals[i]!.y - c.y);
    return sum / K;
  };

  const radius = Num.lens(points as readonly Writable<Vec>[], {
    init: (vals: readonly V[]): C => {
      const c = centroidOf(vals);
      const mean = meanRadius(vals, c);
      return {
        norms: vals.map(v =>
          mean > 1e-9 ? { x: (v.x - c.x) / mean, y: (v.y - c.y) / mean } : { x: 0, y: 0 },
        ),
      };
    },
    step: (vals: readonly V[], c: C): C => {
      const ctr = centroidOf(vals);
      const mean = meanRadius(vals, ctr);
      if (mean <= 1e-9) return c;
      const inv = 1 / mean;
      return { norms: vals.map(v => ({ x: (v.x - ctr.x) * inv, y: (v.y - ctr.y) * inv })) };
    },
    fwd: (vals: readonly V[]): number => meanRadius(vals, centroidOf(vals)),
    bwd: (target: number, vals: readonly V[], c: C) => {
      const ctr = centroidOf(vals);
      const mean = meanRadius(vals, ctr);
      // Lossy magnitude view: a same-magnitude target re-projects to the
      // current mean radius and is absorbed (the cluster is left put).
      if (Math.abs(target) === mean) return { updates: vals.map(() => undefined), complement: c };
      if (mean > 1e-9) {
        const k = target / mean;
        const out = vals.map(v => ({ x: ctr.x + (v.x - ctr.x) * k, y: ctr.y + (v.y - ctr.y) * k }));
        return { updates: out, complement: c };
      }
      const out = c.norms.map(n => ({ x: ctr.x + n.x * target, y: ctr.y + n.y * target }));
      return { updates: out, complement: c };
    },
  });

  return { center, radius };
}

// ─── 5. PCA / affine similarity decomposition ──────────────────────────
//
// K points → {mean: centroid, rotation: dominant-eigenvector angle,
//   majorLength: √λ_major, minorLength: √λ_minor (per-axis std-devs)}.
//   write mean        → rigidTranslate
//   write rotation    → rotate all about mean to set principal axis
//   write major/minor → scale along that axis by target/current
// Each write is a single group action; cross-channel invariance holds
// for all pairs.
// =====================================================================

export function pcaLens(points: readonly Writable<Vec>[]): {
  mean: Writable<Vec>;
  rotation: Writable<Num>;
  majorLength: Writable<Num>;
  minorLength: Writable<Num>;
} {
  const K = points.length;
  if (K < 2) throw new Error("pcaLens: need ≥ 2 points");

  const mean = rigidTranslate(points);

  // 2×2 symmetric eigendecomp → {θ, λ_major, λ_minor}; null when fully
  // collapsed (λ_major ≈ 0).
  const decompose = (
    vals: readonly V[],
  ): {
    cx: number;
    cy: number;
    θ: number;
    lambdaMajor: number;
    lambdaMinor: number;
  } | null => {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < K; i++) {
      sx += vals[i]!.x;
      sy += vals[i]!.y;
    }
    const cx = sx / K;
    const cy = sy / K;
    const { cxx, cxy, cyy } = covariance(vals, cx, cy);
    const tr = cxx + cyy;
    const disc = Math.sqrt((cxx - cyy) * (cxx - cyy) + 4 * cxy * cxy);
    const lambdaMajor = (tr + disc) / 2;
    const lambdaMinor = (tr - disc) / 2;
    if (lambdaMajor < 1e-24) return null;
    const θ = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    return { cx, cy, θ, lambdaMajor, lambdaMinor };
  };

  const rotation = Num.lens(
    points as never,
    (vals: readonly V[]) => decompose(vals)?.θ ?? 0,
    (target: number, vals: readonly V[]) => {
      const d = decompose(vals);
      if (!d) return vals.map(() => undefined) as never;
      const dθ = target - d.θ;
      const cos = Math.cos(dθ);
      const sin = Math.sin(dθ);
      const out = new Array<V>(K);
      for (let i = 0; i < K; i++) {
        const rx = vals[i]!.x - d.cx;
        const ry = vals[i]!.y - d.cy;
        out[i] = { x: d.cx + cos * rx - sin * ry, y: d.cy + sin * rx + cos * ry };
      }
      return out as never;
    },
  );

  // Scale by k along axis (ux, uy): project each point onto (u, u_perp),
  // scale the u component, project back. Relative to mean.
  const scaleAlongAxis = (
    vals: readonly V[],
    cx: number,
    cy: number,
    ux: number,
    uy: number,
    k: number,
  ): V[] => {
    const vx = -uy;
    const vy = ux;
    const out = new Array<V>(K);
    for (let i = 0; i < K; i++) {
      const rx = vals[i]!.x - cx;
      const ry = vals[i]!.y - cy;
      const a = rx * ux + ry * uy;
      const b = rx * vx + ry * vy;
      const ap = a * k;
      out[i] = { x: cx + ap * ux + b * vx, y: cy + ap * uy + b * vy };
    }
    return out;
  };

  // majorLength / minorLength: complement carries the axis basis and
  // per-point projections (normalized by the std-devs) at the last
  // non-degenerate state, so an axis collapse (λ → 0) reinflates from the
  // stored geometry. Non-degenerate writes take the scaleAlongAxis fast path.
  const buildAxisLens = (which: "major" | "minor") => {
    type AxisC = {
      uX: number;
      uY: number; // unit axis of THIS lens
      vX: number;
      vY: number; // unit perpendicular axis
      lenThis: number; // last known √λ on THIS axis
      lenOther: number; // last known √λ on the other axis
      projThis: number[]; // dev·u / lenThis, per point
      projOther: number[]; // dev·v / lenOther, per point
    };

    // Decompose and rebuild the axis basis + normalized projections;
    // returns the prior complement when fully collapsed.
    const axisFrom = (
      d: NonNullable<ReturnType<typeof decompose>>,
      c: AxisC,
      vals: readonly V[],
    ): AxisC => {
      const ux = which === "major" ? Math.cos(d.θ) : -Math.sin(d.θ);
      const uy = which === "major" ? Math.sin(d.θ) : Math.cos(d.θ);
      const vx = -uy;
      const vy = ux;
      const lenThis = Math.sqrt(Math.max(0, which === "major" ? d.lambdaMajor : d.lambdaMinor));
      const lenOther = Math.sqrt(Math.max(0, which === "major" ? d.lambdaMinor : d.lambdaMajor));
      // Only refresh projections on axes that aren't collapsed.
      const invThis = lenThis > 1e-12 ? 1 / lenThis : null;
      const invOther = lenOther > 1e-12 ? 1 / lenOther : null;
      const projThis = c.projThis.slice();
      const projOther = c.projOther.slice();
      for (let i = 0; i < K; i++) {
        const dx = vals[i]!.x - d.cx;
        const dy = vals[i]!.y - d.cy;
        if (invThis !== null) projThis[i] = (dx * ux + dy * uy) * invThis;
        if (invOther !== null) projOther[i] = (dx * vx + dy * vy) * invOther;
      }
      return { uX: ux, uY: uy, vX: vx, vY: vy, lenThis, lenOther, projThis, projOther };
    };

    return Num.lens(points as readonly Writable<Vec>[], {
      init: (vals: readonly V[]): AxisC => {
        const seed: AxisC = {
          uX: 1,
          uY: 0,
          vX: 0,
          vY: 1,
          lenThis: 0,
          lenOther: 0,
          projThis: vals.map(() => 0),
          projOther: vals.map(() => 0),
        };
        const d = decompose(vals);
        return d ? axisFrom(d, seed, vals) : seed;
      },
      step: (vals: readonly V[], c: AxisC): AxisC => {
        const d = decompose(vals);
        return d ? axisFrom(d, c, vals) : c;
      },
      fwd: (vals: readonly V[], c: AxisC): number => (decompose(vals) ? c.lenThis : 0),
      bwd: (target: number, vals: readonly V[], c: AxisC) => {
        const d = decompose(vals);
        if (d && c.lenThis > 1e-12) {
          // Lossy magnitude view: a same-magnitude target re-projects to
          // the current axis length and is absorbed (cluster left put).
          if (Math.abs(target) === c.lenThis)
            return { updates: vals.map(() => undefined), complement: c };
          // Non-degenerate fast path: scale current cluster along axis.
          const k = target / c.lenThis;
          return { updates: scaleAlongAxis(vals, d.cx, d.cy, c.uX, c.uY, k), complement: c };
        }
        // Degenerate: reconstruct from complement. Centroid still
        // derivable from current source (mean translates always work).
        let sx = 0;
        let sy = 0;
        for (let i = 0; i < K; i++) {
          sx += vals[i]!.x;
          sy += vals[i]!.y;
        }
        const cx = sx / K;
        const cy = sy / K;
        const out = new Array<V>(K);
        for (let i = 0; i < K; i++) {
          const a = c.projThis[i]! * target;
          const b = c.projOther[i]! * c.lenOther;
          out[i] = { x: cx + a * c.uX + b * c.vX, y: cy + a * c.uY + b * c.vY };
        }
        return { updates: out, complement: c };
      },
    });
  };

  const majorLength = buildAxisLens("major");
  const minorLength = buildAxisLens("minor");

  return { mean, rotation, majorLength, minorLength };
}

// ─── 6. Partition / simplex lens ───────────────────────────────────────
//
// K parts → {total}: writing total scales all parts proportionally.
// (A {total, ratios} form is possible but ratios on a K-simplex have
// K−1 DOF, so it's left out of this prototype.)
// =====================================================================

/** Writable total over K parts; write scales all parts proportionally,
 *  preserving their ratios. Complement holds per-part fractions from the
 *  last non-degenerate state, so a collapse to zero reinflates the
 *  original distribution on the next non-zero write. */
export function totalLens(parts: readonly Writable<Num>[]): Writable<Num> {
  const K = parts.length;
  if (K < 1) throw new Error("totalLens: need ≥ 1 part");

  // Complement: per-part fraction of the total at the last non-degenerate
  // state. `bwd` scales live parts by `target/sum`, or reinflates from the
  // stored fractions when the sum has collapsed to zero.
  type C = { fracs: number[] };
  const sumOf = (vals: readonly number[]): number => {
    let s = 0;
    for (let i = 0; i < K; i++) s += vals[i]!;
    return s;
  };

  const sumLens = Num.lens(parts as readonly Writable<Num>[], {
    init: (vals: readonly number[]): C => {
      const s = sumOf(vals);
      return { fracs: vals.map(v => (s > 1e-12 ? v / s : 1 / K)) };
    },
    step: (vals: readonly number[], c: C): C => {
      const s = sumOf(vals);
      return s > 1e-12 ? { fracs: vals.map(v => v / s) } : c;
    },
    fwd: (vals: readonly number[]): number => sumOf(vals),
    bwd: (target: number, vals: readonly number[], c: C) => {
      const s = sumOf(vals);
      if (s > 1e-12) {
        const k = target / s;
        return { updates: vals.map(v => v * k), complement: c };
      }
      return { updates: c.fracs.map(f => f * target), complement: c };
    },
  });
  return sumLens;
}

// Every lens here is a group action about a pivot (translate, rotateAbout,
// scaleAbout, scaleAboutXY, scaleAlongAxis); the decompositions combine
// them, each measured against a derived feature (centroid, principal axis,
// mean radius).
// =====================================================================
