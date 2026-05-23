// avbd-limitations.test.ts — what is and isn't expressible via
// constraints in AVBD. This file documents the boundaries by
// example: each test demonstrates a class of constraint and either
// shows it works cleanly, or shows it works with caveats.
//
// ─── Cleanly expressible ────────────────────────────────────────
//   Equality, distance, lens, projection (clamp/snap), inequality,
//   joint limits, soft pulls, geometric primitives (angle, parallel,
//   perpendicular, on-line, on-circle, equal-distance), arbitrary
//   smooth multi-cell residuals via `generic`. Mixed dimensions.
//   Mixed stiffness. Mixed soft+hard.
//
// ─── Expressible with caveats ───────────────────────────────────
//   - Many-cell global constraints (sum, average over N cells):
//     converge slower because Gauss-Seidel info propagates one hop
//     per iteration. Workaround: split into per-pair, or accept
//     more iters.
//   - Cyclic / wraparound (angles): need a manually-wrapped
//     residual that never differs by more than π between solver
//     iterations.
//   - Constraints with rank-deficient Jacobians at certain
//     configurations (collinear points, degenerate triangles):
//     handled correctly by the geometric-stiffness Hessian but
//     can converge slowly when initial guess is exactly at the
//     degenerate point.
//   - Discontinuous residuals (max, abs): work via penalty + dual,
//     but dual variable can oscillate near the discontinuity.
//
// ─── Not expressible / poor results ─────────────────────────────
//   - Discrete state (which-side-of-line, integer values, boolean
//     selection): AVBD is continuous; no good encoding.
//   - Topological choices ("a OR b satisfies"): no native
//     disjunction.
//   - Non-convex global optimisation (find argmin of a non-convex
//     energy): AVBD finds the nearest local minimum, not the
//     global one.
//   - Combinatorial domains (graph colouring, scheduling): wrong
//     algorithm class entirely.
//   - Constraints involving sorting / order (e.g., "the smallest
//     value across these cells"): non-smooth, breaks Newton.

import { describe, expect, it } from "vitest";
import { Cell, distance, generic, Solver } from "../index";

describe("Cleanly expressible — smooth multi-cell residuals", () => {
  it("centroid: M = mean of N points", () => {
    const N = 5;
    const points: Cell[] = [];
    for (let i = 0; i < N; i++) {
      points.push(new Cell(2, [Math.cos(i), Math.sin(i)]));
      points[i]!.mass = 0; // pin all input points
    }
    const M = new Cell(2, [0, 0]);
    const s = new Solver({ iterations: 10 });
    for (const p of points) s.addCell(p);
    s.addCell(M);
    generic(s, [M, ...points], 2, (pos, out) => {
      const m = pos[0]!;
      let sx = 0,
        sy = 0;
      for (let i = 1; i < pos.length; i++) {
        sx += pos[i]![0]!;
        sy += pos[i]![1]!;
      }
      out[0]! = m[0]! - sx / N;
      out[1]! = m[1]! - sy / N;
    });
    s.step();
    s.step();
    let exX = 0,
      exY = 0;
    for (let i = 0; i < N; i++) {
      exX += Math.cos(i);
      exY += Math.sin(i);
    }
    expect(M.position[0]!).toBeCloseTo(exX / N, 3);
    expect(M.position[1]!).toBeCloseTo(exY / N, 3);
  });

  it("polynomial constraint: y = x² (parabola)", () => {
    // Pin x; y converges to x². Then drag x; y follows.
    const x = new Cell(1, [3]);
    const y = new Cell(1, [0]);
    x.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(x);
    s.addCell(y);
    generic(s, [x, y], 1, (pos, out) => {
      out[0]! = pos[1]![0]! - pos[0]![0]! * pos[0]![0]!;
    });
    s.step();
    expect(y.position[0]!).toBeCloseTo(9, 2);
    x.position[0]! = -2;
    for (let i = 0; i < 5; i++) s.step();
    expect(y.position[0]!).toBeCloseTo(4, 2);
  });

  it("trigonometric: y = sin(x), inverted by pinning y", () => {
    // Pin y, find an x such that sin(x) = y. Solver picks the
    // closest-to-warm-start solution.
    const x = new Cell(1, [0.3]); // start near a known root
    const y = new Cell(1, [0.5]);
    y.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(x);
    s.addCell(y);
    generic(s, [x, y], 1, (pos, out) => {
      out[0]! = Math.sin(pos[0]![0]!) - pos[1]![0]!;
    });
    for (let i = 0; i < 10; i++) s.step();
    expect(Math.sin(x.position[0]!)).toBeCloseTo(0.5, 3);
    // x should be near asin(0.5) = π/6 ≈ 0.524 (warm-started near it).
    expect(x.position[0]!).toBeCloseTo(Math.PI / 6, 2);
  });
});

describe("Expressible with caveats", () => {
  it("discontinuous: |a| = b — works but oscillates near a=0", () => {
    // Constrain |a| = b. Smooth except at a=0 where derivative jumps.
    // With a starting away from 0, fine. Starting AT 0 is degenerate.
    const a = new Cell(1, [-3]);
    const b = new Cell(1, [0]);
    a.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(a);
    s.addCell(b);
    generic(s, [a, b], 1, (pos, out) => {
      out[0]! = Math.abs(pos[0]![0]!) - pos[1]![0]!;
    });
    for (let i = 0; i < 5; i++) s.step();
    expect(b.position[0]!).toBeCloseTo(3, 2);
  });

  it("max / clamp: y = max(a, b) — penalty form works", () => {
    // y = max(a, b). Pin a and b; y converges to the larger.
    const a = new Cell(1, [3]);
    const b = new Cell(1, [5]);
    const y = new Cell(1, [0]);
    a.mass = 0;
    b.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(a);
    s.addCell(b);
    s.addCell(y);
    generic(s, [a, b, y], 1, (pos, out) => {
      out[0]! = pos[2]![0]! - Math.max(pos[0]![0]!, pos[1]![0]!);
    });
    for (let i = 0; i < 5; i++) s.step();
    expect(y.position[0]!).toBeCloseTo(5, 2);
  });

  it("non-convex: y = sin(10x), pin y near 0 — picks nearest root", () => {
    // Many local minima. AVBD picks the one closest to warm-start.
    // This is the expected behaviour, not a bug.
    const x = new Cell(1, [0.5]); // warm-start near 5th root
    const y = new Cell(1, [0]);
    y.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(x);
    s.addCell(y);
    generic(s, [x, y], 1, (pos, out) => {
      out[0]! = Math.sin(10 * pos[0]![0]!) - pos[1]![0]!;
    });
    for (let i = 0; i < 5; i++) s.step();
    // sin(10x) = 0 at x = nπ/10. Near 0.5 the root is x = π/10 ≈ 0.314
    // OR x = 2π/10 ≈ 0.628. Solver picks closest by warm-start.
    expect(Math.sin(10 * x.position[0]!)).toBeLessThan(1e-3);
  });
});

describe("Subsumption: AVBD does what relate did", () => {
  // Spot-check that key relate-prototype patterns translate to AVBD
  // cleanly. Reactive signal integration is the only piece NOT yet
  // ported (mechanical, deferred).

  it("relate-style equilateral triangle", () => {
    const A = new Cell(2, [0, 0]);
    const B = new Cell(2, [1, 0]);
    const C = new Cell(2, [0.5, 0.5]);
    A.mass = 0;
    B.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(C);
    distance(s, A, B, 1);
    distance(s, B, C, 1);
    distance(s, C, A, 1);
    for (let i = 0; i < 5; i++) s.step();
    const dAB = Math.hypot(A.position[0]! - B.position[0]!, A.position[1]! - B.position[1]!);
    const dBC = Math.hypot(B.position[0]! - C.position[0]!, B.position[1]! - C.position[1]!);
    const dCA = Math.hypot(C.position[0]! - A.position[0]!, C.position[1]! - A.position[1]!);
    expect(dAB).toBeCloseTo(1, 3);
    expect(dBC).toBeCloseTo(1, 3);
    expect(dCA).toBeCloseTo(1, 3);
  });

  it("relate-style 4-bar linkage", () => {
    const O0 = new Cell(2, [0, 0]);
    const O3 = new Cell(2, [4, 0]);
    const A = new Cell(2, [1, 0]);
    const B = new Cell(2, [4, 2]);
    O0.mass = 0;
    O3.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(O0);
    s.addCell(O3);
    s.addCell(A);
    s.addCell(B);
    const linkLen = Math.hypot(1 - 4, 0 - 2);
    distance(s, O0, A, 1);
    distance(s, A, B, linkLen);
    distance(s, O3, B, 2);
    // Drive A around an arc.
    A.mass = 0;
    let maxResidual = 0;
    for (let i = 0; i < 30; i++) {
      const theta = -0.6 + i * 0.02;
      A.position[0]! = Math.cos(theta);
      A.position[1]! = Math.sin(theta);
      s.step();
      maxResidual = Math.max(maxResidual, s.residualNorm());
    }
    expect(maxResidual).toBeLessThan(0.5); // tracking
  });

  it("inequality: x ∈ [0, 10] via natural force-bound constraint", () => {
    // The AVBD-native way to do clamp: a Force with stiffness=∞,
    // fmin=-∞, fmax=0 on a single one-sided constraint. Or two
    // such forces.
    const x = new Cell(1, [5]);
    const s = new Solver({ iterations: 10 });
    s.addCell(x);
    generic(s, [x], 1, (pos, out) => {
      out[0]! = pos[0]![0]!; // x − 0 ≥ 0
    }).fmax[0]! = 0; // force can only push up (clamp x ≥ 0)
    generic(s, [x], 1, (pos, out) => {
      out[0]! = pos[0]![0]! - 10; // x − 10 ≤ 0
    }).fmin[0]! = 0;
    // Pull below 0.
    x.position[0]! = -50;
    for (let i = 0; i < 5; i++) s.step();
    expect(x.position[0]!).toBeGreaterThan(-0.5);
    expect(x.position[0]!).toBeLessThan(1);
  });

  it("relate-style 'lens' chain b = 2a, c = 3b", () => {
    const a = new Cell(1, [1]);
    const b = new Cell(1, [2]);
    const c = new Cell(1, [6]);
    a.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(a);
    s.addCell(b);
    s.addCell(c);
    generic(s, [a, b], 1, (pos, out) => {
      out[0]! = pos[1]![0]! - 2 * pos[0]![0]!;
    });
    generic(s, [b, c], 1, (pos, out) => {
      out[0]! = pos[1]![0]! - 3 * pos[0]![0]!;
    });
    a.position[0]! = 5;
    for (let i = 0; i < 5; i++) s.step();
    expect(b.position[0]!).toBeCloseTo(10, 2);
    expect(c.position[0]!).toBeCloseTo(30, 2);
  });
});

describe("Not cleanly expressible (just for reference)", () => {
  it("discrete: integer constraint via penalty (poor result)", () => {
    // Constrain x to be a non-negative integer. Encode as residual
    // = x - round(x). Has zero gradient almost everywhere — bad.
    const x = new Cell(1, [3.5]);
    const s = new Solver({ iterations: 50 });
    s.addCell(x);
    generic(s, [x], 1, (pos, out) => {
      const v = pos[0]![0]!;
      out[0]! = v - Math.round(v);
    });
    for (let i = 0; i < 10; i++) s.step();
    // We don't promise this works! It might pin to 3, 4, or
    // somewhere in between depending on how penalty interacts with
    // the rounding step. Just verify nothing exploded.
    expect(Number.isFinite(x.position[0]!)).toBe(true);
  });
});
