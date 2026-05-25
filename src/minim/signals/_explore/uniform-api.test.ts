// =====================================================================
// uniform-api.test.ts — tests for the cluster facade + new-domain
// closed-form aggregates.
//
// Sections:
//   §1 cluster facade: lazy property pattern, semantics parity
//   §2 trait-driven aggregates: meanOf works for Vec/Num/Color
//   §3 bezier gestalt: 4-handle curve shaping
//   §4 color palette: meanColor + spread decomposition
//   §5 time series: mean + slope decomposition
//   §6 perf: facade overhead, new-domain primitives
// =====================================================================

import { describe, expect, it } from "vitest";
import { Color, Num, num, rgba, signal, Vec, vec } from "../index";
import type { Writable } from "../index";
import { procrustesLens } from "./factor-lens";
import { cluster } from "./cluster";
import {
  bezierGestalt,
  meanColor,
  meanOf,
  palette,
  timeSeries,
} from "./domain-aggregates";

const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) < tol;
const vnear = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  tol = 1e-9,
): boolean => near(a.x, b.x, tol) && near(a.y, b.y, tol);

const mkPoints = (...pts: [number, number][]): Writable<Vec>[] => pts.map(([x, y]) => vec(x, y));

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
// §1 — Cluster facade
// =====================================================================

describe("§1 cluster facade", () => {
  it("exposes every aggregate via lazy properties", () => {
    const pts = mkPoints([0, 0], [10, 0], [5, 7]);
    const c = cluster(pts);

    // Read every entry — verifies construction succeeds for all.
    expect(c.centroid.value.x).toBeCloseTo(5, 9);
    expect(c.centroid.value.y).toBeCloseTo(7 / 3, 9);
    expect(c.rotation.value).toBeCloseTo(Math.atan2(-7 / 3, -5), 9);
    expect(typeof c.scale.value).toBe("number");
    expect(c.bbox.center.value).toEqual({ x: 5, y: 3.5 });
    expect(c.bbox.size.value).toEqual({ x: 10, y: 7 });
    expect(vnear(c.bestFitLine.point.value, c.centroid.value, 1e-12)).toBe(true);
    expect(vnear(c.bestFitCircle.center.value, c.centroid.value, 1e-12)).toBe(true);
    expect(vnear(c.pca.mean.value, c.centroid.value, 1e-12)).toBe(true);
    expect(vnear(c.procrustes.centroid.value, c.centroid.value, 1e-12)).toBe(true);
  });

  it("properties are memoised (same instance on repeat access)", () => {
    const pts = mkPoints([0, 0], [10, 0], [5, 7]);
    const c = cluster(pts);
    expect(c.centroid).toBe(c.centroid);
    expect(c.rotation).toBe(c.rotation);
    expect(c.bbox).toBe(c.bbox);
    expect(c.pca).toBe(c.pca);
  });

  it("writes through facade match writes through underlying primitives", () => {
    const ptsA = mkPoints([5, 0], [3, 4], [-2, 1]);
    const ptsB = mkPoints([5, 0], [3, 4], [-2, 1]);
    const cA = cluster(ptsA);
    const pB = procrustesLens(ptsB);

    cA.centroid.value = { x: 100, y: 50 };
    pB.centroid.value = { x: 100, y: 50 };
    for (let i = 0; i < 3; i++) {
      expect(vnear(ptsA[i]!.value, ptsB[i]!.value, 1e-12)).toBe(true);
    }
    cA.rotation.value = 1.234;
    pB.rotation.value = 1.234;
    for (let i = 0; i < 3; i++) {
      expect(vnear(ptsA[i]!.value, ptsB[i]!.value, 1e-12)).toBe(true);
    }
  });

  it("custom pivot: rotation preserves distance from pivot", () => {
    // Setting rotation.value = θ means "point[0] is now at angle θ from
    // pivot, distance preserved". Verify the distance invariant.
    const pts = mkPoints([10, 0], [0, 10], [-10, 0], [0, -10]);
    const pivot = vec(5, 5);
    const c = cluster(pts, pivot);
    // Compute distance from pivot to each point (= invariant under rotation)
    const pv = pivot.value;
    const dists0 = pts.map(p => Math.hypot(p.value.x - pv.x, p.value.y - pv.y));
    c.rotation.value = Math.PI;
    const dists1 = pts.map(p => Math.hypot(p.value.x - pv.x, p.value.y - pv.y));
    for (let i = 0; i < 4; i++) {
      expect(dists1[i]!).toBeCloseTo(dists0[i]!, 9);
    }
    // point[0] is now at angle π from pivot
    expect(Math.atan2(pts[0]!.value.y - pv.y, pts[0]!.value.x - pv.x)).toBeCloseTo(Math.PI, 9);
  });
});

// =====================================================================
// §2 — Trait-driven aggregates (Linear)
// =====================================================================

describe("§2 trait-driven meanOf works across types", () => {
  it("meanOf for Num", () => {
    const m = meanOf([num(2), num(4), num(6)] as Writable<Num>[]);
    expect(m.value).toBe(4);
    m.value = 10;
    // Should propagate as a rigid shift: each input += 6
    // (each was at 2/4/6, now 8/10/12; mean = 10)
  });

  it("meanOf for Vec", () => {
    const m = meanOf([vec(0, 0), vec(10, 0), vec(5, 6)] as Writable<Vec>[]);
    expect(m.value).toEqual({ x: 5, y: 2 });
  });

  it("meanOf for Color — the same engine works on a 4-channel type", () => {
    const c1 = rgba(1, 0, 0, 1); // red
    const c2 = rgba(0, 1, 0, 1); // green
    const c3 = rgba(0, 0, 1, 1); // blue
    const m = meanOf([c1, c2, c3] as never);
    const v = m.value as { r: number; g: number; b: number; a: number };
    expect(v.r).toBeCloseTo(1 / 3, 9);
    expect(v.g).toBeCloseTo(1 / 3, 9);
    expect(v.b).toBeCloseTo(1 / 3, 9);
    expect(v.a).toBeCloseTo(1, 9);
  });

  it("meanOf for Color: writes propagate via rigid translate in RGBA", () => {
    const c1 = rgba(0.5, 0.5, 0.5, 1);
    const c2 = rgba(0.5, 0.5, 0.5, 1);
    const m = meanOf([c1, c2] as never) as Writable<Color>;
    (m as unknown as { value: { r: number; g: number; b: number; a: number } }).value = {
      r: 0.8,
      g: 0.5,
      b: 0.5,
      a: 1,
    };
    // Both colors shift by (+0.3, 0, 0, 0)
    expect(c1.value.r).toBeCloseTo(0.8, 9);
    expect(c2.value.r).toBeCloseTo(0.8, 9);
  });
});

// =====================================================================
// §3 — Bezier gestalt
// =====================================================================

describe("§3 bezierGestalt", () => {
  it("forward: start = p0, end = p3, tangents are differences", () => {
    const p0 = vec(0, 0);
    const p1 = vec(10, 5);
    const p2 = vec(20, 5);
    const p3 = vec(30, 0);
    const { start, end, startTangent, endTangent } = bezierGestalt(p0, p1, p2, p3);
    expect(start.value).toEqual({ x: 0, y: 0 });
    expect(end.value).toEqual({ x: 30, y: 0 });
    expect(startTangent.value).toEqual({ x: 10, y: 5 });
    expect(endTangent.value).toEqual({ x: 10, y: -5 });
  });

  it("write start: p0 translates, p1 follows (startTangent preserved)", () => {
    const p0 = vec(0, 0);
    const p1 = vec(10, 5);
    const p2 = vec(20, 5);
    const p3 = vec(30, 0);
    const { start, startTangent } = bezierGestalt(p0, p1, p2, p3);
    const tan0 = startTangent.value;
    start.value = { x: 100, y: 100 };
    expect(p0.value).toEqual({ x: 100, y: 100 });
    expect(p1.value).toEqual({ x: 110, y: 105 });
    expect(startTangent.value).toEqual(tan0);
  });

  it("write end: p3 translates, p2 follows (endTangent preserved)", () => {
    const p0 = vec(0, 0);
    const p1 = vec(10, 5);
    const p2 = vec(20, 5);
    const p3 = vec(30, 0);
    const { end, endTangent } = bezierGestalt(p0, p1, p2, p3);
    const tan0 = endTangent.value;
    end.value = { x: 200, y: 200 };
    expect(p3.value).toEqual({ x: 200, y: 200 });
    expect(p2.value).toEqual({ x: 190, y: 205 });
    expect(endTangent.value).toEqual(tan0);
  });

  it("write startTangent: only p1 moves (p0, p2, p3 untouched)", () => {
    const p0 = vec(0, 0);
    const p1 = vec(10, 5);
    const p2 = vec(20, 5);
    const p3 = vec(30, 0);
    const { startTangent } = bezierGestalt(p0, p1, p2, p3);
    startTangent.value = { x: 20, y: 30 };
    expect(p0.value).toEqual({ x: 0, y: 0 });
    expect(p1.value).toEqual({ x: 20, y: 30 });
    expect(p2.value).toEqual({ x: 20, y: 5 });
    expect(p3.value).toEqual({ x: 30, y: 0 });
  });

  it("write endTangent: only p2 moves", () => {
    const p0 = vec(0, 0);
    const p1 = vec(10, 5);
    const p2 = vec(20, 5);
    const p3 = vec(30, 0);
    const { endTangent } = bezierGestalt(p0, p1, p2, p3);
    endTangent.value = { x: 15, y: -8 };
    expect(p0.value).toEqual({ x: 0, y: 0 });
    expect(p1.value).toEqual({ x: 10, y: 5 });
    expect(p2.value).toEqual({ x: 15, y: 8 });
    expect(p3.value).toEqual({ x: 30, y: 0 });
  });

  it("cross-handle invariance: writing any handle preserves the other 3 reads", () => {
    const p0 = vec(0, 0);
    const p1 = vec(10, 5);
    const p2 = vec(20, 5);
    const p3 = vec(30, 0);
    const { start, end, startTangent, endTangent } = bezierGestalt(p0, p1, p2, p3);

    // Snapshot all 4
    const s0 = start.value;
    const e0 = end.value;
    const st0 = startTangent.value;
    const et0 = endTangent.value;

    // Write start → start changes, others stay
    start.value = { x: 50, y: 50 };
    expect(start.value).toEqual({ x: 50, y: 50 });
    expect(end.value).toEqual(e0);
    expect(startTangent.value).toEqual(st0);
    expect(endTangent.value).toEqual(et0);

    // Reset state
    p0.value = { x: 0, y: 0 };
    p1.value = { x: 10, y: 5 };
    p2.value = { x: 20, y: 5 };
    p3.value = { x: 30, y: 0 };

    // Write end → end changes, others stay
    end.value = { x: 200, y: 100 };
    expect(start.value).toEqual(s0);
    expect(startTangent.value).toEqual(st0);
    expect(endTangent.value).toEqual(et0);
    expect(end.value).toEqual({ x: 200, y: 100 });
  });
});

// =====================================================================
// §4 — Color palette
// =====================================================================

describe("§4 color palette aggregates", () => {
  it("meanColor: forward + write", () => {
    const c1 = rgba(1, 0, 0, 1);
    const c2 = rgba(0, 1, 0, 1);
    const m = meanColor([c1, c2] as never) as unknown as Writable<Color>;
    expect(m.value.r).toBeCloseTo(0.5, 9);
    expect(m.value.g).toBeCloseTo(0.5, 9);
    // Write target: shift both colors by the delta
    (m as unknown as { value: { r: number; g: number; b: number; a: number } }).value = {
      r: 1, g: 1, b: 0, a: 1,
    };
    expect(c1.value.r).toBeCloseTo(1.5, 9); // (1,0,0,1) + (0.5, 0.5, 0, 0)
    expect(c2.value.r).toBeCloseTo(0.5, 9); // (0,1,0,1) + (0.5, 0.5, 0, 0)
  });

  it("palette: mean and spread are cross-channel invariant", () => {
    const c1 = rgba(0.2, 0.2, 0.2, 1);
    const c2 = rgba(0.4, 0.4, 0.4, 1);
    const c3 = rgba(0.6, 0.6, 0.6, 1);
    const { mean, spread } = palette([c1, c2, c3] as never);

    const s0 = spread.value;
    (mean as unknown as { value: { r: number; g: number; b: number; a: number } }).value = {
      r: 0.8, g: 0.5, b: 0.5, a: 1,
    };
    // Mean changed; spread preserved (rigid translate doesn't change spread)
    expect(spread.value).toBeCloseTo(s0, 9);

    const m1 = (mean.value as { r: number });
    spread.value = s0 * 0;
    // All collapsed to mean
    expect(c1.value.r).toBeCloseTo(m1.r, 9);
    expect(c2.value.r).toBeCloseTo(m1.r, 9);
    expect(c3.value.r).toBeCloseTo(m1.r, 9);
  });

  it("palette is trait-generic: works on Vec inputs too (same engine)", () => {
    // Verify the trait refactor: `palette` is now Linear+Metric-generic.
    // The same function that works on Color works on Vec — and would
    // work on any user-defined value class that declares the two traits.
    const vs = [vec(0, 0), vec(10, 0), vec(0, 10), vec(10, 10)];
    const { mean, spread } = palette(vs as never);
    expect(vnear(mean.value as { x: number; y: number }, { x: 5, y: 5 }, 1e-9)).toBe(true);
    expect(spread.value).toBeGreaterThan(0);

    const s0 = spread.value;
    // Writing mean translates all vecs by delta; spread preserved.
    (mean as unknown as { value: { x: number; y: number } }).value = { x: 100, y: 50 };
    expect(spread.value).toBeCloseTo(s0, 9);

    // Writing spread = 0 collapses all to mean.
    spread.value = 0;
    for (const v of vs) {
      expect(v.value.x).toBeCloseTo(100, 9);
      expect(v.value.y).toBeCloseTo(50, 9);
    }
  });
});

// =====================================================================
// §5 — Time series
// =====================================================================

describe("§5 timeSeries (1-D Linear aggregate)", () => {
  it("forward: mean and slope of a straight line", () => {
    // Values 0, 1, 2, 3, 4 — slope 1, mean 2
    const values: Writable<Num>[] = [];
    for (let i = 0; i < 5; i++) values.push(num(i));
    const { mean, slope } = timeSeries(values);
    expect(mean.value).toBe(2);
    expect(slope.value).toBeCloseTo(1, 9);
  });

  it("write mean: rigid translate of the series, slope preserved", () => {
    const values: Writable<Num>[] = [];
    for (let i = 0; i < 5; i++) values.push(num(i));
    const { mean, slope } = timeSeries(values);
    const s0 = slope.value;
    mean.value = 100;
    expect(slope.value).toBeCloseTo(s0, 9);
    // Each value should have shifted by +98 (mean was 2, now 100)
    for (let i = 0; i < 5; i++) {
      expect(values[i]!.value).toBeCloseTo(i + 98, 9);
    }
  });

  it("write slope: tilts about mean, mean preserved", () => {
    const values: Writable<Num>[] = [];
    for (let i = 0; i < 5; i++) values.push(num(i));
    const { mean, slope } = timeSeries(values);
    const m0 = mean.value;
    slope.value = 0.5;
    expect(mean.value).toBeCloseTo(m0, 9);
    expect(slope.value).toBeCloseTo(0.5, 9);
    // Series should now be (2 + (i - 2) * 0.5) = 1, 1.5, 2, 2.5, 3
    expect(values[0]!.value).toBeCloseTo(1, 9);
    expect(values[2]!.value).toBeCloseTo(2, 9);
    expect(values[4]!.value).toBeCloseTo(3, 9);
  });

  it("write slope = 0: flattens the series at its mean", () => {
    const values: Writable<Num>[] = [];
    for (let i = 0; i < 5; i++) values.push(num(i));
    const { mean, slope } = timeSeries(values);
    slope.value = 0;
    for (let i = 0; i < 5; i++) {
      expect(values[i]!.value).toBeCloseTo(2, 9);
    }
    expect(mean.value).toBeCloseTo(2, 9);
  });
});

// =====================================================================
// §6 — Performance
// =====================================================================

describe("§6 perf: facade overhead + new-domain primitives", () => {
  const ITERS = 2000;

  it("cluster facade: write throughput vs direct primitive (K=3)", () => {
    const ptsA = mkPoints([5, 0], [3, 4], [-2, 1]);
    const ptsB = mkPoints([5, 0], [3, 4], [-2, 1]);
    const c = cluster(ptsA);
    const p = procrustesLens(ptsB);
    // eslint-disable-next-line no-console
    console.info("  cluster facade vs direct procrustesLens (K=3):");
    timed("cluster.centroid write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) c.centroid.value = { x: i & 31, y: i & 31 };
    });
    timed("procrustesLens.centroid write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) p.centroid.value = { x: i & 31, y: i & 31 };
    });
    timed("cluster.rotation write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) c.rotation.value = (i & 31) * 0.1;
    });
    timed("procrustesLens.rotation write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) p.rotation.value = (i & 31) * 0.1;
    });
  });

  it("color palette: meanColor + spread write throughput (K=4)", () => {
    const cs = [
      rgba(0.1, 0.2, 0.3, 1),
      rgba(0.4, 0.5, 0.6, 1),
      rgba(0.7, 0.8, 0.9, 1),
      rgba(0.2, 0.4, 0.6, 1),
    ];
    const { mean, spread } = palette(cs as never);
    // eslint-disable-next-line no-console
    console.info("  color palette (K=4):");
    timed("palette.mean write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) {
        (mean as unknown as { value: { r: number; g: number; b: number; a: number } }).value = {
          r: (i & 7) / 8, g: 0.5, b: 0.5, a: 1,
        };
      }
    });
    timed("palette.spread write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) spread.value = 0.1 + (i & 31) * 0.01;
    });
  });

  it("bezierGestalt write throughput", () => {
    const p0 = vec(0, 0);
    const p1 = vec(10, 5);
    const p2 = vec(20, 5);
    const p3 = vec(30, 0);
    const { start, startTangent } = bezierGestalt(p0, p1, p2, p3);
    // eslint-disable-next-line no-console
    console.info("  bezierGestalt:");
    timed("start write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) start.value = { x: i & 31, y: i & 31 };
    });
    timed("startTangent write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) startTangent.value = { x: 5 + (i & 7), y: 5 + (i & 7) };
    });
  });

  it("timeSeries write throughput (N=10)", () => {
    const values: Writable<Num>[] = [];
    for (let i = 0; i < 10; i++) values.push(num(i));
    const { mean, slope } = timeSeries(values);
    // eslint-disable-next-line no-console
    console.info("  timeSeries (N=10):");
    timed("mean write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) mean.value = i & 31;
    });
    timed("slope write", ITERS, () => {
      for (let i = 0; i < ITERS; i++) slope.value = (i & 31) * 0.01;
    });
  });
});
