// symmetric-laws.test.ts — law-driven verification for every ported
// symmetric lens. Combines the classical lens laws (GetPut, PutGet,
// PutPut) with the symmetric-specific ones (read stability, recovery
// from singular states, continuity).

import { describe, expect, it } from "vitest";
import { bestFitCircleLens, bestFitLineLens, scaleAbout } from "../lenses/closed-form-policies";
import { spreadOf } from "../lenses/domain-aggregates";
import { bboxLens } from "../lenses/factor-lens";
import { Num } from "../values/num";
import { Vec, vec } from "../values/vec";
import {
  approxNumber,
  approxVec,
  type SourceAndLens,
  verifyContinuity,
  verifyGetPut,
  verifyPutGet,
  verifyPutPut,
  verifyReadStability,
  verifyRecovery,
} from "./_laws";

type V = { x: number; y: number };

// ─── Helpers ───────────────────────────────────────────────────────

// Wrap an array of writable Vecs as a "single source" object the law
// helpers can snapshot/restore. Snapshot returns array clone; "value"
// setter sets each Vec from the array in lockstep.
function vecCluster(initial: readonly V[]): {
  cells: ReturnType<typeof vec>[];
  source: SourceAndLens<V[], unknown>["source"];
} {
  const cells = initial.map(p => vec(p.x, p.y));
  const source = {
    get value(): V[] {
      return cells.map(c => ({ x: c.value.x, y: c.value.y }));
    },
    set value(next: V[]) {
      for (let i = 0; i < cells.length; i++) {
        cells[i]!.value = next[i]!;
      }
    },
    peek(): V[] {
      return cells.map(c => ({ x: c.peek().x, y: c.peek().y }));
    },
  };
  return { cells, source };
}

const approxNum05 = approxNumber(1e-5);
const approxVec05 = approxVec(1e-5);
const approxVecArr = (eps: number) => (a: V[], b: V[]) => {
  if (a.length !== b.length) return false;
  const cmp = approxVec(eps);
  for (let i = 0; i < a.length; i++) if (!cmp(a[i]!, b[i]!)) return false;
  return true;
};
const approxVecArr05 = approxVecArr(1e-5);

// ─── spreadOf laws ─────────────────────────────────────────────────

describe("symmetric spreadOf — lens laws", () => {
  const PTS = [
    { x: 0, y: 3 },
    { x: 0, y: -3 },
    { x: 3, y: 0 },
    { x: -3, y: 0 },
  ];
  const make = (): SourceAndLens<V[], number> => {
    const { cells, source } = vecCluster(PTS);
    return { source, lens: spreadOf(cells as never) };
  };

  it("GetPut: writing back the read is a no-op", () => {
    verifyGetPut(make, { sourceEq: approxVecArr05, trials: 20 });
  });

  it("PutGet: read after write returns what was written", () => {
    verifyPutGet(make, () => 1 + Math.random() * 5, {
      viewEq: approxNum05,
      trials: 20,
    });
  });

  it("PutPut: only the last write survives", () => {
    verifyPutPut(make, () => 0.5 + Math.random() * 4, {
      sourceEq: approxVecArr05,
      trials: 20,
    });
  });

  it("read stability: 5 reads in a row are identical", () => {
    verifyReadStability(make, { viewEq: approxNum05, sourceEq: approxVecArr05, reads: 5 });
  });

  it("recovery: spread → 0 → 7 reinflates to the same shape scaled to mean=7", () => {
    verifyRecovery(
      make,
      0,
      7,
      orig => {
        // Baseline: each point's deviation normalized by the cluster's
        // mean radial distance, then scaled by the target. This is the
        // distribution-preserving semantic — a point at 1.5× the mean
        // radius stays at 1.5× the new mean radius.
        const ctr = { x: 0, y: 0 };
        for (const p of orig) {
          ctr.x += p.x;
          ctr.y += p.y;
        }
        ctr.x /= orig.length;
        ctr.y /= orig.length;
        let sum = 0;
        for (const p of orig) sum += Math.hypot(p.x - ctr.x, p.y - ctr.y);
        const meanR = sum / orig.length;
        const scale = meanR > 0 ? 7 / meanR : 0;
        return orig.map(p => ({
          x: ctr.x + (p.x - ctr.x) * scale,
          y: ctr.y + (p.y - ctr.y) * scale,
        }));
      },
      { sourceEq: approxVecArr05 },
    );
  });

  it("REGRESSION: non-symmetric cluster preserves its distribution under spread writes", () => {
    // A cluster with mixed radial distances. After a spread write,
    // the relative magnitudes (each point's deviation / cluster mean)
    // should be preserved. The OLD bug would force all points onto a
    // ring of radius target around the (drifted) centroid.
    const NONSYM = [
      { x: 5, y: 0 }, // |dev| = 5
      { x: 0, y: 1 }, // |dev| = 1
      { x: -1, y: 0 }, // |dev| = 1
      { x: 0, y: -2 }, // |dev| = 2
    ];
    const { cells, source } = vecCluster(NONSYM);
    const spread = spreadOf(cells as never);
    spread.peek(); // realize complement
    // current centroid = (1, -0.25), |devs| ≈ [4.013, 1.6, 2.01, 2.06],
    // mean ≈ 2.42. Write spread = 2*mean = 4.84 should DOUBLE each
    // deviation about the centroid.
    const ctrBefore = { x: 1, y: -0.25 };
    const meanBefore =
      (Math.hypot(4, 0.25) + Math.hypot(1, 1.25) + Math.hypot(2, 0.25) + Math.hypot(1, 1.75)) / 4;
    spread.value = meanBefore * 2;
    const after = source.peek();
    // Centroid should NOT have moved (scale about centroid preserves it):
    const ctrAfter = {
      x: (after[0]!.x + after[1]!.x + after[2]!.x + after[3]!.x) / 4,
      y: (after[0]!.y + after[1]!.y + after[2]!.y + after[3]!.y) / 4,
    };
    expect(ctrAfter.x).toBeCloseTo(ctrBefore.x, 6);
    expect(ctrAfter.y).toBeCloseTo(ctrBefore.y, 6);
    // Each point's deviation should be exactly 2× original:
    for (let i = 0; i < NONSYM.length; i++) {
      const origDev = { x: NONSYM[i]!.x - ctrBefore.x, y: NONSYM[i]!.y - ctrBefore.y };
      const newDev = { x: after[i]!.x - ctrAfter.x, y: after[i]!.y - ctrAfter.y };
      expect(newDev.x).toBeCloseTo(origDev.x * 2, 6);
      expect(newDev.y).toBeCloseTo(origDev.y * 2, 6);
    }
  });

  it("recovery is stable across cycles: 0→7→0→3 all land correctly", () => {
    const { cells, source } = vecCluster(PTS);
    const spread = spreadOf(cells as never);
    spread.peek(); // realize complement
    const expectShape = (radius: number) => [
      { x: 0, y: radius },
      { x: 0, y: -radius },
      { x: radius, y: 0 },
      { x: -radius, y: 0 },
    ];
    spread.value = 0;
    spread.value = 7;
    expect(approxVecArr05(source.peek(), expectShape(7))).toBe(true);
    spread.value = 0;
    expect(approxVecArr05(source.peek(), expectShape(0))).toBe(true);
    spread.value = 3;
    expect(approxVecArr05(source.peek(), expectShape(3))).toBe(true);
  });
});

// ─── scaleAbout laws ───────────────────────────────────────────────

describe("symmetric scaleAbout — lens laws", () => {
  const PTS = [
    { x: 4, y: 0 },
    { x: 0, y: 4 },
    { x: -4, y: 0 },
  ];
  const PIVOT = vec(0, 0);
  const make = (): SourceAndLens<V[], number> => {
    const { cells, source } = vecCluster(PTS);
    return { source, lens: scaleAbout(cells as never, PIVOT) };
  };

  it("GetPut: writing back the read is a no-op", () => {
    verifyGetPut(make, { sourceEq: approxVecArr05, trials: 20 });
  });

  it("PutGet: read after write returns the written radius", () => {
    verifyPutGet(make, () => 1 + Math.random() * 8, {
      viewEq: approxNum05,
      trials: 20,
    });
  });

  it("PutPut: only the last write survives", () => {
    verifyPutPut(make, () => 0.5 + Math.random() * 6, {
      sourceEq: approxVecArr05,
      trials: 20,
    });
  });

  it("read stability: 5 reads in a row are identical", () => {
    verifyReadStability(make, { viewEq: approxNum05, sourceEq: approxVecArr05, reads: 5 });
  });

  it("recovery: scale → 0 → 5 reinflates to the same shape scaled to 5/4", () => {
    verifyRecovery(
      make,
      0,
      5,
      orig => {
        // Pivot is (0,0). Original |pt0| = 4. Scale factor = 5/4.
        // Each point scales about pivot by that factor.
        const k = 5 / 4;
        return orig.map(p => ({ x: p.x * k, y: p.y * k }));
      },
      { sourceEq: approxVecArr05 },
    );
  });
});

// ─── bestFitCircleLens.radius laws ────────────────────────────────

describe("symmetric bestFitCircleLens.radius — lens laws", () => {
  const PTS = [
    { x: 5, y: 0 },
    { x: 0, y: 5 },
    { x: -5, y: 0 },
    { x: 0, y: -5 },
  ];
  const make = (): SourceAndLens<V[], number> => {
    const { cells, source } = vecCluster(PTS);
    const { radius } = bestFitCircleLens(cells as never);
    return { source, lens: radius };
  };

  it("GetPut", () => {
    verifyGetPut(make, { sourceEq: approxVecArr05, trials: 20 });
  });

  it("PutGet", () => {
    verifyPutGet(make, () => 1 + Math.random() * 8, {
      viewEq: approxNum05,
      trials: 20,
    });
  });

  it("PutPut", () => {
    verifyPutPut(make, () => 0.5 + Math.random() * 6, {
      sourceEq: approxVecArr05,
      trials: 20,
    });
  });

  it("read stability", () => {
    verifyReadStability(make, { viewEq: approxNum05, sourceEq: approxVecArr05, reads: 5 });
  });

  it("recovery: radius → 0 → 7 reinflates to a circle of radius 7", () => {
    verifyRecovery(
      make,
      0,
      7,
      _orig => [
        { x: 7, y: 0 },
        { x: 0, y: 7 },
        { x: -7, y: 0 },
        { x: 0, y: -7 },
      ],
      { sourceEq: approxVecArr05 },
    );
  });

  it("REGRESSION: non-symmetric cluster preserves its shape under radius writes", () => {
    // Points at varying distances. A radius write should scale them
    // uniformly about the centroid — preserving relative distribution.
    const NONSYM = [
      { x: 3, y: 0 }, // dist from origin = 3
      { x: 0, y: 8 }, // dist = 8
      { x: -1, y: 0 }, // dist = 1
      { x: 0, y: -4 }, // dist = 4
    ];
    const { cells, source } = vecCluster(NONSYM);
    const { radius } = bestFitCircleLens(cells as never);
    radius.peek();
    const ctrBefore = { x: 0.5, y: 1 };
    const meanBefore =
      (Math.hypot(2.5, 1) + Math.hypot(0.5, 7) + Math.hypot(1.5, 1) + Math.hypot(0.5, 5)) / 4;
    radius.value = meanBefore * 3;
    const after = source.peek();
    // Centroid stable under uniform scale about centroid:
    const ctrAfter = {
      x: (after[0]!.x + after[1]!.x + after[2]!.x + after[3]!.x) / 4,
      y: (after[0]!.y + after[1]!.y + after[2]!.y + after[3]!.y) / 4,
    };
    expect(ctrAfter.x).toBeCloseTo(ctrBefore.x, 6);
    expect(ctrAfter.y).toBeCloseTo(ctrBefore.y, 6);
    // Each deviation × 3:
    for (let i = 0; i < NONSYM.length; i++) {
      const dx = NONSYM[i]!.x - ctrBefore.x;
      const dy = NONSYM[i]!.y - ctrBefore.y;
      expect(after[i]!.x - ctrAfter.x).toBeCloseTo(dx * 3, 6);
      expect(after[i]!.y - ctrAfter.y).toBeCloseTo(dy * 3, 6);
    }
  });
});

// ─── bestFitLineLens.direction laws (the gauge-fix case) ──────────

describe("symmetric bestFitLineLens.direction — lens laws", () => {
  // A clearly-elongated cluster along the x-axis.
  const PTS = [
    { x: -3, y: 0 },
    { x: -1, y: 0.1 },
    { x: 1, y: -0.1 },
    { x: 3, y: 0 },
  ];
  const make = (): SourceAndLens<V[], number> => {
    const { cells, source } = vecCluster(PTS);
    const { direction } = bestFitLineLens(cells as never);
    return { source, lens: direction };
  };

  // A line is invariant under (pt) ↔ (−pt) (axis-equivalence). Equality
  // for sources of this lens has to respect that gauge orbit, else
  // tests like PutPut spuriously fail when two equivalent-but-mirrored
  // landings happen.
  const approxVecArrAxis = (a: V[], b: V[]) => {
    if (a.length !== b.length) return false;
    if (approxVecArr05(a, b)) return true;
    return approxVecArr05(
      a,
      b.map(p => ({ x: -p.x, y: -p.y })),
    );
  };

  it("GetPut", () => {
    verifyGetPut(make, { sourceEq: approxVecArrAxis, trials: 20 });
  });

  it("PutGet: writing a target angle reads back as that angle", () => {
    verifyPutGet(make, () => -Math.PI / 2 + Math.random() * Math.PI, {
      viewEq: approxNum05,
      trials: 20,
    });
  });

  it("PutPut (modulo axis ambiguity)", () => {
    verifyPutPut(make, () => -Math.PI + Math.random() * 2 * Math.PI, {
      sourceEq: approxVecArrAxis,
      trials: 20,
    });
  });

  it("read stability", () => {
    verifyReadStability(make, { viewEq: approxNum05, sourceEq: approxVecArrAxis, reads: 5 });
  });

  it("CONTINUITY (the jitter-killing law): no π jumps as cluster rotates", () => {
    // Make the cluster (the source) rotate slowly about its centroid;
    // the direction angle should monotonically change, never jumping
    // by ~π (which is what the old eigenvector-sign flip produced).
    const { cells, source } = vecCluster(PTS);
    const { direction } = bestFitLineLens(cells as never);
    direction.peek();

    let prev = direction.peek();
    let maxJump = 0;
    for (let i = 1; i <= 90; i++) {
      // Rotate every point by 4° about origin (≈ centroid).
      const dθ = (4 * Math.PI) / 180;
      const cur = source.peek();
      const rotated = cur.map(p => ({
        x: p.x * Math.cos(dθ) - p.y * Math.sin(dθ),
        y: p.x * Math.sin(dθ) + p.y * Math.cos(dθ),
      }));
      source.value = rotated;
      const next = direction.peek();
      const jump = Math.abs(next - prev);
      if (jump > maxJump) maxJump = jump;
      prev = next;
    }
    // 4° per step ≈ 0.07 rad. Allow some slack. The OLD lens would
    // produce occasional jumps of ~π (3.14 rad) at the sign-flip.
    expect(maxJump).toBeLessThan(0.5);
  });

  it("continuity through small noise: tiny perturbations → tiny changes", () => {
    const { cells, source } = vecCluster(PTS);
    const { direction } = bestFitLineLens(cells as never);
    direction.peek();

    verifyContinuity(
      make,
      (_i, src) => {
        const cur = src.peek();
        src.value = cur.map(p => ({
          x: p.x + (Math.random() - 0.5) * 0.05,
          y: p.y + (Math.random() - 0.5) * 0.05,
        }));
      },
      (a, b) => Math.abs(a - b),
      0.5,
      60,
    );
    void source;
    void direction;
  });
});

// ─── bboxLens.size laws ───────────────────────────────────────────

describe("symmetric bboxLens.size — lens laws", () => {
  const PTS = [
    { x: -2, y: -1 },
    { x: 2, y: 1 },
    { x: 0, y: 0.5 },
    { x: -1, y: -0.5 },
  ];
  const make = (): SourceAndLens<V[], V> => {
    const { cells, source } = vecCluster(PTS);
    const { size } = bboxLens(cells as never);
    return { source, lens: size };
  };

  it("GetPut", () => {
    verifyGetPut(make, { sourceEq: approxVecArr05, trials: 20 });
  });

  it("PutGet: writing {x, y} reads back as that size", () => {
    verifyPutGet(make, () => ({ x: 0.5 + Math.random() * 5, y: 0.5 + Math.random() * 5 }), {
      viewEq: approxVec05,
      trials: 20,
    });
  });

  it("PutPut", () => {
    verifyPutPut(make, () => ({ x: 0.5 + Math.random() * 5, y: 0.5 + Math.random() * 5 }), {
      sourceEq: approxVecArr05,
      trials: 20,
    });
  });

  it("read stability", () => {
    verifyReadStability(make, { viewEq: approxVec05, sourceEq: approxVecArr05, reads: 5 });
  });

  it("recovery: size → (0, 0) → (8, 6) reinflates from the stored fractions", () => {
    // Original bbox: cx = 0, cy = 0, sx = 4, sy = 2. Fractions:
    //   (-2,-1) → (-1, -1)
    //   ( 2, 1) → ( 1,  1)
    //   ( 0,0.5) → ( 0,  0.5)
    //   (-1,-.5) → (-0.5, -0.5)
    // After write size = (8, 6), half-size = (4, 3), and centre stays
    // at (0, 0):
    //   (-1,-1)   × (4, 3) = (-4, -3)
    //   ( 1, 1)   × (4, 3) = ( 4,  3)
    //   ( 0, 0.5) × (4, 3) = ( 0,  1.5)
    //   (-0.5,-0.5) × (4, 3) = (-2, -1.5)
    verifyRecovery(
      make,
      { x: 0, y: 0 },
      { x: 8, y: 6 },
      _orig => [
        { x: -4, y: -3 },
        { x: 4, y: 3 },
        { x: 0, y: 1.5 },
        { x: -2, y: -1.5 },
      ],
      { sourceEq: approxVecArr05 },
    );
  });

  it("recovery on a single axis: collapse on y only is reinflated", () => {
    // Write size = (4, 0): all y's collapse to centre, but x positions
    // and stored y-fractions survive. Then write size = (4, 8): y's
    // come back proportional to their stored fractions × 4.
    const { cells, source } = vecCluster(PTS);
    const { size } = bboxLens(cells as never);
    size.peek();
    size.value = { x: 4, y: 0 };
    size.value = { x: 4, y: 8 };
    // Same x-coords as original (cx=0, sx=4, fractions ×4 = original x);
    // y-coords scaled to half-size 4 from fractions {-1, 1, 0.5, -0.5}.
    expect(
      approxVecArr05(source.peek(), [
        { x: -2, y: -4 },
        { x: 2, y: 4 },
        { x: 0, y: 2 },
        { x: -1, y: -2 },
      ]),
    ).toBe(true);
  });
});

// ─── Lens-of-lens composition (chain a plain .scale on top) ───────

describe("symmetric × plain .scale composition: no eps amplification", () => {
  it("spread.scale(1000) at spread=0 is exactly 0", () => {
    const { cells } = vecCluster([
      { x: 0, y: 3 },
      { x: 0, y: -3 },
    ]);
    const spread = spreadOf(cells as never);
    const big = spread.scale(1000);
    spread.peek();
    spread.value = 0;
    expect(big.value).toBe(0);
  });

  it("radius.scale(1000) at radius=0 is exactly 0", () => {
    const { cells } = vecCluster([
      { x: 5, y: 0 },
      { x: 0, y: 5 },
    ]);
    const { radius } = bestFitCircleLens(cells as never);
    const big = radius.scale(1000);
    radius.peek();
    radius.value = 0;
    expect(big.value).toBe(0);
  });

  it("scaleAbout(...).scale(1000) at scale=0 is exactly 0", () => {
    const { cells } = vecCluster([
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ]);
    const pivot = vec(0, 0);
    const s = scaleAbout(cells as never, pivot);
    const big = s.scale(1000);
    s.peek();
    s.value = 0;
    expect(big.value).toBe(0);
  });

  // Touch unused imports to satisfy strict TS in test files.
  void Num;
  void Vec;
});
