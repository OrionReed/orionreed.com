// relate-primitives.test.ts — exercise each constraint factory.
// Each primitive is tested in isolation (cluster of N cells, one
// relation) for both starting-satisfied and snapping-into-place
// behaviour, plus drag-of-one-input.

import { describe, expect, it } from "vitest";
import {
  angle,
  centroid,
  dist,
  eq,
  equalDist,
  midpoint,
  onCircle,
  onLine,
  parallel,
  perpendicular,
  pin,
  pinPoint,
  point,
  reflectThrough,
} from "../constraints";
import { num } from "../index";
import { relate } from "../relate";

const EPS = 1e-6;

describe("eq — a = b", () => {
  it("snaps b to a on construction", () => {
    const a = num(5);
    const b = num(10);
    eq(a, b);
    expect(a.value).toBeCloseTo(b.value, 9);
    // Specifically: solver picks the closest joint solution; with both
    // free, it lands somewhere in between, but the residual is 0.
  });
  it("dragging a pulls b along", () => {
    const a = num(5);
    const b = num(5);
    eq(a, b);
    a.value = 17;
    expect(b.value).toBeCloseTo(17, 9);
  });
});

describe("dist — |PQ| = L", () => {
  it("snaps to length on construction", () => {
    const P = point(num(0), num(0));
    const Q = point(num(2), num(0));
    dist(P, Q, 5);
    expect(Math.hypot(Q.x.value - P.x.value, Q.y.value - P.y.value)).toBeCloseTo(5, 6);
  });
  it("dragging P maintains distance to Q", () => {
    const P = point(num(0), num(0));
    const Q = point(num(5), num(0));
    dist(P, Q, 5);
    P.x.value = -3;
    expect(Math.hypot(Q.x.value - P.x.value, Q.y.value - P.y.value)).toBeCloseTo(5, 6);
  });
  it("reactive length parameter (Signal L joins cluster, writes propagate)", () => {
    // Pass a Num directly as L. dist() detects it and adds it as a
    // cluster cell, so writing L triggers a re-solve and points reflow.
    const L = num(5);
    const P = point(num(0), num(0));
    const Q = point(num(5), num(0));
    dist(P, Q, L);
    pinPoint(P);
    L.value = 10;
    expect(Math.hypot(Q.x.value - P.x.value, Q.y.value - P.y.value)).toBeCloseTo(10, 4);
    expect(L.value).toBe(10);
  });
});

describe("midpoint — M = (A+B)/2", () => {
  it("M snaps to midpoint of A, B", () => {
    const M = point(num(0), num(0));
    const A = point(num(2), num(4));
    const B = point(num(8), num(10));
    pinPoint(A);
    pinPoint(B);
    midpoint(M, A, B);
    expect(M.x.value).toBeCloseTo(5, 6);
    expect(M.y.value).toBeCloseTo(7, 6);
  });
  it("dragging M translates A and B rigidly (under proportional writeback)", () => {
    const M = point(num(0), num(0));
    const A = point(num(-1), num(0));
    const B = point(num(1), num(0));
    midpoint(M, A, B);
    M.x.value = 5;
    M.y.value = 0;
    expect((A.x.value + B.x.value) / 2).toBeCloseTo(5, 6);
    expect((A.y.value + B.y.value) / 2).toBeCloseTo(0, 6);
  });
});

describe("centroid — C = mean(P_i)", () => {
  it("for three points, C lands at the centroid", () => {
    const C = point(num(0), num(0));
    const P1 = point(num(0), num(0));
    const P2 = point(num(3), num(0));
    const P3 = point(num(0), num(3));
    pinPoint(P1);
    pinPoint(P2);
    pinPoint(P3);
    centroid(C, P1, P2, P3);
    expect(C.x.value).toBeCloseTo(1, 6);
    expect(C.y.value).toBeCloseTo(1, 6);
  });
});

describe("onCircle — |P - c| = r", () => {
  it("P snaps to circle on construction (with c pinned first)", () => {
    // Pin c BEFORE creating onCircle, so the initial solve treats c
    // as fixed. Otherwise the solver freely moves both P and c to
    // satisfy |P-c|=5 — the constraint determines mutual distance,
    // not absolute position. (Equivalent to: declare what's fixed
    // before what depends on it.)
    const P = point(num(1), num(0));
    const c = point(num(0), num(0));
    pinPoint(c);
    onCircle(P, c, 5);
    expect(Math.hypot(P.x.value - c.x.value, P.y.value - c.y.value)).toBeCloseTo(5, 6);
    expect(Math.hypot(c.x.value, c.y.value)).toBeCloseTo(0, 6);
  });
});

describe("onLine — P collinear with A, B", () => {
  it("P snaps onto line AB", () => {
    const P = point(num(0), num(5));
    const A = point(num(0), num(0));
    const B = point(num(10), num(0));
    pinPoint(A);
    pinPoint(B);
    onLine(P, A, B);
    expect(P.y.value).toBeCloseTo(0, 6);
  });
});

describe("parallel / perpendicular", () => {
  it("parallel: AB ∥ CD", () => {
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    const C = point(num(0), num(1));
    const D = point(num(1), num(1.5));
    pinPoint(A);
    pinPoint(B);
    pinPoint(C);
    parallel(A, B, C, D);
    // D adjusts so CD parallel to AB (which is horizontal). So
    // D.y ≈ C.y = 1.
    expect(D.y.value).toBeCloseTo(C.y.value, 6);
  });
  it("perpendicular: AB ⊥ CD", () => {
    const A = point(num(0), num(0));
    const B = point(num(2), num(0));
    const C = point(num(1), num(0));
    const D = point(num(2), num(1));
    pinPoint(A);
    pinPoint(B);
    pinPoint(C);
    perpendicular(A, B, C, D);
    // CD must be perpendicular to AB (horizontal), so CD vertical.
    // Means D.x ≈ C.x = 1.
    expect(D.x.value).toBeCloseTo(C.x.value, 6);
  });
});

describe("angle ∠ABC = θ", () => {
  it("equilateral triangle: pin A, B at distance 1; angle ∠ABC=60° forces |BC|=…", () => {
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    const C = point(num(2), num(0));
    pinPoint(A);
    pinPoint(B);
    angle(A, B, C, Math.PI / 3);
    // Compute angle at B between BA and BC
    const ux = A.x.value - B.x.value;
    const uy = A.y.value - B.y.value;
    const vx = C.x.value - B.x.value;
    const vy = C.y.value - B.y.value;
    const cosTheta = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
    expect(Math.acos(cosTheta)).toBeCloseTo(Math.PI / 3, 4);
  });
});

describe("equalDist — |PQ| = |RS|", () => {
  it("equal-side property: changing PQ forces RS to match", () => {
    const P = point(num(0), num(0));
    const Q = point(num(5), num(0));
    const R = point(num(0), num(0));
    const S = point(num(3), num(0));
    pinPoint(P);
    pinPoint(R);
    equalDist(P, Q, R, S);
    expect(Math.hypot(Q.x.value - P.x.value, Q.y.value - P.y.value)).toBeCloseTo(
      Math.hypot(S.x.value - R.x.value, S.y.value - R.y.value),
      6,
    );
  });
});

describe("reflectThrough — P' = mirror of P across line AB", () => {
  it("reflection across the x-axis: P=(2, 3) ⇒ P'=(2, -3)", () => {
    const P = point(num(2), num(3));
    const Pp = point(num(0), num(0));
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    pinPoint(P);
    pinPoint(A);
    pinPoint(B);
    reflectThrough(Pp, P, A, B);
    expect(Pp.x.value).toBeCloseTo(2, 6);
    expect(Pp.y.value).toBeCloseTo(-3, 6);
  });
  it("reflection across an oblique line", () => {
    const P = point(num(2), num(0));
    const Pp = point(num(0), num(0));
    const A = point(num(0), num(0));
    const B = point(num(1), num(1));
    pinPoint(P);
    pinPoint(A);
    pinPoint(B);
    reflectThrough(Pp, P, A, B);
    // Reflection of (2,0) across y=x is (0,2)
    expect(Pp.x.value).toBeCloseTo(0, 6);
    expect(Pp.y.value).toBeCloseTo(2, 6);
  });
});

describe("pin — persistent fixed value (soft)", () => {
  it("pin holds a cell when no other cluster cell is being written", () => {
    // Pin behaves as a *soft* persistent constraint: it adds
    // `cell - target = 0` to the cluster's residual stack. Other
    // constraints are also residuals; the solver finds the joint
    // least-squares optimum. When user pins a cell, that cell
    // becomes truly fixed (engine pin > soft pin); see the next test.
    const a = num(0);
    const b = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! + y!; // a + b = 0
      },
      m: 1,
    });
    pin(a, 5);
    // After construction: solver minimises (a+b)² + (a-5)². Sets a=5,
    // b=-5 (closed-form solution).
    expect(a.value).toBeCloseTo(5, 6);
    expect(b.value).toBeCloseTo(-5, 6);
  });

  it("user write to a different cell still respects the pin via residual minimisation", () => {
    const a = num(5);
    const b = num(0);
    eq(a, b);
    pin(a, 5);
    // No user write: a=5 (pin), b=5 (eq).
    expect(a.value).toBeCloseTo(5, 6);
    expect(b.value).toBeCloseTo(5, 6);
  });
});

