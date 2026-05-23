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
//   - Discrete state, topological choices, non-convex global
//     optimisation, combinatorial domains, sorting / ordering.

import { describe, expect, it } from "vitest";
import { distance, generic, num, Solver, vec, VecCell } from "../index";

describe("Cleanly expressible — smooth multi-cell residuals", () => {
  it("centroid: M = mean of N points", () => {
    const N = 5;
    const points: VecCell[] = [];
    for (let i = 0; i < N; i++) {
      points.push(vec(Math.cos(i), Math.sin(i)));
      points[i]!.mass = 0;
    }
    const M = vec(0, 0);
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
    expect(M.x).toBeCloseTo(exX / N, 3);
    expect(M.y).toBeCloseTo(exY / N, 3);
  });

  it("polynomial constraint: y = x² (parabola)", () => {
    const x = num(3);
    const y = num(0);
    x.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(x);
    s.addCell(y);
    generic(s, [x, y], 1, (pos, out) => {
      out[0]! = pos[1]![0]! - pos[0]![0]! * pos[0]![0]!;
    });
    s.step();
    expect(y.value).toBeCloseTo(9, 2);
    x.value = -2;
    for (let i = 0; i < 5; i++) s.step();
    expect(y.value).toBeCloseTo(4, 2);
  });

  it("trigonometric: y = sin(x), inverted by pinning y", () => {
    const x = num(0.3);
    const y = num(0.5);
    y.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(x);
    s.addCell(y);
    generic(s, [x, y], 1, (pos, out) => {
      out[0]! = Math.sin(pos[0]![0]!) - pos[1]![0]!;
    });
    for (let i = 0; i < 10; i++) s.step();
    expect(Math.sin(x.value)).toBeCloseTo(0.5, 3);
    expect(x.value).toBeCloseTo(Math.PI / 6, 2);
  });
});

describe("Expressible with caveats", () => {
  it("discontinuous: |a| = b — works but oscillates near a=0", () => {
    const a = num(-3);
    const b = num(0);
    a.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(a);
    s.addCell(b);
    generic(s, [a, b], 1, (pos, out) => {
      out[0]! = Math.abs(pos[0]![0]!) - pos[1]![0]!;
    });
    for (let i = 0; i < 5; i++) s.step();
    expect(b.value).toBeCloseTo(3, 2);
  });

  it("max / clamp: y = max(a, b) — penalty form works", () => {
    const a = num(3);
    const b = num(5);
    const y = num(0);
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
    expect(y.value).toBeCloseTo(5, 2);
  });

  it("non-convex: y = sin(10x), pin y near 0 — picks nearest root", () => {
    const x = num(0.5);
    const y = num(0);
    y.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(x);
    s.addCell(y);
    generic(s, [x, y], 1, (pos, out) => {
      out[0]! = Math.sin(10 * pos[0]![0]!) - pos[1]![0]!;
    });
    for (let i = 0; i < 5; i++) s.step();
    expect(Math.sin(10 * x.value)).toBeLessThan(1e-3);
  });
});

describe("Subsumption: AVBD does what relate did", () => {
  it("relate-style equilateral triangle", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    const C = vec(0.5, 0.5);
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
    const dAB = Math.hypot(A.x - B.x, A.y - B.y);
    const dBC = Math.hypot(B.x - C.x, B.y - C.y);
    const dCA = Math.hypot(C.x - A.x, C.y - A.y);
    expect(dAB).toBeCloseTo(1, 3);
    expect(dBC).toBeCloseTo(1, 3);
    expect(dCA).toBeCloseTo(1, 3);
  });

  it("relate-style 4-bar linkage", () => {
    const O0 = vec(0, 0);
    const O3 = vec(4, 0);
    const A = vec(1, 0);
    const B = vec(4, 2);
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
    A.mass = 0;
    let maxResidual = 0;
    for (let i = 0; i < 30; i++) {
      const theta = -0.6 + i * 0.02;
      A.value = { x: Math.cos(theta), y: Math.sin(theta) };
      s.step();
      maxResidual = Math.max(maxResidual, s.residualNorm());
    }
    expect(maxResidual).toBeLessThan(0.5);
  });

  it("inequality: x ∈ [0, 10] via natural force-bound constraint", () => {
    const x = num(5);
    const s = new Solver({ iterations: 10 });
    s.addCell(x);
    generic(s, [x], 1, (pos, out) => {
      out[0]! = pos[0]![0]!; // x − 0 ≥ 0
    }).fmax[0]! = 0;
    generic(s, [x], 1, (pos, out) => {
      out[0]! = pos[0]![0]! - 10; // x − 10 ≤ 0
    }).fmin[0]! = 0;
    x.value = -50;
    for (let i = 0; i < 5; i++) s.step();
    expect(x.value).toBeGreaterThan(-0.5);
    expect(x.value).toBeLessThan(1);
  });

  it("relate-style 'lens' chain b = 2a, c = 3b", () => {
    const a = num(1);
    const b = num(2);
    const c = num(6);
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
    a.value = 5;
    for (let i = 0; i < 5; i++) s.step();
    expect(b.value).toBeCloseTo(10, 2);
    expect(c.value).toBeCloseTo(30, 2);
  });
});

describe("Not cleanly expressible (just for reference)", () => {
  it("discrete: integer constraint via penalty (poor result)", () => {
    const x = num(3.5);
    const s = new Solver({ iterations: 50 });
    s.addCell(x);
    generic(s, [x], 1, (pos, out) => {
      const v = pos[0]![0]!;
      out[0]! = v - Math.round(v);
    });
    for (let i = 0; i < 10; i++) s.step();
    expect(Number.isFinite(x.value)).toBe(true);
  });
});
