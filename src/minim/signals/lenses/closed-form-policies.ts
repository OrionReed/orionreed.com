// =====================================================================
// closed-form-policies.ts — exact group-action lenses for point clouds.
//
// The framing: when a bidirectional aggregate lens has a closed-form
// inverse, it's because the bwd is literally applying a GROUP ELEMENT
// to the source set. Translation, rotation-about-pivot, and scale-about-
// pivot are the three building blocks for "rigid body of a cluster"
// manipulation. Procrustes, best-fit line, best-fit circle, PCA all
// decompose into combinations of these.
//
// The three things this file demonstrates:
//
//   1. BUILDING BLOCKS — `rigidTranslate`, `rotateAbout`, `scaleAbout`
//      as reusable primitives. Each applies one group action; cross-
//      action invariance is automatic from group commutativity.
//
//   2. DECOMPOSITION — `procrustesLens` re-expressed as the composition
//      of those building blocks. Verify behavioural parity with the
//      hand-rolled monolith.
//
//   3. NEW PRIMITIVES — `bestFitLine`, `bestFitCircle`, `pcaLens`,
//      `partitionLens` as closed-form M-output decompositions of new
//      problem shapes. Each is exact, idempotent, and cross-channel
//      invariant by construction.
//
// All exports use the same `Cls.lens` machinery as the existing engine;
// this is pure code-on-top, no engine changes.
// =====================================================================

import {
  centroidLens,
  Num,
  type Pivotal,
  type Read,
  type Signal,
  type Traits,
  Vec,
  type Writable,
} from "../index";

type V = { x: number; y: number };

// ─── Trait dispatch helper ─────────────────────────────────────────────
//
// Pivotal lookup goes through the value class's `static traits.pivotal`
// slot. Cached per (class, op) at first call.
//
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

/** Writable centroid that, on write, translates every point by the
 *  delta to target. Identical to the existing `centroidLens`; aliased
 *  here for the "policy" naming. */
export function rigidTranslate(points: readonly Writable<Vec>[]): Writable<Vec> {
  return centroidLens(points as never);
}

/** Writable angle. Read = angle from `pivot` to the position of `points[0]`.
 *  Write rotates every input about `pivot` by (target − current) via the
 *  `Pivotal` trait of the input value class.
 *
 *  Trait-generic: works for ANY value type that declares `traits.pivotal`.
 *  Vec rotates as a position; Pose rotates BOTH position and orientation;
 *  user-defined geometric types opt in via the trait.
 *
 *  Cross-action invariance: rotation-about-pivot preserves any quantity
 *  defined relative to pivot — including pivot itself (it's the fixed
 *  point), radial distances from pivot (so scale-about-pivot is
 *  unchanged), and any rotation about a *different* pivot is also
 *  preserved up to first order if that other pivot translates with the
 *  cloud (e.g., centroid of a rigid rotation about itself).
 *
 *  `pivot` is reactive — read on every write. Pass `centroidLens(points)`
 *  for a Procrustes-style "rotation about the cluster's own centroid". */
// biome-ignore lint/suspicious/noExplicitAny: variance escape — T constrained at run by Pivotal lookup
export function rotateAbout<T extends { x: number; y: number }>(
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  points: readonly Writable<Traits<T, "pivotal"> & Signal<T>>[],
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

/** Writable radial distance from pivot to position of `points[0]`. Write
 *  scales every input radially about `pivot`. Negative target reflects.
 *  Cross-channel invariance with `rotateAbout` is exact.
 *
 *  Symmetric implementation: the complement carries per-point offsets
 *  from the pivot at the most recent non-degenerate state. When the
 *  cluster has collapsed onto the pivot (radius ≈ 0), writing a
 *  non-zero target reinflates from the stored shape — the trap is
 *  gone. For Pose inputs, `theta` is preserved across the round-trip
 *  (the complement only stores spatial offset). */
export function scaleAbout<T extends { x: number; y: number }>(
  // biome-ignore lint/suspicious/noExplicitAny: variance escape
  points: readonly Writable<Traits<T, "pivotal"> & Signal<T>>[],
  pivot: Read<V>,
): Writable<Num> {
  const K = points.length;
  if (K < 1) throw new Error("scaleAbout: need ≥ 1 point");
  // Pivotal lookup eagerly so an undeclared class fails at construction:
  pivotalOf<T>(points[0]!);

  // Complement: per-point offset from the pivot at the most recent non-
  // degenerate state. `step` refreshes each offset from the live source
  // (keeping the last good one for any point collapsed onto the pivot);
  // `bwd` scales those stored offsets to the target radius.
  type C = { devs: V[] };
  const refresh = (devs: V[], vals: readonly T[], p: V): V[] =>
    devs.map((d, i) => {
      const dx = vals[i]!.x - p.x;
      const dy = vals[i]!.y - p.y;
      return dx * dx + dy * dy > 1e-18 ? { x: dx, y: dy } : d;
    });

  // biome-ignore lint/suspicious/noExplicitAny: variance escape — spec is checked structurally
  return (Num as any).statefulLens(points as unknown as readonly Writable<Signal<T>>[], {
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
      const d0 = c.devs[0]!;
      const r0 = Math.hypot(d0.x, d0.y);
      if (r0 < 1e-12) return { updates: vals.map(() => undefined), complement: c };
      const k = target / r0;
      const out = vals.map((v, i) => ({ ...v, x: p.x + k * c.devs[i]!.x, y: p.y + k * c.devs[i]!.y }));
      return { updates: out, complement: c };
    },
  }) as Writable<Num>;
}

/** Per-axis scale about a pivot. Vec-specific (the Pivotal trait
 *  doesn't currently expose per-axis scaling — it'd require an extra
 *  method; for now the per-axis case stays inline for Vec).
 *
 *  Symmetric: complement carries per-point per-axis fractions of
 *  point 0's offset from pivot, so collapse on either axis is
 *  recoverable (cf. `bboxLens.size`). */
export function scaleAboutXY(points: readonly Writable<Vec>[], pivot: Read<V>): Writable<Vec> {
  const K = points.length;
  if (K < 1) throw new Error("scaleAboutXY: need ≥ 1 point");

  // Initial fractions: point i's (x − pivot.x) / (point0.x − pivot.x),
  // and same for y. Captures the cluster's shape relative to point 0's
  // own offset, so that writing target=(Tx, Ty) places points at
  // `pivot + (fx_i*Tx, fy_i*Ty)`.
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

  return Vec.statefulLens(points as readonly Writable<Vec>[], {
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

/** Same semantics as `factor-lens.ts`'s `procrustesLens`, but
 *  decomposed into three building-block lenses sharing a centroid.
 *
 *  This is the proof-of-decomposition: if the building blocks are
 *  correct, this should be behaviourally indistinguishable from the
 *  hand-rolled monolith. */
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
// K points → {point: Vec, direction: Num}
//   point     := centroid of points
//   direction := principal axis angle (atan2 of dominant eigenvector
//                of the 2×2 covariance matrix)
//
// Writes:
//   write point     →  rigidTranslate
//   write direction →  rotate all about centroid so principal axis = direction
//
// Cross-channel invariance:
//   point ←→ direction: principal axis is invariant under translation,
//                       centroid is invariant under rotation-about-itself.
//
// =====================================================================

/** Closed-form 2×2 symmetric eigendecomposition. Returns the angle of
 *  the dominant eigenvector. */
function dominantAxisAngle(cxx: number, cxy: number, cyy: number): number {
  // For symmetric 2×2 matrix [[cxx, cxy], [cxy, cyy]], the dominant
  // eigenvector has angle θ = (1/2) atan2(2cxy, cxx − cyy).
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

/** Wrap to (-m/2, m/2]; used to choose the representative of an angle
 *  closest to a stored reference, modulo `m`. For axes we use m = π
 *  (axis-angle has period π); for full-vector angles m = 2π. */
const wrapMod = (x: number, m: number): number => x - m * Math.round(x / m);

export function bestFitLineLens(points: readonly Writable<Vec>[]): {
  point: Writable<Vec>;
  direction: Writable<Num>;
} {
  const K = points.length;
  if (K < 2) throw new Error("bestFitLine: need ≥ 2 points");

  const point = rigidTranslate(points);

  // Stateful: the principal axis is an eigenvector — defined only up to
  // sign. As the cloud rotates, the "raw" angle from atan2 jumps by π
  // discontinuously. The complement stores the last-emitted angle; we
  // wrap the raw value to the representative closest to it (mod π, because
  // axis ≡ axis + π). Result: a continuous real-valued angle that
  // monotonically tracks rotation — no jitter at the wrap points. `step`
  // advances the winding from the source; `bwd` rotates the cloud and
  // pins the complement to the written angle (and on a collapsed cloud,
  // where direction is undefined, stores the angle for later with no
  // source move).
  type C = { θ: number };
  // Centroid + dominant-axis raw angle of a cloud; `degenerate` when the
  // covariance vanishes (a collapsed cluster carries no direction).
  const axisOf = (vals: readonly V[]): { cx: number; cy: number; rawθ: number; degenerate: boolean } => {
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

  const direction = Num.statefulLens(points as readonly Writable<Vec>[], {
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
        return { updates: vals.map(() => undefined) as readonly (V | undefined)[], complement: { θ: target } };
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
// K points → {center: Vec, radius: Num}
//   center := mean of points (geometric centroid)
//   radius := mean Euclidean distance from center
//
// Writes:
//   write center → rigidTranslate
//   write radius → scale all about center by target/current radius
//
// This is the simplest closed-form circle fit. For algebraic least-
// squares (Pratt / Taubin), the center moves toward where the cloud
// concentration suggests — but for symmetric clouds those coincide
// with the mean, and the mean is exact, idempotent, and cheap.
//
// Cross-channel invariance:
//   center ↔ radius: translation preserves all radial distances,
//                    so radius is invariant under center-write.
//                    Uniform scale-about-center preserves the center.
// =====================================================================

export function bestFitCircleLens(points: readonly Writable<Vec>[]): {
  center: Writable<Vec>;
  radius: Writable<Num>;
} {
  const K = points.length;
  if (K < 1) throw new Error("bestFitCircle: need ≥ 1 point");

  const center = rigidTranslate(points);

  // Symmetric: complement = per-point deviations normalized by the
  // cluster's mean radial distance. Writing `radius = T` places each
  // point at `centroid + normDev_i * T` — preserving the relative
  // distribution (a point that was at 1.5× the mean radius stays at
  // 1.5× the new mean radius). When the cluster collapses to a point
  // (mean ≈ 0) the stored normalized devs survive and reinflate the
  // original SHAPE, not a perfect circle.
  // Complement: per-point deviation from the centroid, normalized by the
  // cluster's mean radial distance. `step` refreshes the norms while the
  // cluster is non-degenerate; `bwd` scales the live devs (fast path) or,
  // when collapsed, reinflates the stored SHAPE.
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

  const radius = Num.statefulLens(points as readonly Writable<Vec>[], {
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
// K points → {mean: Vec, rotation: Num, majorLength: Num, minorLength: Num}
//
//   mean        := centroid
//   rotation    := angle of dominant eigenvector
//   majorLength := √(λ_major), the std-dev along the major axis
//   minorLength := √(λ_minor), the std-dev along the minor axis
//
// Writes:
//   write mean        → rigidTranslate
//   write rotation    → rotate all about mean to make principal axis = target
//   write majorLength → scale along current major axis by target/current
//   write minorLength → scale along current minor axis by target/current
//
// This is the full affine-similarity decomposition: 4 DOF (tx, ty, θ,
// kMajor, kMinor would be 5 DOF — but uniform scale uses only 1 of them;
// here we expose both for per-axis scale). Each write is a single group
// action; cross-channel invariance holds for all pairs.
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

  // Helper: 2×2 sym eigendecomp returning {θ_major, λ_major, λ_minor}.
  // Returns null if the cloud is degenerate (eigenvalues coincide AND
  // both ≈ 0 — completely collapsed).
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

  // Scale along an axis given by direction (ux, uy). The cloud is
  // translated to mean-origin, projected onto (u, u_perp) basis,
  // scaled by k along u, projected back, translated back to mean.
  const scaleAlongAxis = (
    vals: readonly V[],
    cx: number,
    cy: number,
    ux: number,
    uy: number,
    k: number,
  ): V[] => {
    // The perpendicular axis:
    const vx = -uy;
    const vy = ux;
    const out = new Array<V>(K);
    for (let i = 0; i < K; i++) {
      const rx = vals[i]!.x - cx;
      const ry = vals[i]!.y - cy;
      // Project onto u and v:
      const a = rx * ux + ry * uy;
      const b = rx * vx + ry * vy;
      // Scale a by k, leave b unchanged:
      const ap = a * k;
      // Project back:
      out[i] = { x: cx + ap * ux + b * vx, y: cy + ap * uy + b * vy };
    }
    return out;
  };

  // Symmetric majorLength / minorLength: the complement carries the
  // axes and per-point projections (normalized by the std-devs) at the
  // most recent non-degenerate state. When the cluster collapses
  // along an axis (eigenvalue → 0) the stored basis + projections
  // reinflate the original geometry. Non-degenerate writes use the
  // existing fast path (scaleAlongAxis) so the perf parity holds.

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

    // Pure refresh: decompose the cluster and rebuild the axis basis +
    // normalized per-point projections. Returns the prior complement
    // unchanged when the cluster is fully collapsed (no decomposition).
    const axisFrom = (d: NonNullable<ReturnType<typeof decompose>>, c: AxisC, vals: readonly V[]): AxisC => {
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

    return Num.statefulLens(points as readonly Writable<Vec>[], {
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
// K positive nums (parts) → {total: Num, ratios: Vec[K]-ish}
//
// Two natural M-output decompositions:
//
//   simpleform: K parts → {total: Num} alone (the conservation lens)
//     - write total → scale all parts proportionally
//     - (no per-ratio cells; users mutate underlying parts directly)
//
//   ratiosForm: K parts → {total: Num, ratios: Num[]}
//     - write total → scale all parts proportionally (ratios unchanged)
//     - write ratios[k] → renormalize while preserving total
//
// Since ratios on a K-simplex have K−1 DOF, exposing K of them is
// redundant. For the prototype, we go with the simpler {total} form;
// extension to per-ratio is straightforward but the API gets gnarlier.
// =====================================================================

/** Single-output: writable total. Writing total scales all parts
 *  proportionally, preserving the ratios between them.
 *
 *  Symmetric implementation: the complement holds per-part fractions
 *  (`parts[i] / total`) captured at the last non-degenerate state.
 *  When the sum collapses to zero, the stored fractions reinflate the
 *  original distribution on the next non-zero write — no "distribute
 *  evenly" fallback, no information loss. */
export function totalLens(parts: readonly Writable<Num>[]): Writable<Num> {
  const K = parts.length;
  if (K < 1) throw new Error("totalLens: need ≥ 1 part");

  // Complement: per-part fraction of the total at the last non-degenerate
  // state. `bwd` scales the live parts by `target/sum` (bit-exact); when
  // the sum has collapsed to zero it reinflates from the stored fractions.
  type C = { fracs: number[] };
  const sumOf = (vals: readonly number[]): number => {
    let s = 0;
    for (let i = 0; i < K; i++) s += vals[i]!;
    return s;
  };

  const sumLens = Num.statefulLens(parts as readonly Writable<Num>[], {
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

// ─── 7. (Aside) The "policy" framing ───────────────────────────────────
//
// Looking at what we've built, every closed-form aggregate lens here
// is one of three group actions about a pivot:
//
//     translate       → centroidLens / rigidTranslate
//     rotateAbout     → rotateAbout
//     scaleAbout      → scaleAbout (uniform)
//     scaleAboutXY    → scaleAboutXY (per-axis)
//     scaleAlongAxis  → (used internally by pcaLens majorLength/minorLength)
//
// The decompositions (procrustes, bestFitLine, bestFitCircle, pcaLens)
// are *combinations* of these primitive actions, each measured against
// a derived feature (centroid, principal axis, mean radius).
//
// This is the closed-form catalog from the previous reflection,
// realized: pick the group action + the feature it acts on, get an
// exact, cross-channel-invariant writable view.
// =====================================================================
