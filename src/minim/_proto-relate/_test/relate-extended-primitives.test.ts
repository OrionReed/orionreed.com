// relate-extended-primitives.test.ts — coverage for the new primitive
// classes added in the second round of expansion: weighted/soft
// constraints, inequalities, layout, more geometric, and rigid bodies.

import { describe, expect, it } from "vitest";
import {
  alignNum,
  alignVec,
  bounded,
  circumcircle,
  dist,
  equalSpacing,
  geq,
  leq,
  perpendicularBisector,
  pinPoint,
  rigid,
  space,
  Strength,
  tangentCircles,
  tangentLineCircle,
} from "../constraints";
import { num, vec } from "../index";
import { hardPin, relate } from "../relate";

const EPS = 1e-4;

// ─── Weighted / strength ─────────────────────────────────────────────

describe("Weighted constraints (Cassowary-style strengths)", () => {
  it("two soft constraints — weights determine which dominates", () => {
    const a = num(0);
    // Constraint 1: a = 5 with weak strength.
    relate({
      cells: [a],
      residual: ([v], out) => {
        out[0] = (v as number) - 5;
      },
      m: 1,
      weight: Strength.WEAK,
    });
    // Constraint 2: a = 10 with strong strength.
    relate({
      cells: [a],
      residual: ([v], out) => {
        out[0] = (v as number) - 10;
      },
      m: 1,
      weight: Strength.STRONG,
    });
    // The strong constraint dominates: a ≈ 10 (slight pull toward 5
    // from the weak constraint, but it's negligible at strength
    // ratio 1e6 : 1).
    expect(a.value).toBeCloseTo(10, 3);
  });

  it("required + soft — required always wins (when feasible)", () => {
    const a = num(0);
    relate({
      cells: [a],
      residual: ([v], out) => {
        out[0] = (v as number) - 100;
      },
      m: 1,
      weight: Strength.REQUIRED,
    });
    relate({
      cells: [a],
      residual: ([v], out) => {
        out[0] = (v as number) - 50;
      },
      m: 1,
      weight: Strength.MEDIUM,
    });
    // a should be ~100 (REQUIRED dominates by 1e6×).
    expect(a.value).toBeCloseTo(100, 2);
  });

  it("equal weights — LSQ midpoint", () => {
    const a = num(0);
    relate({
      cells: [a],
      residual: ([v], out) => {
        out[0] = (v as number) - 0;
      },
      m: 1,
    });
    relate({
      cells: [a],
      residual: ([v], out) => {
        out[0] = (v as number) - 10;
      },
      m: 1,
    });
    expect(a.value).toBeCloseTo(5, 4);
  });
});

// ─── Inequality constraints ──────────────────────────────────────────

describe("Inequality constraints (penalty form)", () => {
  it("leq(a, b): a ≤ b, residual zero when satisfied", () => {
    const a = num(2);
    const b = num(5);
    leq(a, b);
    // Already satisfied: a < b. Both stay.
    expect(a.value).toBeCloseTo(2, 4);
    expect(b.value).toBeCloseTo(5, 4);
  });

  it("leq(a, b): violation pushed apart toward feasibility", () => {
    const a = num(7);
    const b = num(2);
    leq(a, b);
    // Violated: a > b. Soft penalty pulls them apart toward a ≤ b.
    expect(a.value).toBeLessThanOrEqual(b.value + EPS);
  });

  it("geq(a, b) is leq(b, a)", () => {
    const a = num(2);
    const b = num(7);
    geq(a, b);
    // Should violate (a < b). Push so a ≥ b.
    expect(a.value).toBeGreaterThanOrEqual(b.value - EPS);
  });

  it("bounded(x, lo, hi): pulls x into [lo, hi] when outside", () => {
    const x = num(15);
    bounded(x, 0, 10);
    expect(x.value).toBeLessThanOrEqual(10 + EPS);
    expect(x.value).toBeGreaterThanOrEqual(0 - EPS);
  });

  it("bounded with REQUIRED weight: hard satisfaction", () => {
    const x = num(15);
    bounded(x, 0, 10, Strength.REQUIRED);
    expect(x.value).toBeLessThanOrEqual(10 + 1e-3);
  });

  it("bounded with reactive bounds (Num lo, hi) — drag bounds, x follows", () => {
    const x = num(50);
    const lo = num(0);
    const hi = num(100);
    bounded(x, lo, hi, Strength.REQUIRED);
    // In bounds: no movement.
    expect(x.value).toBeCloseTo(50, 4);
    // Squeeze upper bound below x's current value.
    hi.value = 30;
    // x should be pushed to ≤ 30.
    expect(x.value).toBeLessThanOrEqual(30 + 1e-3);
  });
});

// ─── Layout primitives ───────────────────────────────────────────────

describe("Layout primitives — Cassowary territory", () => {
  it("alignNum: chain of cells equal on the same axis", () => {
    const a = num(1);
    const b = num(2);
    const c = num(3);
    const d = num(4);
    alignNum(a, b, c, d);
    // All four converge to the LSQ mean.
    const mean = (1 + 2 + 3 + 4) / 4;
    expect(a.value).toBeCloseTo(mean, 4);
    expect(d.value).toBeCloseTo(mean, 4);
  });

  it("alignVec on x-axis: vectors at the same x", () => {
    const A = vec(1, 5);
    const B = vec(3, 8);
    const C = vec(2, 1);
    alignVec("x", A, B, C);
    expect(A.value.x).toBeCloseTo(B.value.x, 4);
    expect(B.value.x).toBeCloseTo(C.value.x, 4);
  });

  it("space: row layout with fixed gaps", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    const C = vec(2, 0);
    space(A, B, 10);
    space(B, C, 10);
    pinPoint(A);
    expect(B.value.x - A.value.x).toBeCloseTo(10, 4);
    expect(C.value.x - B.value.x).toBeCloseTo(10, 4);
  });

  it("equalSpacing: distribute three points evenly along x", () => {
    const A = vec(0, 0);
    const B = vec(2, 0);
    const C = vec(10, 0);
    equalSpacing("x", A, B, C);
    pinPoint(A);
    pinPoint(C);
    // B should be exactly between A and C on the x-axis.
    expect(B.value.x).toBeCloseTo((A.value.x + C.value.x) / 2, 4);
  });
});

// ─── More geometric primitives ───────────────────────────────────────

describe("Sketchpad-completeness primitives", () => {
  it("tangentCircles externally: |c1-c2| = r1+r2", () => {
    const c1 = vec(0, 0);
    const c2 = vec(3, 0);
    pinPoint(c1);
    tangentCircles(c1, 1, c2, 2);
    expect(Math.hypot(c2.value.x - c1.value.x, c2.value.y - c1.value.y)).toBeCloseTo(3, 4);
  });

  it("tangentLineCircle: line passes at perpendicular distance r from c", () => {
    const A = vec(-5, 5);
    const B = vec(5, 5);
    const c = vec(0, 0);
    pinPoint(A);
    pinPoint(B);
    pinPoint(c);
    tangentLineCircle(A, B, c, 5);
    // Line is horizontal at y=5; perpendicular distance from origin
    // is 5. Already satisfied.
    // Just check no NaN, residual ≈ 0.
    expect(A.value.y).toBeCloseTo(5, 4);
    expect(B.value.y).toBeCloseTo(5, 4);
  });

  it("circumcircle: three points on a circle of radius r centred at c", () => {
    const c = vec(0, 0);
    const r = num(1);
    const A = vec(1, 0);
    const B = vec(0, 1);
    const C = vec(-1, 0);
    pinPoint(c);
    hardPin(r, 1);
    circumcircle(c, r, A, B, C);
    expect(Math.hypot(A.value.x, A.value.y)).toBeCloseTo(1, 4);
    expect(Math.hypot(B.value.x, B.value.y)).toBeCloseTo(1, 4);
    expect(Math.hypot(C.value.x, C.value.y)).toBeCloseTo(1, 4);
  });

  it("perpendicularBisector: line bisects PQ perpendicularly", () => {
    const P = vec(-2, 0);
    const Q = vec(2, 0);
    pinPoint(P);
    pinPoint(Q);
    const A = vec(0, -1);
    const B = vec(0, 1);
    perpendicularBisector(A, B, P, Q);
    // Line AB is vertical through midpoint (0, 0). A.x and B.x = 0.
    expect(A.value.x).toBeCloseTo(0, 4);
    expect(B.value.x).toBeCloseTo(0, 4);
  });
});

// ─── Rigid bodies ────────────────────────────────────────────────────

describe("Rigid body grouping", () => {
  it("rigid(...4 points): all 6 pairwise distances preserved under incremental drag", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    const C = vec(1, 1);
    const D = vec(0, 1);
    rigid(A, B, C, D);
    const expectedDistances = {
      AB: 1,
      BC: 1,
      CD: 1,
      DA: 1,
      AC: Math.SQRT2,
      BD: Math.SQRT2,
    };
    // Drag A in small steps. With 6 constraints over 8 vars, rank
    // is deficient by 1 (one diagonal redundant with the rest); LM
    // damping handles it. Large jumps could leave Newton's quadratic
    // basin; small steps stay warm.
    for (let i = 1; i <= 20; i++) {
      A.value = { x: i * 0.25, y: 0 };
    }
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(
      expectedDistances.AB,
      3,
    );
    expect(Math.hypot(B.value.x - C.value.x, B.value.y - C.value.y)).toBeCloseTo(
      expectedDistances.BC,
      3,
    );
    expect(Math.hypot(C.value.x - D.value.x, C.value.y - D.value.y)).toBeCloseTo(
      expectedDistances.CD,
      3,
    );
    expect(Math.hypot(D.value.x - A.value.x, D.value.y - A.value.y)).toBeCloseTo(
      expectedDistances.DA,
      3,
    );
    expect(Math.hypot(A.value.x - C.value.x, A.value.y - C.value.y)).toBeCloseTo(
      expectedDistances.AC,
      3,
    );
    expect(Math.hypot(B.value.x - D.value.x, B.value.y - D.value.y)).toBeCloseTo(
      expectedDistances.BD,
      3,
    );
  });

  it("rigid(...3 points) — triangle moves as one unit", () => {
    const A = vec(0, 0);
    const B = vec(2, 0);
    const C = vec(1, 1.732);
    rigid(A, B, C);
    A.value = { x: 10, y: 5 };
    // Triangle preserved.
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(2, 3);
    expect(Math.hypot(B.value.x - C.value.x, B.value.y - C.value.y)).toBeCloseTo(2, 3);
    expect(Math.hypot(C.value.x - A.value.x, C.value.y - A.value.y)).toBeCloseTo(2, 3);
  });
});

void dist;
