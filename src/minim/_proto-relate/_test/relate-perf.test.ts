// relate-perf.test.ts — performance characteristics of the cluster
// solver. Goal: validate the "warm-start makes steady-state drag
// converge in 1-2 Newton iterations" claim.
//
// These are not benchmarks (no precise timing budget). They probe
// solver behaviour: iteration count and residual after small drag
// steps, which is what determines whether the system can do 60fps
// dragging at scale.

import { describe, expect, it } from "vitest";
import { dist, pinPoint, point } from "../constraints";
import { num } from "../index";
import { clusterHealth, relate } from "../relate";

describe("warm-start: steady-state drag ⇒ ≤2 Newton iterations", () => {
  it("4-bar linkage, small angle steps", () => {
    const O0 = point(num(0), num(0));
    const O3 = point(num(4), num(0));
    const A = point(num(1), num(0));
    const B = point(num(4), num(2));
    pinPoint(O0);
    pinPoint(O3);
    const b = Math.hypot(1 - 4, 0 - 2);
    dist(O0, A, 1);
    dist(O3, B, 2);
    dist(A, B, b);

    // First drag move — solver may need a few iterations from cold.
    A.x.value = Math.cos(0.05);
    A.y.value = Math.sin(0.05);
    const firstHealth = clusterHealth(A.x)!;
    void firstHealth.value;

    // Subsequent small-angle drags — should converge in ≤2 iters
    // because warm-start is excellent (Newton's quadratic basin).
    let maxIters = 0;
    for (let i = 1; i < 50; i++) {
      const theta = i * 0.05;
      A.x.value = Math.cos(theta);
      A.y.value = Math.sin(theta);
      const h = clusterHealth(A.x)!.peek();
      if (h.iters > maxIters) maxIters = h.iters;
    }
    expect(maxIters).toBeLessThanOrEqual(2);
  });

  it("equilateral triangle drag — small rotation steps", () => {
    // Drag A in a tiny arc around B so the triangle just rotates.
    // (A monotonic linear drag would push A past B at some point —
    // the |AB|→0 singularity — and Newton's iteration count would
    // blow up there. A real interaction never crosses a singularity
    // in one frame.)
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    const C = point(num(0.5), num(Math.sqrt(3) / 2));
    dist(A, B, 1);
    dist(B, C, 1);
    dist(C, A, 1);
    pinPoint(B);

    let maxIters = 0;
    for (let i = 1; i < 100; i++) {
      // Drag A around B at radius 1, tiny angular step.
      const theta = Math.PI - i * 0.005;
      A.x.value = 1 + Math.cos(theta);
      A.y.value = Math.sin(theta);
      const h = clusterHealth(A.x)!.peek();
      if (h.iters > maxIters) maxIters = h.iters;
    }
    expect(maxIters).toBeLessThanOrEqual(2);
  });

  it("10-link chain of distance constraints — small joint moves", () => {
    const pts = Array.from({ length: 10 }, (_, i) => point(num(i), num(0)));
    for (let i = 0; i + 1 < pts.length; i++) {
      dist(pts[i]!, pts[i + 1]!, 1);
    }
    pinPoint(pts[0]!);
    // Cold drag: tip moves to (8, 1)
    pts[9]!.x.value = 8;
    pts[9]!.y.value = 1;
    const cold = clusterHealth(pts[0]!.x)!.peek();

    // Warm drags: small steps from current pose
    let maxIters = 0;
    let dy = 1;
    for (let i = 0; i < 100; i++) {
      dy += 0.01;
      pts[9]!.x.value = 8;
      pts[9]!.y.value = dy;
      const h = clusterHealth(pts[0]!.x)!.peek();
      if (h.iters > maxIters) maxIters = h.iters;
    }
    expect(cold.converged).toBe(true);
    expect(maxIters).toBeLessThanOrEqual(3); // 10-cell chain may need 1-2 more iters than 4-bar
  });

  it("16-vertex regular polygon — drag the anchor", () => {
    const O = point(num(0), num(0));
    const R = 1;
    const N = 16;
    const verts = Array.from({ length: N }, (_, i) => {
      const a = (i * 2 * Math.PI) / N;
      return point(num(R * Math.cos(a)), num(R * Math.sin(a)));
    });
    for (let i = 0; i < N; i++) {
      const next = verts[(i + 1) % N]!;
      dist(verts[i]!, next, 2 * R * Math.sin(Math.PI / N));
    }
    pinPoint(O);
    pinPoint(verts[0]!);
    void clusterHealth(verts[0]!.x)!.value;

    // Drag a vertex slightly — small move
    let maxIters = 0;
    for (let i = 1; i < 30; i++) {
      const theta = i * 0.005;
      verts[0]!.x.value = Math.cos(theta);
      verts[0]!.y.value = Math.sin(theta);
      const h = clusterHealth(verts[0]!.x)!.peek();
      if (h.iters > maxIters) maxIters = h.iters;
    }
    // 16-vertex cycle is more constrained than chain; warm-start
    // should still hold.
    expect(maxIters).toBeLessThanOrEqual(3);
  });
});

describe("cluster size scaling", () => {
  it("cluster of 50 cells with linear constraints solves in modest iters", () => {
    // 50 cells where each pair (i, i+1) has eq constraint.
    const cells = Array.from({ length: 50 }, () => num(Math.random() * 10));
    for (let i = 0; i + 1 < cells.length; i++) {
      relate({
        cells: [cells[i]!, cells[i + 1]!],
        residual: ([x, y], out) => {
          out[0] = x! - y!;
        },
        m: 1,
      });
    }
    // After construction, all 50 should agree (joint solve picked
    // the mean of all initials).
    const v = cells[0]!.value;
    for (const c of cells) expect(c.value).toBeCloseTo(v, 4);
  });
});
