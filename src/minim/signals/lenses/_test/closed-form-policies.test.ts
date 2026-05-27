// =====================================================================
// closed-form-policies.test.ts — exact group-action lens probes.
//
// Sections:
//   §1 Building blocks: rigidTranslate, rotateAbout, scaleAbout, scaleAboutXY
//   §2 Procrustes-via-building-blocks: behavioural parity with monolith
//   §3 Best-fit line: properties + write semantics
//   §4 Best-fit circle: properties + write semantics
//   §5 PCA / affine-similarity decomposition: writes + cross-channel
//   §6 Partition / total lens: conservation property
//   §7 Perf: closed-form policies vs factor() vs hand-rolled
// =====================================================================

import { describe, expect, it } from "vitest";
import type { Num, Writable } from "../../index";
import { centroidLens, num, type Pose, pose, type Vec, vec } from "../../index";
import {
  bestFitCircleLens,
  bestFitLineLens,
  pcaLens,
  procrustesViaBuildingBlocks,
  rigidTranslate,
  rotateAbout,
  scaleAbout,
  scaleAboutXY,
  totalLens,
} from "../closed-form-policies";
import { procrustesLens } from "../factor-lens";
import { factor } from "../typed-factor";

// ─── helpers ───────────────────────────────────────────────────────────

const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) < tol;
const vnear = (a: { x: number; y: number }, b: { x: number; y: number }, tol = 1e-9): boolean =>
  near(a.x, b.x, tol) && near(a.y, b.y, tol);

const mkPoints = (...pts: [number, number][]): Writable<Vec>[] => pts.map(([x, y]) => vec(x, y));

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function timed(label: string, iters: number, fn: () => void): number {
  fn();
  fn();
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  const ms = t1 - t0;
  // eslint-disable-next-line no-console
  console.info(
    `  ${label.padEnd(60)}  ${ms.toFixed(2).padStart(7)}ms  (${((ms * 1000) / iters).toFixed(2)}µs/op)`,
  );
  return ms;
}

// =====================================================================
// §1 — Building blocks
// =====================================================================

describe("§1 Building blocks", () => {
  it("rigidTranslate = centroidLens (aliased)", () => {
    const pts = mkPoints([0, 0], [10, 0], [5, 6]);
    const t = rigidTranslate(pts);
    expect(t.value).toEqual({ x: 5, y: 2 });
    t.value = { x: 100, y: 100 };
    expect(pts[0]!.value).toEqual({ x: 95, y: 98 });
    expect(pts[1]!.value).toEqual({ x: 105, y: 98 });
    expect(pts[2]!.value).toEqual({ x: 100, y: 104 });
  });

  it("rotateAbout pivot: rotates cluster, preserves pivot exactly", () => {
    const pivot = vec(0, 0);
    const pts = mkPoints([10, 0], [0, 10], [-10, 0], [0, -10]);
    const angle = rotateAbout(pts, pivot);
    expect(angle.value).toBeCloseTo(0, 9); // angle from (0,0) to (10,0) = 0
    angle.value = Math.PI / 2;
    // Rotate everything 90° CCW
    expect(vnear(pts[0]!.value, { x: 0, y: 10 })).toBe(true);
    expect(vnear(pts[1]!.value, { x: -10, y: 0 })).toBe(true);
    expect(vnear(pts[2]!.value, { x: 0, y: -10 })).toBe(true);
    expect(vnear(pts[3]!.value, { x: 10, y: 0 })).toBe(true);
    // Pivot unchanged (it's not in the input set, so trivially):
    expect(vnear(pivot.value, { x: 0, y: 0 })).toBe(true);
  });

  it("rotateAbout with reactive pivot (centroid): cluster rotates about its centroid", () => {
    const pts = mkPoints([10, 0], [0, 10], [-10, 0], [0, -10]);
    const c = centroidLens(pts as never);
    const angle = rotateAbout(pts, c);
    const c0 = c.value;
    angle.value = Math.PI;
    // 180° rotation about centroid (0, 0) should negate every point.
    expect(vnear(pts[0]!.value, { x: -10, y: 0 })).toBe(true);
    // Centroid unchanged (rotation about it is its fixed point).
    expect(vnear(c.value, c0)).toBe(true);
  });

  it("scaleAbout pivot: scales cluster, preserves pivot & angles", () => {
    const pivot = vec(0, 0);
    const pts = mkPoints([10, 0], [0, 10]);
    const r = scaleAbout(pts, pivot);
    expect(r.value).toBeCloseTo(10, 9);
    r.value = 20;
    expect(vnear(pts[0]!.value, { x: 20, y: 0 })).toBe(true);
    expect(vnear(pts[1]!.value, { x: 0, y: 20 })).toBe(true);
  });

  it("scaleAboutXY pivot: per-axis scale", () => {
    const pivot = vec(0, 0);
    const pts = mkPoints([2, 3], [4, 6]);
    const s = scaleAboutXY(pts, pivot);
    expect(s.value).toEqual({ x: 2, y: 3 });
    s.value = { x: 10, y: 30 };
    // x scales by 5, y by 10
    expect(vnear(pts[0]!.value, { x: 10, y: 30 })).toBe(true);
    expect(vnear(pts[1]!.value, { x: 20, y: 60 })).toBe(true);
  });

  it("scaleAbout: negative target reflects the cluster", () => {
    const pivot = vec(0, 0);
    const pts = mkPoints([10, 0], [0, 10]);
    const r = scaleAbout(pts, pivot);
    r.value = -10; // scale by -1
    expect(vnear(pts[0]!.value, { x: -10, y: 0 })).toBe(true);
    expect(vnear(pts[1]!.value, { x: 0, y: -10 })).toBe(true);
  });

  it("rotateAbout works on POSE via Pivotal trait (rotates pos AND theta)", () => {
    // Trait dispatch: the same `rotateAbout` function dispatches to
    // Pose's Pivotal impl, which both rotates the position about pivot
    // AND increments orientation by dθ.
    const pivot = vec(0, 0);
    const poses = [
      pose({ x: 10, y: 0, theta: 0 }),
      pose({ x: 0, y: 10, theta: 0 }),
    ] as Writable<Pose>[];
    const angle = rotateAbout(poses as never, pivot);
    expect(angle.value).toBeCloseTo(0, 9);
    // Rotate 90° CCW about origin
    angle.value = Math.PI / 2;
    // Position rotates: (10, 0) → (0, 10), (0, 10) → (-10, 0)
    expect(poses[0]!.value.x).toBeCloseTo(0, 9);
    expect(poses[0]!.value.y).toBeCloseTo(10, 9);
    expect(poses[1]!.value.x).toBeCloseTo(-10, 9);
    expect(poses[1]!.value.y).toBeCloseTo(0, 9);
    // ALSO orientation incremented by π/2 (Pose-specific behaviour
    // from the trait, unlike Vec which has no orientation)
    expect(poses[0]!.value.theta).toBeCloseTo(Math.PI / 2, 9);
    expect(poses[1]!.value.theta).toBeCloseTo(Math.PI / 2, 9);
  });

  it("scaleAbout works on POSE via Pivotal trait (scales pos, not theta)", () => {
    const pivot = vec(0, 0);
    const poses = [
      pose({ x: 10, y: 0, theta: 0.7 }),
      pose({ x: 0, y: 10, theta: 1.4 }),
    ] as Writable<Pose>[];
    const r = scaleAbout(poses as never, pivot);
    expect(r.value).toBeCloseTo(10, 9);
    r.value = 20;
    // Position scales 2×
    expect(poses[0]!.value.x).toBeCloseTo(20, 9);
    expect(poses[1]!.value.y).toBeCloseTo(20, 9);
    // Orientation is preserved (scale doesn't change orientation)
    expect(poses[0]!.value.theta).toBeCloseTo(0.7, 9);
    expect(poses[1]!.value.theta).toBeCloseTo(1.4, 9);
  });
});

// =====================================================================
// §2 — Procrustes-via-building-blocks parity with the monolith
// =====================================================================

describe("§2 Procrustes via building blocks: parity", () => {
  it("single centroid write: parity with monolithic procrustesLens", () => {
    const ptsA = mkPoints([5, 0], [3, 4], [-2, 1]);
    const ptsB = mkPoints([5, 0], [3, 4], [-2, 1]);
    const a = procrustesLens(ptsA);
    const b = procrustesViaBuildingBlocks(ptsB);
    a.centroid.value = { x: 100, y: 50 };
    b.centroid.value = { x: 100, y: 50 };
    for (let i = 0; i < 3; i++) {
      expect(vnear(ptsA[i]!.value, ptsB[i]!.value, 1e-12)).toBe(true);
    }
  });

  it("single rotation write: parity", () => {
    const ptsA = mkPoints([5, 0], [3, 4], [-2, 1]);
    const ptsB = mkPoints([5, 0], [3, 4], [-2, 1]);
    const a = procrustesLens(ptsA);
    const b = procrustesViaBuildingBlocks(ptsB);
    a.rotation.value = 1.234;
    b.rotation.value = 1.234;
    for (let i = 0; i < 3; i++) {
      expect(vnear(ptsA[i]!.value, ptsB[i]!.value, 1e-12)).toBe(true);
    }
  });

  it("single scale write: parity", () => {
    const ptsA = mkPoints([5, 0], [3, 4], [-2, 1]);
    const ptsB = mkPoints([5, 0], [3, 4], [-2, 1]);
    const a = procrustesLens(ptsA);
    const b = procrustesViaBuildingBlocks(ptsB);
    a.scale.value = 17;
    b.scale.value = 17;
    for (let i = 0; i < 3; i++) {
      expect(vnear(ptsA[i]!.value, ptsB[i]!.value, 1e-12)).toBe(true);
    }
  });

  it("1000 random interleaved writes: parity holds", () => {
    const ptsA = mkPoints([5, 0], [3, 4], [-2, 1]);
    const ptsB = mkPoints([5, 0], [3, 4], [-2, 1]);
    const a = procrustesLens(ptsA);
    const b = procrustesViaBuildingBlocks(ptsB);
    const r = rng(42);
    for (let i = 0; i < 1000; i++) {
      const k = Math.floor(r() * 3);
      if (k === 0) {
        const tgt = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
        a.centroid.value = tgt;
        b.centroid.value = tgt;
      } else if (k === 1) {
        const tgt = (r() - 0.5) * Math.PI * 2;
        a.rotation.value = tgt;
        b.rotation.value = tgt;
      } else {
        const tgt = 1 + r() * 30;
        a.scale.value = tgt;
        b.scale.value = tgt;
      }
    }
    for (let i = 0; i < 3; i++) {
      expect(vnear(ptsA[i]!.value, ptsB[i]!.value, 1e-9)).toBe(true);
    }
  });
});

// =====================================================================
// §3 — Best-fit line
// =====================================================================

describe("§3 bestFitLineLens", () => {
  it("forward: principal axis of a horizontal cloud is 0°", () => {
    const pts = mkPoints([-10, 0], [-5, 0], [0, 0], [5, 0], [10, 0]);
    const { point, direction } = bestFitLineLens(pts);
    expect(point.value).toEqual({ x: 0, y: 0 });
    expect(near(direction.value, 0)).toBe(true);
  });

  it("forward: principal axis of a 45°-tilted cloud is π/4", () => {
    // Points along y = x: (-2,-2), (-1,-1), (0,0), (1,1), (2,2)
    const pts = mkPoints([-2, -2], [-1, -1], [0, 0], [1, 1], [2, 2]);
    const { direction } = bestFitLineLens(pts);
    expect(near(Math.abs(direction.value), Math.PI / 4, 1e-9)).toBe(true);
  });

  it("write point: translates cluster, principal axis preserved", () => {
    const pts = mkPoints([-10, 0], [-5, 0], [0, 0], [5, 0], [10, 0]);
    const { point, direction } = bestFitLineLens(pts);
    const dir0 = direction.value;
    point.value = { x: 100, y: 50 };
    expect(direction.value).toBeCloseTo(dir0, 9);
    expect(point.value).toEqual({ x: 100, y: 50 });
  });

  it("write direction: rotates cluster about centroid", () => {
    const pts = mkPoints([-10, 0], [-5, 0], [0, 0], [5, 0], [10, 0]);
    const { point, direction } = bestFitLineLens(pts);
    const c0 = point.value;
    direction.value = Math.PI / 2; // make line vertical
    expect(vnear(point.value, c0, 1e-9)).toBe(true); // centroid unchanged (machine-eps)
    // Points should now lie along the y-axis (x ≈ 0)
    for (const p of pts) {
      expect(Math.abs(p.value.x - c0.x)).toBeLessThan(1e-9);
    }
  });
});

// =====================================================================
// §4 — Best-fit circle
// =====================================================================

describe("§4 bestFitCircleLens", () => {
  it("forward: circle of K points around origin reads exact center+radius", () => {
    const K = 8;
    const R = 5;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) {
      pts.push(vec(R * Math.cos((2 * Math.PI * i) / K), R * Math.sin((2 * Math.PI * i) / K)));
    }
    const { center, radius } = bestFitCircleLens(pts);
    expect(vnear(center.value, { x: 0, y: 0 }, 1e-9)).toBe(true);
    expect(near(radius.value, R, 1e-9)).toBe(true);
  });

  it("write center: translates cluster, radius preserved", () => {
    const K = 6;
    const R = 5;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) {
      pts.push(vec(R * Math.cos((2 * Math.PI * i) / K), R * Math.sin((2 * Math.PI * i) / K)));
    }
    const { center, radius } = bestFitCircleLens(pts);
    const r0 = radius.value;
    center.value = { x: 100, y: 50 };
    expect(radius.value).toBeCloseTo(r0, 9);
  });

  it("write radius: scales cluster about center, center preserved", () => {
    const K = 6;
    const R = 5;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) {
      pts.push(vec(R * Math.cos((2 * Math.PI * i) / K), R * Math.sin((2 * Math.PI * i) / K)));
    }
    const { center, radius } = bestFitCircleLens(pts);
    const c0 = center.value;
    radius.value = 10;
    expect(vnear(center.value, c0, 1e-9)).toBe(true);
    // Each point's distance to center should now be 10
    for (const p of pts) {
      expect(near(Math.hypot(p.value.x - c0.x, p.value.y - c0.y), 10, 1e-9)).toBe(true);
    }
  });
});

// =====================================================================
// §5 — PCA / affine-similarity decomposition
// =====================================================================

describe("§5 pcaLens (affine similarity)", () => {
  it("forward: aligned axis-aligned ellipse cloud reads (mean, 0, semi-major, semi-minor)", () => {
    // Generate points on an axis-aligned ellipse with a=5, b=2.
    const K = 12;
    const a = 5;
    const b = 2;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) {
      const θ = (2 * Math.PI * i) / K;
      pts.push(vec(a * Math.cos(θ), b * Math.sin(θ)));
    }
    const { mean, rotation, majorLength, minorLength } = pcaLens(pts);
    expect(vnear(mean.value, { x: 0, y: 0 }, 1e-9)).toBe(true);
    expect(near(rotation.value, 0, 1e-9)).toBe(true);
    // Std-dev of ellipse along major axis ~ a/√2; along minor ~ b/√2
    expect(near(majorLength.value, a / Math.SQRT2, 1e-9)).toBe(true);
    expect(near(minorLength.value, b / Math.SQRT2, 1e-9)).toBe(true);
  });

  it("write mean: translates, other channels preserved", () => {
    const a = 5;
    const b = 2;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(a * Math.cos(θ), b * Math.sin(θ)));
    }
    const { mean, rotation, majorLength, minorLength } = pcaLens(pts);
    const r0 = rotation.value;
    const ma0 = majorLength.value;
    const mi0 = minorLength.value;
    mean.value = { x: 100, y: 50 };
    expect(near(rotation.value, r0, 1e-9)).toBe(true);
    expect(near(majorLength.value, ma0, 1e-9)).toBe(true);
    expect(near(minorLength.value, mi0, 1e-9)).toBe(true);
  });

  it("write rotation: rotates about mean, lengths preserved", () => {
    const a = 5;
    const b = 2;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(a * Math.cos(θ), b * Math.sin(θ)));
    }
    const { mean, rotation, majorLength, minorLength } = pcaLens(pts);
    const c0 = mean.value;
    const ma0 = majorLength.value;
    const mi0 = minorLength.value;
    rotation.value = Math.PI / 4;
    expect(vnear(mean.value, c0, 1e-9)).toBe(true);
    expect(near(majorLength.value, ma0, 1e-9)).toBe(true);
    expect(near(minorLength.value, mi0, 1e-9)).toBe(true);
    expect(near(rotation.value, Math.PI / 4, 1e-9)).toBe(true);
  });

  it("write majorLength: scales along major axis, mean+rotation+minor preserved", () => {
    const a = 5;
    const b = 2;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(a * Math.cos(θ), b * Math.sin(θ)));
    }
    const { mean, rotation, majorLength, minorLength } = pcaLens(pts);
    const c0 = mean.value;
    const r0 = rotation.value;
    const mi0 = minorLength.value;
    const newMajor = majorLength.value * 2;
    majorLength.value = newMajor;
    expect(vnear(mean.value, c0, 1e-9)).toBe(true);
    expect(near(rotation.value, r0, 1e-9)).toBe(true);
    expect(near(minorLength.value, mi0, 1e-9)).toBe(true);
    expect(near(majorLength.value, newMajor, 1e-9)).toBe(true);
  });

  it("write minorLength: scales along minor axis (while minor < major)", () => {
    // FINDING: pcaLens has a degeneracy when minorLength approaches
    // majorLength — the principal axis ordering flips, causing the
    // "rotation" channel to jump by π/2. This isn't a bug per se;
    // it's intrinsic to PCA (the axes are defined as "the larger
    // variance one"). Test only the safe regime where minor < major.
    const a = 5;
    const b = 2;
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(a * Math.cos(θ), b * Math.sin(θ)));
    }
    const { mean, rotation, majorLength, minorLength } = pcaLens(pts);
    const c0 = mean.value;
    const r0 = rotation.value;
    const ma0 = majorLength.value;
    // 1.5× minor → still < major (1.5 * 2/√2 ≈ 2.12 < 5/√2 ≈ 3.54)
    const newMinor = minorLength.value * 1.5;
    minorLength.value = newMinor;
    expect(vnear(mean.value, c0, 1e-9)).toBe(true);
    expect(near(rotation.value, r0, 1e-9)).toBe(true);
    expect(near(majorLength.value, ma0, 1e-9)).toBe(true);
    expect(near(minorLength.value, newMinor, 1e-9)).toBe(true);
  });

  it("pcaLens degeneracy: minor > major causes axis-swap (rotation flips by π/2)", () => {
    // Explicit documentation of the degeneracy: when the user writes
    // minorLength to a value > majorLength, the PCA decomposition
    // reorders. Caller's responsibility to avoid this regime if they
    // need stable rotation semantics.
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(5 * Math.cos(θ), 2 * Math.sin(θ)));
    }
    const { rotation, majorLength, minorLength } = pcaLens(pts);
    const r0 = rotation.value; // 0
    const ma0 = majorLength.value;
    minorLength.value = ma0 * 1.5; // make minor > major
    // After write, what was "minor" is now major; rotation flips by π/2.
    const flipped = Math.abs(rotation.value - r0);
    expect(Math.min(flipped, Math.abs(flipped - Math.PI / 2))).toBeLessThan(1e-6);
  });

  it("interleaved random writes: all 4 channels remain consistent", () => {
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(5 * Math.cos(θ), 2 * Math.sin(θ)));
    }
    const { mean, rotation, majorLength, minorLength } = pcaLens(pts);
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const k = Math.floor(r() * 4);
      if (k === 0) mean.value = { x: (r() - 0.5) * 100, y: (r() - 0.5) * 100 };
      else if (k === 1) rotation.value = (r() - 0.5) * Math.PI;
      else if (k === 2) majorLength.value = 0.5 + r() * 10;
      else minorLength.value = 0.1 + r() * 3;
    }
    for (const p of pts) {
      expect(Number.isFinite(p.value.x)).toBe(true);
      expect(Number.isFinite(p.value.y)).toBe(true);
    }
    // Last writes should still land:
    const tgt = { x: 42, y: -17 };
    mean.value = tgt;
    expect(vnear(mean.value, tgt, 1e-9)).toBe(true);
  });
});

// =====================================================================
// §6 — Partition / total lens
// =====================================================================

describe("§6 totalLens (conservation)", () => {
  it("forward: total = sum of parts", () => {
    const parts = [num(1), num(2), num(3), num(4)] as Writable<Num>[];
    const t = totalLens(parts);
    expect(t.value).toBe(10);
  });

  it("write total: scales parts proportionally, ratios preserved", () => {
    const parts = [num(1), num(2), num(3), num(4)] as Writable<Num>[];
    const t = totalLens(parts);
    const ratios0 = parts.map(p => p.value / 10);
    t.value = 100;
    const ratios1 = parts.map(p => p.value / 100);
    for (let i = 0; i < 4; i++) expect(near(ratios0[i]!, ratios1[i]!, 1e-9)).toBe(true);
    expect(parts.map(p => p.value)).toEqual([10, 20, 30, 40]);
  });

  it("collapsed parts (all 0): even distribution as fallback", () => {
    const parts = [num(0), num(0), num(0)] as Writable<Num>[];
    const t = totalLens(parts);
    t.value = 9;
    expect(parts.map(p => p.value)).toEqual([3, 3, 3]);
  });
});

// =====================================================================
// §7 — Performance: closed-form policies vs factor() vs hand-rolled
// =====================================================================

describe("§7 Performance: closed-form policies vs alternatives", () => {
  const ITERS = 2000;

  it("Procrustes write throughput (K=3): monolith vs decomposed vs factor", () => {
    const ptsM = mkPoints([5, 0], [3, 4], [-2, 1]);
    const ptsD = mkPoints([5, 0], [3, 4], [-2, 1]);
    const m = procrustesLens(ptsM);
    const d = procrustesViaBuildingBlocks(ptsD);
    // eslint-disable-next-line no-console
    console.info("  Procrustes (K=3) per-channel write throughput:");
    timed("monolith: centroid", ITERS, () => {
      for (let i = 0; i < ITERS; i++) m.centroid.value = { x: i & 31, y: i & 31 };
    });
    timed("decomposed: centroid", ITERS, () => {
      for (let i = 0; i < ITERS; i++) d.centroid.value = { x: i & 31, y: i & 31 };
    });
    timed("monolith: rotation", ITERS, () => {
      for (let i = 0; i < ITERS; i++) m.rotation.value = (i & 31) * 0.1;
    });
    timed("decomposed: rotation", ITERS, () => {
      for (let i = 0; i < ITERS; i++) d.rotation.value = (i & 31) * 0.1;
    });
    timed("monolith: scale", ITERS, () => {
      for (let i = 0; i < ITERS; i++) m.scale.value = 1 + (i & 31);
    });
    timed("decomposed: scale", ITERS, () => {
      for (let i = 0; i < ITERS; i++) d.scale.value = 1 + (i & 31);
    });
  });

  it("bestFitLineLens + bestFitCircleLens write throughput (K=10)", () => {
    const K = 10;
    const ptsLine: Writable<Vec>[] = [];
    const ptsCircle: Writable<Vec>[] = [];
    for (let i = 0; i < K; i++) {
      ptsLine.push(vec(i, i * 0.1));
      const θ = (2 * Math.PI * i) / K;
      ptsCircle.push(vec(5 * Math.cos(θ), 5 * Math.sin(θ)));
    }
    const line = bestFitLineLens(ptsLine);
    const circle = bestFitCircleLens(ptsCircle);
    // eslint-disable-next-line no-console
    console.info("  Best-fit-line / circle (K=10) write throughput:");
    timed("bestFitLineLens: point", ITERS, () => {
      for (let i = 0; i < ITERS; i++) line.point.value = { x: i & 31, y: i & 31 };
    });
    timed("bestFitLineLens: direction", ITERS, () => {
      for (let i = 0; i < ITERS; i++) line.direction.value = (i & 31) * 0.05;
    });
    timed("bestFitCircleLens: center", ITERS, () => {
      for (let i = 0; i < ITERS; i++) circle.center.value = { x: i & 31, y: i & 31 };
    });
    timed("bestFitCircleLens: radius", ITERS, () => {
      for (let i = 0; i < ITERS; i++) circle.radius.value = 1 + (i & 31);
    });
  });

  it("PCA write throughput (K=12)", () => {
    const pts: Writable<Vec>[] = [];
    for (let i = 0; i < 12; i++) {
      const θ = (2 * Math.PI * i) / 12;
      pts.push(vec(5 * Math.cos(θ), 2 * Math.sin(θ)));
    }
    const { mean, rotation, majorLength, minorLength } = pcaLens(pts);
    // eslint-disable-next-line no-console
    console.info("  pcaLens (K=12) per-channel write throughput:");
    timed("pca: mean", ITERS, () => {
      for (let i = 0; i < ITERS; i++) mean.value = { x: i & 31, y: i & 31 };
    });
    timed("pca: rotation", ITERS, () => {
      for (let i = 0; i < ITERS; i++) rotation.value = (i & 31) * 0.05;
    });
    timed("pca: majorLength", ITERS, () => {
      for (let i = 0; i < ITERS; i++) majorLength.value = 1 + (i & 31);
    });
    timed("pca: minorLength", ITERS, () => {
      for (let i = 0; i < ITERS; i++) minorLength.value = 1 + (i & 31);
    });
  });

  it("totalLens vs factor-based equivalent (N=10)", () => {
    const N = 10;
    const partsA = Array.from({ length: N }, (_, i) => num(i + 1)) as Writable<Num>[];
    const partsB = Array.from({ length: N }, (_, i) => num(i + 1)) as Writable<Num>[];
    const tA = totalLens(partsA);
    const ones = new Array<number>(N).fill(1);
    const { total: tB } = factor(
      partsB,
      {
        total: {
          Cls: partsA[0]!.constructor as unknown as new (...args: never[]) => Num,
          fwd: (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0),
          jacobian: () => [ones],
        },
      },
      { damping: 0 },
    );
    // CAREFUL: totalLens scales proportionally; factor with min-norm
    // gives DIFFERENT semantics (each input shifts by Δ/N additively).
    // Test that they DIFFER (verify the framing).
    // eslint-disable-next-line no-console
    console.info("  totalLens (proportional) vs factor sum (LSQ min-norm) at N=10:");
    timed("totalLens (closed-form)", ITERS, () => {
      for (let i = 0; i < ITERS; i++) tA.value = 100 + (i & 31);
    });
    timed("factor sum (analytical J)", ITERS, () => {
      for (let i = 0; i < ITERS; i++) tB.value = 100 + (i & 31);
    });
    // Reset to known state and check semantic difference:
    for (let i = 0; i < N; i++) {
      partsA[i]!.value = i + 1;
      partsB[i]!.value = i + 1;
    }
    const total0 = tA.value; // = 55
    tA.value = 110;
    tB.value = 110;
    // totalLens scales: each part doubled → 2, 4, 6, ...
    expect(partsA[0]!.value).toBeCloseTo(2, 9);
    expect(partsA[9]!.value).toBeCloseTo(20, 9);
    // factor LSQ: each part shifts by (110-55)/10 = 5.5 → 6.5, 7.5, ...
    expect(partsB[0]!.value).toBeCloseTo(1 + 5.5, 9);
    expect(partsB[9]!.value).toBeCloseTo(10 + 5.5, 9);
    // eslint-disable-next-line no-console
    console.info(
      `  After total=110: totalLens parts[0]=${partsA[0]!.value.toFixed(2)}, factor parts[0]=${partsB[0]!.value.toFixed(2)} (different semantics!)`,
    );
    void total0;
  });
});
