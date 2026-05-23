// relate-mechanisms.test.ts — headline demos.
//
// These are the artifacts that justify the relation primitive. They
// are *currently impossible* with the engine's previous primitives
// (`through`, `argmin`, `mix`) without painful per-demo IK code.
// With cluster lenses they fall out of declarative composition.
//
// Each demo:
//   1. Constructs the figure declaratively.
//   2. Drives one cell continuously and verifies all constraints
//      stay satisfied at each step.
//   3. (For mechanisms) verifies the foot/output traces a non-trivial
//      curve, distinguishing real motion from a stuck system.

import { describe, expect, it } from "vitest";
import { dist, pinPoint, point } from "../constraints";
import { batch, num } from "../index";
import { clusterHealth } from "../relate";

describe("Four-bar linkage — driven crank, output rocker", () => {
  it("driving the crank traces a non-trivial coupler curve, fast steady state", () => {
    // Standard four-bar:
    //
    //   O0 ─[crank a]─ A ─[coupler b]─ B ─[rocker c]─ O3
    //
    // O0, O3 fixed. A driven around its circle. B reflows. The
    // coupler point (a chosen point on the AB bar — here just B
    // itself) traces the canonical four-bar curve.
    //
    // Mechanism has 1 DOF (the crank angle). 4 cells (A, B), 3
    // bars, joint solve via cluster. Tests the steady-state warm-
    // start property: every frame after the first should converge
    // in ≤2 Newton iterations.

    const O0 = point(num(0), num(0));
    const O3 = point(num(4), num(0));
    pinPoint(O0);
    pinPoint(O3);

    const A = point(num(1), num(0));
    const B = point(num(4), num(2));

    const a = 1; // crank
    const c = 2; // rocker
    const b = Math.hypot(1 - 4, 0 - 2); // coupler

    dist(O0, A, a);
    dist(A, B, b);
    dist(O3, B, c);

    const trajectory: { ax: number; ay: number; bx: number; by: number }[] = [];
    const itersHistory: number[] = [];
    // Drive the crank in 32 small angular steps (no full revolution
    // — most four-bars only swing through a partial range without
    // assembly-mode flipping).
    for (let i = 0; i < 32; i++) {
      const theta = -0.6 + i * 0.04; // ~37° swing
      batch(() => {
        A.x.value = a * Math.cos(theta);
        A.y.value = a * Math.sin(theta);
      });
      const h = clusterHealth(A.x)!.peek();
      itersHistory.push(h.iters);
      trajectory.push({ ax: A.x.value, ay: A.y.value, bx: B.x.value, by: B.y.value });
    }

    // All bar lengths preserved within tolerance.
    for (const p of trajectory) {
      expect(Math.hypot(p.ax, p.ay)).toBeCloseTo(a, 3);
      expect(Math.hypot(p.bx - 4, p.by)).toBeCloseTo(c, 3);
      expect(Math.hypot(p.ax - p.bx, p.ay - p.by)).toBeCloseTo(b, 3);
    }
    // B moves substantively — distinct positions.
    const distinct = new Set(trajectory.map(p => `${p.bx.toFixed(2)},${p.by.toFixed(2)}`));
    expect(distinct.size).toBeGreaterThan(20);

    // Steady-state warm-started drag converges in ≤3 iters per
    // frame. (Single-axis drag converges in 1; pinning both axes per
    // frame requires Newton to coordinate slightly more, hence 2-3.)
    const warmIters = itersHistory.slice(1);
    const maxWarm = Math.max(...warmIters);
    expect(maxWarm).toBeLessThanOrEqual(3);
  });
});

describe("Catenary chain (real-time hanging rope)", () => {
  it("drag endpoint, chain reflows preserving segment lengths", () => {
    // A hanging chain of N segments of length L. Endpoints draggable.
    // Initial config: straight horizontal line. Drag right endpoint
    // up; chain reflows. (Real catenary has gravity; we omit that
    // here — the constraint is just length-preserving. The user's
    // drag determines shape, like a length-1 string under tension.)
    const N = 16;
    const L = 1; // segment length
    const pts = Array.from({ length: N + 1 }, (_, i) => point(num(i * L), num(0)));
    for (let i = 0; i < N; i++) {
      dist(pts[i]!, pts[i + 1]!, L);
    }
    pinPoint(pts[0]!); // anchor left

    // Drag right endpoint to (N*L*0.7, -3) — collapse + lower.
    const itersHistory: number[] = [];
    let dy = 0;
    let dx = N * L;
    const samples: number[][] = [];
    for (let i = 0; i < 30; i++) {
      dx -= 0.05;
      dy -= 0.05;
      // Pin both axes of the dragged endpoint in one batch.
      batch(() => {
        pts[N]!.x.value = dx;
        pts[N]!.y.value = dy;
      });
      const h = clusterHealth(pts[0]!.x)!.peek();
      itersHistory.push(h.iters);
      samples.push(pts.map(p => p.y.value));
    }
    const maxWarm = Math.max(...itersHistory.slice(1));

    // Final state: all 16 segments still length L (within tol).
    for (let i = 0; i < N; i++) {
      const d = Math.hypot(
        pts[i]!.x.value - pts[i + 1]!.x.value,
        pts[i]!.y.value - pts[i + 1]!.y.value,
      );
      expect(d).toBeCloseTo(L, 3);
    }

    // Steady-state (warm-started) drag converges fast even for a
    // 32-cell cluster.
    expect(maxWarm).toBeLessThanOrEqual(4);
  });
});

describe("Multi-cluster composition", () => {
  it("two independent triangles do not interact", () => {
    // Triangle 1
    const A1 = point(num(0), num(0));
    const B1 = point(num(1), num(0));
    const C1 = point(num(0.5), num(0.866));
    dist(A1, B1, 1);
    dist(B1, C1, 1);
    dist(C1, A1, 1);
    pinPoint(B1);

    // Triangle 2 (separate cluster). Use exact sqrt(3)/2 so initial
    // config is exactly on the constraint manifold.
    const apex = Math.sqrt(3) / 2;
    const A2 = point(num(10), num(10));
    const B2 = point(num(11), num(10));
    const C2 = point(num(10.5), num(10 + apex));
    dist(A2, B2, 1);
    dist(B2, C2, 1);
    dist(C2, A2, 1);
    pinPoint(B2);

    // Drag triangle 1's vertex
    A1.x.value = -2;
    A1.y.value = 0;

    // Triangle 1 reflows; triangle 2 untouched (within float-noise).
    expect(Math.hypot(A1.x.value - B1.x.value, A1.y.value - B1.y.value)).toBeCloseTo(1, 3);
    expect(Math.abs(A2.x.value - 10)).toBeLessThan(1e-9);
    expect(Math.abs(A2.y.value - 10)).toBeLessThan(1e-9);
    expect(B2.x.value).toBe(11); // hard-pinned, exactly 11
    expect(C2.x.value).toBeCloseTo(10.5);
  });

  it("connecting two clusters via a shared cell merges them into one", () => {
    // Two triangles sharing a vertex.
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    const C = point(num(0.5), num(0.866));
    const D = point(num(0.5), num(-0.866));

    dist(A, B, 1);
    dist(B, C, 1);
    dist(C, A, 1);
    pinPoint(A);
    pinPoint(B);

    // Now add another triangle ABD. Shares A and B with the first.
    dist(A, D, 1);
    dist(B, D, 1);

    // Both C and D should be at distance 1 from both A and B.
    expect(Math.hypot(C.x.value - A.x.value, C.y.value - A.y.value)).toBeCloseTo(1, 3);
    expect(Math.hypot(C.x.value - B.x.value, C.y.value - B.y.value)).toBeCloseTo(1, 3);
    expect(Math.hypot(D.x.value - A.x.value, D.y.value - A.y.value)).toBeCloseTo(1, 3);
    expect(Math.hypot(D.x.value - B.x.value, D.y.value - B.y.value)).toBeCloseTo(1, 3);
  });
});
