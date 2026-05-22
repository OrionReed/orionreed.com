// Smoke tests for the bare numerical kit (LU + damped Newton).
// These run in pure number-space; no Signal involvement.

import { describe, expect, it } from "vitest";
import { dampedNewton, residualNorm, tinyLU } from "../solvers";

describe("tinyLU", () => {
  it("solves a 3×3 system exactly", () => {
    // 2x + y - z = 8
    //  -3x - y + 2z = -11
    //  -2x + y + 2z = -3
    const A = [2, 1, -1, -3, -1, 2, -2, 1, 2];
    const b = [8, -11, -3];
    const x = [0, 0, 0];
    tinyLU(A, b, 3, x);
    expect(x[0]).toBeCloseTo(2, 9);
    expect(x[1]).toBeCloseTo(3, 9);
    expect(x[2]).toBeCloseTo(-1, 9);
  });

  it("solves identity returns rhs", () => {
    const A = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const b = [4, 5, 6];
    const x = [0, 0, 0];
    tinyLU(A, b, 3, x);
    expect(x).toEqual([4, 5, 6]);
  });

  it("requires partial pivoting (zero pivot in row 0)", () => {
    // Without pivoting this would divide by zero; with partial pivot
    // tinyLU swaps to row 1 first.
    const A = [0, 1, 1, 0, 1, -1, 0];
    const b = [3, 4, -1];
    const x = [0, 0, 0];
    // 3×3 only; build it explicitly:
    const A3 = [0, 1, 0, 1, 0, 0, 0, 0, 1];
    const b3 = [5, 7, 9];
    tinyLU(A3, b3, 3, x);
    // Row 0: y = 5; Row 1: x = 7; Row 2: z = 9.
    expect(x[0]).toBeCloseTo(7);
    expect(x[1]).toBeCloseTo(5);
    expect(x[2]).toBeCloseTo(9);
    void A;
    void b;
  });

  it("throws on singular matrix", () => {
    const A = [1, 2, 2, 4]; // rank 1
    const b = [3, 6];
    const x = [0, 0];
    expect(() => tinyLU(A, b, 2, x)).toThrow(/singular/);
  });
});

describe("dampedNewton — single residual", () => {
  it("solves 1D scalar root: x² - 4 = 0 from x=3", () => {
    const x = [3];
    const R = (xs: readonly number[], out: number[]) => {
      out[0] = xs[0]! * xs[0]! - 4;
    };
    const result = dampedNewton(x, R, 1, [false]);
    expect(result.converged).toBe(true);
    expect(x[0]).toBeCloseTo(2, 6);
  });

  it("warm-start: x near solution converges in ≤2 iters", () => {
    const x = [2.001];
    const R = (xs: readonly number[], out: number[]) => {
      out[0] = xs[0]! * xs[0]! - 4;
    };
    const result = dampedNewton(x, R, 1, [false]);
    expect(result.converged).toBe(true);
    expect(result.iters).toBeLessThanOrEqual(2);
  });
});

describe("dampedNewton — pinned indices", () => {
  it("pythagoras: a, b pinned, c free", () => {
    const x = [3, 4, 0];
    const R = (xs: readonly number[], out: number[]) => {
      const [a, b, c] = xs as [number, number, number];
      out[0] = a * a + b * b - c * c;
    };
    const result = dampedNewton(x, R, 1, [true, true, false]);
    expect(result.converged).toBe(true);
    expect(x[0]).toBe(3);
    expect(x[1]).toBe(4);
    expect(Math.abs(x[2])).toBeCloseTo(5, 6);
  });

  it("pythagoras: a pinned, b and c free — picks one of infinite solutions near current", () => {
    const x = [6, 4, 5];
    const R = (xs: readonly number[], out: number[]) => {
      const [a, b, c] = xs as [number, number, number];
      out[0] = a * a + b * b - c * c;
    };
    const result = dampedNewton(x, R, 1, [true, false, false]);
    expect(result.converged).toBe(true);
    expect(x[0]).toBe(6);
    // a²+b²=c² with a=6 means b²=c²-36; warm-started from (b=4, c=5)
    // with a now 6, the constraint pulls b and c such that 36+b²=c².
    expect(Math.abs(x[0]! ** 2 + x[1]! ** 2 - x[2]! ** 2)).toBeLessThan(1e-6);
  });
});

describe("dampedNewton — multiple residuals", () => {
  it("equilateral triangle on three points: distance constraints", () => {
    // Three 2D points = 6 vars: A=(0,0), B=(1,0), C=(?,?)
    // Constraints: |AB|=|BC|=|CA|=1. Pin A and B.
    const x = [0, 0, 1, 0, 0.5, 0.5];
    const R = (xs: readonly number[], out: number[]) => {
      const [ax, ay, bx, by, cx, cy] = xs as [number, number, number, number, number, number];
      const dAB = Math.hypot(ax - bx, ay - by);
      const dBC = Math.hypot(bx - cx, by - cy);
      const dCA = Math.hypot(cx - ax, cy - ay);
      out[0] = dAB - 1;
      out[1] = dBC - 1;
      out[2] = dCA - 1;
    };
    const result = dampedNewton(x, R, 3, [true, true, true, true, false, false]);
    expect(result.converged).toBe(true);
    // C should be at (0.5, ±√3/2) ≈ (0.5, 0.866)
    expect(x[4]).toBeCloseTo(0.5, 4);
    expect(Math.abs(x[5]!)).toBeCloseTo(Math.sqrt(3) / 2, 4);
  });

  it("over-constrained gracefully degrades (no NaN)", () => {
    // Three constraints on a single variable, mutually inconsistent.
    const x = [1];
    const R = (xs: readonly number[], out: number[]) => {
      out[0] = xs[0]! - 1;
      out[1] = xs[0]! - 2;
      out[2] = xs[0]! - 3;
    };
    const result = dampedNewton(x, R, 3, [false]);
    expect(result.converged).toBe(false); // no exact solution
    // Least-squares optimum is x=2 (mean).
    expect(x[0]).toBeCloseTo(2, 4);
    expect(result.residual).toBeCloseTo(Math.sqrt(2), 4);
    expect(Number.isFinite(x[0])).toBe(true);
  });
});

void residualNorm;
