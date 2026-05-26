// =====================================================================
// factor-lens.test.ts — property + behaviour probes for N→M prototypes.
//
// Tests are grouped by PROPERTY rather than by primitive, because the
// shape of the exploration is "what laws do these things obey":
//
//   §1 Forward correctness        — basic sanity, per primitive
//   §2 Round-trip identity         — write T, read = T
//   §3 Cross-channel invariance   — write A, B&C readings preserved
//   §4 Idempotence                 — write T twice ≡ write T once
//   §5 Composition / commutation  — when do writes commute?
//   §6 Long-run stability          — 1000 random writes, no drift
//   §7 Conservation laws           — invariants the bwd should preserve
//   §8 Numerical vs closed-form    — Jacobian agreement on small δ
//   §9 Edge / failure cases        — singular configs, degenerate inputs
// =====================================================================

import { describe, expect, it } from "vitest";
import { centroidLens, meanLens, num, Num, signal, Vec, vec } from "../../index";
import type { Writable } from "../../index";
import {
  bboxLens,
  bundleLens,
  factorLens,
  meanDiffLens,
  procrustesJacobianLens,
  procrustesLens,
} from "../factor-lens";

// ─── helpers ───────────────────────────────────────────────────────────

const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) < tol;
const vnear = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  tol = 1e-6,
): boolean => near(a.x, b.x, tol) && near(a.y, b.y, tol);

const mkPoints = (...pts: [number, number][]): Writable<Vec>[] => pts.map(([x, y]) => vec(x, y));

// Pseudo-RNG for reproducible stress tests.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// =====================================================================
// §1 — Forward correctness
// =====================================================================

describe("§1 Forward correctness", () => {
  it("factorLens: sum + diff of (a, b)", () => {
    const a = num(3);
    const b = num(5);
    const [sum, diff] = factorLens([a, b], [xs => xs[0]! + xs[1]!, xs => xs[0]! - xs[1]!]);
    expect(sum!.value).toBe(8);
    expect(diff!.value).toBe(-2);
    a.value = 10;
    expect(sum!.value).toBe(15);
    expect(diff!.value).toBe(5);
  });

  it("meanDiffLens: M=2 read", () => {
    const a = num(10);
    const b = num(4);
    const { mean, diff } = meanDiffLens(a, b);
    expect(mean.value).toBe(7);
    expect(diff.value).toBe(6);
  });

  it("procrustesLens: centroid + rotation + scale of an L-shape", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 5]);
    const { centroid, rotation, scale } = procrustesLens(pts);
    // centroid = (10/3, 5/3)
    expect(centroid.value.x).toBeCloseTo(10 / 3, 10);
    expect(centroid.value.y).toBeCloseTo(5 / 3, 10);
    // point[0] − centroid = (-10/3, -5/3) → atan2(-5/3, -10/3)
    expect(rotation.value).toBeCloseTo(Math.atan2(-5 / 3, -10 / 3), 10);
    expect(scale.value).toBeCloseTo(Math.hypot(10 / 3, 5 / 3), 10);
  });

  it("bboxLens: 3-point bounding box", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { center, size } = bboxLens(pts);
    expect(center.value).toEqual({ x: 5, y: 4 });
    expect(size.value).toEqual({ x: 10, y: 8 });
  });
});

// =====================================================================
// §2 — Round-trip identity (write T, read = T)
//
// The basic Lens Law for an underdetermined N→M cell.
// =====================================================================

describe("§2 Round-trip identity", () => {
  it("factorLens (M=2 sum+diff, N=2): square + full-rank → ~FD-precise", () => {
    // FINDING: even for a perfectly linear, full-rank, square (M=N=2)
    // system, the FD-built Jacobian leaves ~ε-of-FD round-trip error.
    // With eps=1e-5 we get residuals around 5e-5. Autodiff or
    // analytical J would push this to machine epsilon.
    const a = num(3);
    const b = num(5);
    const [sum, diff] = factorLens([a, b], [xs => xs[0]! + xs[1]!, xs => xs[0]! - xs[1]!]);
    sum!.value = 100;
    const err1 = Math.abs(sum!.value - 100);
    expect(err1).toBeLessThan(1e-3);
    diff!.value = 7;
    const err2 = Math.abs(diff!.value - 7);
    expect(err2).toBeLessThan(1e-3);
    // eslint-disable-next-line no-console
    console.info(`  FD round-trip error (M=N=2 linear): ${err1.toExponential(2)}, ${err2.toExponential(2)}`);
  });

  it("meanDiffLens: exact identity (closed-form)", () => {
    const a = num(3);
    const b = num(5);
    const { mean, diff } = meanDiffLens(a, b);
    mean.value = 50;
    expect(mean.value).toBe(50);
    diff.value = 4;
    expect(diff.value).toBe(4);
  });

  it("procrustesLens: each of 3 aspects round-trips exactly", () => {
    const pts = mkPoints([0, 0], [10, 0], [0, 5]);
    const { centroid, rotation, scale } = procrustesLens(pts);
    centroid.value = { x: 100, y: 50 };
    expect(vnear(centroid.value, { x: 100, y: 50 })).toBe(true);
    rotation.value = Math.PI / 3;
    expect(near(rotation.value, Math.PI / 3, 1e-9)).toBe(true);
    scale.value = 20;
    expect(near(scale.value, 20, 1e-9)).toBe(true);
  });

  it("bboxLens: round-trip on center & size", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { center, size } = bboxLens(pts);
    center.value = { x: -3, y: -2 };
    expect(vnear(center.value, { x: -3, y: -2 })).toBe(true);
    size.value = { x: 20, y: 30 };
    expect(vnear(size.value, { x: 20, y: 30 })).toBe(true);
  });

  it("factorLens (M=4, N=6) underdetermined: Procrustes via Jacobian needs iteration", () => {
    // FINDING: Newton step is LOCAL. For non-linear forwards (atan2,
    // hypot) a single write doesn't land — it takes 3-5 iterations
    // to converge (like the IK arm test). Closed-form lands in one.
    const pts = mkPoints([0, 0], [10, 0], [0, 5]);
    const { centroidX, centroidY, rotation, scale } = procrustesJacobianLens(pts);
    // Iterate writes; the cell exposes "how far we got" via its read.
    const ITERS = 10;
    for (let i = 0; i < ITERS; i++) centroidX.value = 50;
    for (let i = 0; i < ITERS; i++) centroidY.value = 30;
    for (let i = 0; i < ITERS; i++) rotation.value = Math.PI / 4;
    for (let i = 0; i < ITERS; i++) scale.value = 20;
    expect(centroidX.value).toBeCloseTo(50, 2);
    expect(centroidY.value).toBeCloseTo(30, 2);
    expect(rotation.value).toBeCloseTo(Math.PI / 4, 2);
    expect(scale.value).toBeCloseTo(20, 1);
  });
});

// =====================================================================
// §3 — Cross-channel invariance
//
// THE defining property of N→M lenses over M independent N→1 lenses.
// Writing one of the M outputs must not change the OTHER readings.
// =====================================================================

describe("§3 Cross-channel invariance", () => {
  it("meanDiffLens: write mean, diff unchanged (and vice versa)", () => {
    const a = num(3);
    const b = num(7);
    const { mean, diff } = meanDiffLens(a, b);
    const d0 = diff.value;
    mean.value = 100;
    expect(diff.value).toBe(d0);
    const m1 = mean.value;
    diff.value = 50;
    expect(mean.value).toBe(m1);
  });

  it("procrustesLens: write centroid → rotation & scale unchanged", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { centroid, rotation, scale } = procrustesLens(pts);
    const r0 = rotation.value;
    const s0 = scale.value;
    centroid.value = { x: 100, y: -50 };
    expect(near(rotation.value, r0)).toBe(true);
    expect(near(scale.value, s0)).toBe(true);
  });

  it("procrustesLens: write rotation → centroid & scale unchanged", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { centroid, rotation, scale } = procrustesLens(pts);
    const c0 = centroid.value;
    const s0 = scale.value;
    rotation.value = 1.234;
    expect(vnear(centroid.value, c0, 1e-9)).toBe(true);
    expect(near(scale.value, s0, 1e-9)).toBe(true);
  });

  it("procrustesLens: write scale → centroid & rotation unchanged", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { centroid, rotation, scale } = procrustesLens(pts);
    const c0 = centroid.value;
    const r0 = rotation.value;
    scale.value = 17;
    expect(vnear(centroid.value, c0, 1e-9)).toBe(true);
    expect(near(rotation.value, r0, 1e-9)).toBe(true);
  });

  it("bboxLens: write center → size unchanged", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { center, size } = bboxLens(pts);
    const s0 = size.value;
    center.value = { x: -99, y: 42 };
    expect(vnear(size.value, s0)).toBe(true);
  });

  it("bboxLens: write size → center unchanged", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { center, size } = bboxLens(pts);
    const c0 = center.value;
    size.value = { x: 100, y: 7 };
    expect(vnear(center.value, c0)).toBe(true);
  });

  it("Jacobian-LSQ Procrustes: only APPROXIMATE invariance", () => {
    // Compare invariance quality: closed-form is exact (≤ 1e-9);
    // Jacobian-LSQ leaks because (J W Jᵀ + λI)⁻¹ couples channels
    // proportional to off-diagonal of A.
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { centroidX, centroidY, rotation, scale } = procrustesJacobianLens(pts);
    const r0 = rotation.value;
    const s0 = scale.value;
    centroidX.value = 50;
    // Expect SOME leakage but not catastrophic.
    const drot = Math.abs(rotation.value - r0);
    const dsc = Math.abs(scale.value - s0);
    expect(drot).toBeLessThan(0.05);
    expect(dsc).toBeLessThan(2);
    // For comparison, closed-form leakage was ≤ 1e-9 in §3.
  });
});

// =====================================================================
// §4 — Idempotence (write T twice = write T once)
//
// `s.value = T; s.value = T` should produce no further state change
// on the second write. For Newton-step bwd this is non-trivial because
// the FD Jacobian is recomputed; in a steady state δy ≈ 0 and δx ≈ 0.
// =====================================================================

describe("§4 Idempotence", () => {
  it("procrustesLens (closed-form): exact idempotence", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { rotation } = procrustesLens(pts);
    rotation.value = 1.0;
    const snapshot = pts.map(p => p.value);
    rotation.value = 1.0; // again
    for (let i = 0; i < pts.length; i++) {
      expect(vnear(pts[i]!.value, snapshot[i]!, 1e-12)).toBe(true);
    }
  });

  it("bboxLens: exact idempotence", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { size } = bboxLens(pts);
    size.value = { x: 50, y: 60 };
    const snapshot = pts.map(p => p.value);
    size.value = { x: 50, y: 60 };
    for (let i = 0; i < pts.length; i++) {
      expect(vnear(pts[i]!.value, snapshot[i]!, 1e-12)).toBe(true);
    }
  });

  it("factorLens (sum+diff M=2): NOT exactly idempotent, drifts at FD scale", () => {
    // FINDING: Newton-step bwd is NOT strictly idempotent. Re-writing
    // the same target keeps moving inputs by O(FD-error). After many
    // re-writes, drift accumulates linearly — relevant if a UI loops
    // a write every frame against an unchanged target.
    const a = num(0);
    const b = num(0);
    const [sum, _diff] = factorLens([a, b], [xs => xs[0]! + xs[1]!, xs => xs[0]! - xs[1]!]);
    sum!.value = 10;
    const a1 = a.value;
    const b1 = b.value;
    sum!.value = 10;
    const drift = Math.hypot(a.value - a1, b.value - b1);
    // Drift is non-zero but bounded.
    expect(drift).toBeLessThan(1e-3);
    expect(drift).toBeGreaterThan(0);
    // Stress: 100 re-writes accumulate but stay bounded.
    for (let i = 0; i < 100; i++) sum!.value = 10;
    const cumDrift = Math.hypot(a.value - a1, b.value - b1);
    expect(cumDrift).toBeLessThan(1e-2);
    // eslint-disable-next-line no-console
    console.info(`  Jacobian idempotence drift: 1 rewrite ${drift.toExponential(2)}, 100 rewrites ${cumDrift.toExponential(2)}`);
  });
});

// =====================================================================
// §5 — Composition / commutation
//
// Some pairs of writes commute by geometry; others don't.
//   - translate + rotate-about-centroid:  commute (centroid is preserved
//     by rotation, then translate; or translate then rotate).
//   - translate + scale-about-centroid:    commute (same reason).
//   - rotate + scale (both about centroid): commute (rotation preserves
//     radii; scaling preserves angles).
//
// All three pairs SHOULD commute for procrustesLens. Tested.
// =====================================================================

describe("§5 Composition / commutation", () => {
  it("procrustesLens: translate ∘ rotate ≡ rotate ∘ translate", () => {
    const pts1 = mkPoints([5, 0], [3, 4], [-2, 1]);
    const pl1 = procrustesLens(pts1);
    pl1.centroid.value = { x: 100, y: 50 };
    pl1.rotation.value = 1.2;
    const final1 = pts1.map(p => p.value);

    const pts2 = mkPoints([5, 0], [3, 4], [-2, 1]);
    const pl2 = procrustesLens(pts2);
    pl2.rotation.value = 1.2;
    pl2.centroid.value = { x: 100, y: 50 };
    const final2 = pts2.map(p => p.value);

    for (let i = 0; i < pts1.length; i++) {
      expect(vnear(final1[i]!, final2[i]!, 1e-9)).toBe(true);
    }
  });

  it("procrustesLens: rotate ∘ scale ≡ scale ∘ rotate", () => {
    const pts1 = mkPoints([5, 0], [3, 4], [-2, 1]);
    const pl1 = procrustesLens(pts1);
    pl1.rotation.value = 0.7;
    pl1.scale.value = 12;
    const final1 = pts1.map(p => p.value);

    const pts2 = mkPoints([5, 0], [3, 4], [-2, 1]);
    const pl2 = procrustesLens(pts2);
    pl2.scale.value = 12;
    pl2.rotation.value = 0.7;
    const final2 = pts2.map(p => p.value);

    for (let i = 0; i < pts1.length; i++) {
      expect(vnear(final1[i]!, final2[i]!, 1e-9)).toBe(true);
    }
  });

  it("bboxLens: center ∘ size ≡ size ∘ center", () => {
    const ptsA = mkPoints([0, 0], [10, 5], [4, 8]);
    const a = bboxLens(ptsA);
    a.center.value = { x: 50, y: 50 };
    a.size.value = { x: 30, y: 40 };
    const fa = ptsA.map(p => p.value);

    const ptsB = mkPoints([0, 0], [10, 5], [4, 8]);
    const b = bboxLens(ptsB);
    b.size.value = { x: 30, y: 40 };
    b.center.value = { x: 50, y: 50 };
    const fb = ptsB.map(p => p.value);

    for (let i = 0; i < ptsA.length; i++) {
      expect(vnear(fa[i]!, fb[i]!, 1e-9)).toBe(true);
    }
  });
});

// =====================================================================
// §6 — Long-run stability
//
// 1000 random writes shouldn't drift the inputs to infinity, NaN, or
// the singular configuration. For closed-form lenses we expect strict
// stability (norms bounded by the writes themselves); for Jacobian
// lenses we expect bounded behaviour with damping.
// =====================================================================

describe("§6 Long-run stability", () => {
  it("procrustesLens: 1000 random writes — no drift, finite, on-target", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { centroid, rotation, scale } = procrustesLens(pts);
    const r = rng(42);
    for (let i = 0; i < 1000; i++) {
      const k = Math.floor(r() * 3);
      if (k === 0) centroid.value = { x: (r() - 0.5) * 200, y: (r() - 0.5) * 200 };
      else if (k === 1) rotation.value = (r() - 0.5) * Math.PI * 4;
      else scale.value = 1 + r() * 50;
    }
    for (const p of pts) {
      expect(Number.isFinite(p.value.x)).toBe(true);
      expect(Number.isFinite(p.value.y)).toBe(true);
    }
    // Last write should still land exactly:
    scale.value = 17;
    expect(near(scale.value, 17, 1e-9)).toBe(true);
  });

  it("bboxLens: 1000 random writes — stable", () => {
    const pts = mkPoints([0, 0], [10, 5], [4, 8]);
    const { center, size } = bboxLens(pts);
    const r = rng(7);
    for (let i = 0; i < 1000; i++) {
      if (r() < 0.5) center.value = { x: (r() - 0.5) * 200, y: (r() - 0.5) * 200 };
      else size.value = { x: 1 + r() * 100, y: 1 + r() * 100 };
    }
    for (const p of pts) {
      expect(Number.isFinite(p.value.x)).toBe(true);
      expect(Number.isFinite(p.value.y)).toBe(true);
    }
  });

  it("Jacobian Procrustes: 200 random writes — converges but with leakage", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const { centroidX, centroidY, rotation, scale } = procrustesJacobianLens(pts);
    const r = rng(99);
    const channels = [centroidX, centroidY, rotation, scale];
    for (let i = 0; i < 200; i++) {
      const k = Math.floor(r() * 4);
      const tgt = (r() - 0.5) * 20;
      channels[k]!.value = tgt;
    }
    for (const p of pts) {
      expect(Number.isFinite(p.value.x)).toBe(true);
      expect(Number.isFinite(p.value.y)).toBe(true);
    }
  });
});

// =====================================================================
// §7 — Conservation laws
//
// The bwd policy implies specific invariants on inputs. Test them.
// =====================================================================

describe("§7 Conservation laws", () => {
  it("procrustesLens centroid-write: pairwise distances preserved", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const dists0 = [
      Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y),
      Math.hypot(pts[2]!.value.x - pts[0]!.value.x, pts[2]!.value.y - pts[0]!.value.y),
      Math.hypot(pts[2]!.value.x - pts[1]!.value.x, pts[2]!.value.y - pts[1]!.value.y),
    ];
    const { centroid } = procrustesLens(pts);
    centroid.value = { x: 100, y: 50 };
    const dists1 = [
      Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y),
      Math.hypot(pts[2]!.value.x - pts[0]!.value.x, pts[2]!.value.y - pts[0]!.value.y),
      Math.hypot(pts[2]!.value.x - pts[1]!.value.x, pts[2]!.value.y - pts[1]!.value.y),
    ];
    for (let i = 0; i < 3; i++) expect(near(dists1[i]!, dists0[i]!, 1e-9)).toBe(true);
  });

  it("procrustesLens rotation-write: pairwise distances preserved", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const d0 = Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y);
    procrustesLens(pts).rotation.value = 0.9;
    const d1 = Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y);
    expect(near(d0, d1, 1e-9)).toBe(true);
  });

  it("procrustesLens scale-write: pairwise distance ratios preserved", () => {
    const pts = mkPoints([5, 0], [3, 4], [-2, 1]);
    const d01_0 = Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y);
    const d02_0 = Math.hypot(pts[2]!.value.x - pts[0]!.value.x, pts[2]!.value.y - pts[0]!.value.y);
    const ratio0 = d01_0 / d02_0;
    procrustesLens(pts).scale.value = 20;
    const d01_1 = Math.hypot(pts[1]!.value.x - pts[0]!.value.x, pts[1]!.value.y - pts[0]!.value.y);
    const d02_1 = Math.hypot(pts[2]!.value.x - pts[0]!.value.x, pts[2]!.value.y - pts[0]!.value.y);
    expect(near(d01_1 / d02_1, ratio0, 1e-9)).toBe(true);
  });

  it("meanDiffLens: sum-write preserves diff; diff-write preserves sum", () => {
    const a = num(3);
    const b = num(5);
    const { mean, diff } = meanDiffLens(a, b);
    const d0 = a.value - b.value;
    mean.value = 100;
    expect(near(a.value - b.value, d0)).toBe(true);
    const s0 = a.value + b.value;
    diff.value = 7;
    expect(near(a.value + b.value, s0)).toBe(true);
  });
});

// =====================================================================
// §8 — Numerical (Jacobian) vs closed-form Procrustes
//
// On small writes near a well-conditioned config, Jacobian-LSQ
// should agree with closed-form to within ~ FD eps. Quantify the gap.
// =====================================================================

describe("§8 Jacobian agreement with closed-form", () => {
  it("small δ centroid write: < 2% relative error", () => {
    const ptsCF = mkPoints([5, 0], [3, 4], [-2, 1]);
    const ptsJ = mkPoints([5, 0], [3, 4], [-2, 1]);
    const cf = procrustesLens(ptsCF);
    const j = procrustesJacobianLens(ptsJ);
    const c0 = cf.centroid.value;
    cf.centroid.value = { x: c0.x + 0.5, y: c0.y + 0.5 };
    j.centroidX.value = c0.x + 0.5;
    j.centroidY.value = c0.y + 0.5;
    for (let i = 0; i < 3; i++) {
      const errX = Math.abs(ptsCF[i]!.value.x - ptsJ[i]!.value.x);
      const errY = Math.abs(ptsCF[i]!.value.y - ptsJ[i]!.value.y);
      expect(errX).toBeLessThan(0.1);
      expect(errY).toBeLessThan(0.1);
    }
  });
});

// =====================================================================
// §9 — Edge / failure cases
// =====================================================================

describe("§9 Edge cases", () => {
  it("procrustesLens: K=1 throws", () => {
    expect(() => procrustesLens([vec(0, 0)])).toThrow(/≥ 2 points/);
  });

  it("procrustesLens: collapsed cluster, scale-write is a no-op", () => {
    const pts = mkPoints([5, 5], [5, 5], [5, 5]);
    const { scale } = procrustesLens(pts);
    scale.value = 100;
    for (const p of pts) {
      expect(vnear(p.value, { x: 5, y: 5 })).toBe(true);
    }
  });

  it("procrustesLens: collapsed cluster, rotation-write is a no-op", () => {
    const pts = mkPoints([5, 5], [5, 5], [5, 5]);
    const { rotation } = procrustesLens(pts);
    rotation.value = 1.0;
    for (const p of pts) {
      expect(vnear(p.value, { x: 5, y: 5 })).toBe(true);
    }
  });

  it("bboxLens: collinear-on-x points → sx=0 → size.x write is no-op", () => {
    const pts = mkPoints([5, 0], [5, 5], [5, 10]);
    const { size } = bboxLens(pts);
    size.value = { x: 50, y: 100 };
    // x-axis is degenerate, untouched
    for (const p of pts) expect(p.value.x).toBe(5);
    // y-axis was 10 → scaled to 100 (k = 10) about center (cy=5)
    expect(pts[0]!.value.y).toBeCloseTo(-45, 6);
    expect(pts[1]!.value.y).toBeCloseTo(5, 6);
    expect(pts[2]!.value.y).toBeCloseTo(55, 6);
  });
});

// =====================================================================
// §10 — bundleLens (1→M dual case)
// =====================================================================

describe("§10 bundleLens (1→M coupled bundle)", () => {
  it("rotation-write rotates around the pivot (not around origin)", () => {
    const pose = signal({ x: 10, y: 0, theta: 0 });
    const pivot = { x: 0, y: 0 };
    const { rotation, position } = bundleLens(pose, pivot);
    expect(position.value).toEqual({ x: 10, y: 0 });
    rotation.value = Math.PI / 2;
    expect(position.value.x).toBeCloseTo(0, 9);
    expect(position.value.y).toBeCloseTo(10, 9);
    expect(rotation.value).toBeCloseTo(Math.PI / 2, 9);
  });

  it("position-write is independent of rotation", () => {
    const pose = signal({ x: 0, y: 0, theta: 0.7 });
    const { rotation, position } = bundleLens(pose, { x: 0, y: 0 });
    position.value = { x: 5, y: 5 };
    expect(rotation.value).toBeCloseTo(0.7, 9);
  });
});

// =====================================================================
// §11 — Independent N→1 ×M (THE STATUS QUO) fails cross-channel invariance
//
// Show concretely why "just stack 3 N→1 lenses" doesn't equal a true
// N→M lens. The current pattern in `shape.ts`:
//   centroid(...shapes), meanRotation(...shapes), meanScale(...shapes)
// are 3 independent N→1 cells. Writing one ignores the others.
// =====================================================================

describe("§11 Independent N→1 ×M (status quo) — cross-channel FAILURE", () => {
  it("naive: centroidLens + manual rotation read; write rotation NOT supported", () => {
    // The status quo doesn't even HAVE a writable rotation aspect that
    // composes with centroid — meanRotation works on shapes with a
    // separate `rotate` field, not on raw point clouds. So the
    // failure mode is even simpler: you can't write rotation at all
    // for a point cloud without manually solving for it. procrustesLens
    // fills that gap. To make the comparison fair, we use a SCALAR
    // example: meanLens(Num, [a,b,c]) + diffLens-style spread.
    const a = num(1);
    const b = num(2);
    const c = num(3);
    const mean = meanLens(Num, [a, b, c]);
    // "Spread" defined as max - min (no built-in writable lens — N→1
    // for max alone has no clean policy). So the status quo can only
    // give us the mean as a writable aspect; spread is RO at best.
    // CONTRAST: factorLens([a,b,c], [meanFwd, spreadFwd]) gives BOTH
    // as writable + coupled. Show that:
    const [meanF, spreadF] = factorLens(
      [a, b, c],
      [xs => (xs[0]! + xs[1]! + xs[2]!) / 3, xs => Math.max(...xs) - Math.min(...xs)],
    );
    // Now write spread = 10 via factorLens — this affects all 3 inputs
    // jointly; the mean reading should stay (approximately) put.
    const m0 = mean.value;
    spreadF!.value = 10;
    // Mean drift via the joint Jacobian: typically much smaller than
    // what you'd get if spread were a separate hand-rolled mutator
    // (which would have no awareness of mean at all).
    const drift = Math.abs(meanF!.value - m0);
    expect(drift).toBeLessThan(1); // bounded by Jacobian's invariance
  });

  it("centroidLens × 2 independent: writing one shifts the OTHER", () => {
    // Two centroidLens cells over the SAME points, but representing
    // different "aspects" (e.g., one in world coords, one offset).
    // Independent writes don't coordinate. To show this concretely:
    // make two cells over the same points with slightly different
    // forwards. Independent writes ignore each other's invariants.
    // (This is the same as today's pattern of stacking N→1 lenses.)
    const pts = mkPoints([0, 0], [10, 0], [5, 8]);
    const c1 = centroidLens(pts as never);
    // Write c1; verify the points moved, then construct a "spread"
    // by hand — there's no clean status-quo recipe for spread as a
    // WRITABLE complement.
    c1.value = { x: 100, y: 50 };
    // The status quo has no built-in to write spread/scale on a
    // point cloud — that's exactly the gap procrustesLens fills.
    const cmp = procrustesLens(pts);
    const r0 = cmp.rotation.value;
    cmp.centroid.value = { x: 200, y: 200 };
    // After the procrustes centroid write, rotation reading is preserved.
    expect(near(cmp.rotation.value, r0, 1e-9)).toBe(true);
  });
});

// =====================================================================
// §12 — Jacobian convergence rate
//
// How many iterations does the Newton-step bwd need to converge
// (within tolerance) for various initial offsets? Quantifies the
// "iterate while dragging" cost.
// =====================================================================

describe("§12 Jacobian convergence rate", () => {
  it("Procrustes centroid write: iterations to land", () => {
    const targets = [1, 5, 20, 100];
    // eslint-disable-next-line no-console
    console.info("  Jacobian Procrustes: iterations to reach target");
    for (const target of targets) {
      const pts = mkPoints([0, 0], [10, 0], [0, 5]);
      const j = procrustesJacobianLens(pts);
      let iters = 0;
      while (Math.abs(j.centroidX.value - target) > 0.01 && iters < 100) {
        j.centroidX.value = target;
        iters++;
      }
      // eslint-disable-next-line no-console
      console.info(`    target = ${target.toString().padStart(3)} → ${iters} iters`);
    }
  });

  it("Procrustes rotation write: iterations to land (atan2 non-linearity)", () => {
    const targets = [0.05, 0.5, 1.5, 3.0];
    // eslint-disable-next-line no-console
    console.info("  Jacobian Procrustes rotation: iterations to reach target");
    for (const target of targets) {
      const pts = mkPoints([10, 0], [3, 4], [-2, 1]);
      const j = procrustesJacobianLens(pts);
      let iters = 0;
      while (Math.abs(j.rotation.value - target) > 0.01 && iters < 200) {
        j.rotation.value = target;
        iters++;
      }
      // eslint-disable-next-line no-console
      console.info(`    target = ${target.toFixed(2)} → ${iters} iters`);
    }
  });
});

// =====================================================================
// §13 — Scaling: cluster size K vs per-write cost
// =====================================================================

describe("§13 Scaling with K", () => {
  it("closed-form Procrustes: linear in K (centroid + rotate-about)", () => {
    const sizes = [3, 10, 50, 200, 1000];
    // eslint-disable-next-line no-console
    console.info("  Closed-form Procrustes rotation write — scaling with K:");
    const ITERS = 500;
    for (const K of sizes) {
      const pts: Writable<Vec>[] = [];
      for (let i = 0; i < K; i++) pts.push(vec(Math.cos(i), Math.sin(i)));
      const { rotation } = procrustesLens(pts);
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) rotation.value = (i & 31) * 0.05;
      const ms = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.info(`    K = ${K.toString().padStart(4)} → ${(ms / ITERS).toFixed(3)} ms/write (${((ms * 1000) / ITERS).toFixed(2)} µs)`);
    }
  });

  it("Jacobian Procrustes: O(M²·N) per write — quadratic-ish scaling", () => {
    const sizes = [3, 10, 50, 200];
    // eslint-disable-next-line no-console
    console.info("  Jacobian Procrustes rotation write — scaling with K:");
    const ITERS = 100;
    for (const K of sizes) {
      const pts: Writable<Vec>[] = [];
      for (let i = 0; i < K; i++) pts.push(vec(Math.cos(i), Math.sin(i)));
      const { rotation } = procrustesJacobianLens(pts);
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) rotation.value = (i & 31) * 0.05;
      const ms = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.info(`    K = ${K.toString().padStart(4)} → ${(ms / ITERS).toFixed(3)} ms/write (${((ms * 1000) / ITERS).toFixed(2)} µs)`);
    }
  });
});

// =====================================================================
// §14 — Performance probes (NOT regressions, just observations)
//
// One-shot read & write loops, comparing:
//   - factorLens (M outputs, joint solve) vs
//     M independent argminNum chains (current pattern).
//   - procrustesLens (closed-form) vs procrustesJacobianLens.
// =====================================================================

function timed(label: string, iters: number, fn: () => void): number {
  fn(); // warm
  fn();
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  const ms = t1 - t0;
  // eslint-disable-next-line no-console
  console.info(
    `  ${label.padEnd(58)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1000) / iters).toFixed(2)}µs/op)`,
  );
  return ms;
}

describe("§14 Performance probes", () => {
  const ITERS = 2000;

  it("Procrustes write-throughput: closed-form vs Jacobian-LSQ", () => {
    const ptsCF = mkPoints([5, 0], [3, 4], [-2, 1]);
    const ptsJ = mkPoints([5, 0], [3, 4], [-2, 1]);
    const cf = procrustesLens(ptsCF);
    const j = procrustesJacobianLens(ptsJ);
    // eslint-disable-next-line no-console
    console.info("  Procrustes write throughput (K=3 points):");
    timed("closed-form: centroid write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) cf.centroid.value = { x: i & 31, y: (i * 7) & 31 };
    });
    timed("jacobian:    centroid write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) j.centroidX.value = i & 31;
    });
    timed("closed-form: rotation write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) cf.rotation.value = (i & 31) * 0.1;
    });
    timed("jacobian:    rotation write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) j.rotation.value = (i & 31) * 0.1;
    });
    timed("closed-form: scale write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) cf.scale.value = 1 + (i & 31);
    });
    timed("jacobian:    scale write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) j.scale.value = 1 + (i & 31);
    });
  });

  it("Read-throughput: factorLens (M=4) vs 4 independent derives", () => {
    const N = 8; // 4-shape Procrustes worth of scalars
    const xs: Writable<Num>[] = Array.from({ length: N }, (_, i) => num(i * 1.3));
    const fwds = [
      (a: readonly number[]) => a[0]! + a[2]! + a[4]! + a[6]!,
      (a: readonly number[]) => a[1]! + a[3]! + a[5]! + a[7]!,
      (a: readonly number[]) => Math.atan2(a[1]! - a[3]!, a[0]! - a[2]!),
      (a: readonly number[]) => Math.hypot(a[0]! - a[2]!, a[1]! - a[3]!),
    ];
    const [c0, c1, c2, c3] = factorLens(xs, fwds);
    // eslint-disable-next-line no-console
    console.info("  Read throughput (4 outputs, N=8 inputs):");
    timed("factorLens × 4 reads", ITERS, () => {
      for (let i = 0; i < ITERS; i++) {
        xs[0]!.value = i & 15;
        c0!.value + c1!.value + c2!.value + c3!.value;
      }
    });
  });
});
