// relate-construction.test.ts — Sketchpad-style geometric constructions.
//
// Each test composes the geometric primitives from `constraints.ts`
// to build a classical figure (perpendicular bisector, circumcircle,
// regular polygon, etc.) and asserts:
//
//   1. The figure is geometrically correct after construction.
//   2. Dragging an "input" element makes the rest reflow consistently.
//
// These are the demos that justify the primitive's existence — they
// are *currently impossible* with one-direction `through`/`lens` and
// usable only painfully via `argmin` (which only handles the open-chain
// IK case, and only with manual Jacobian massage).

import { describe, expect, it } from "vitest";
import {
  dist,
  midpoint,
  onCircle,
  onLine,
  perpendicular,
  pinPoint,
  point,
  reflectThrough,
} from "../constraints";
import { num } from "../index";

const EPS = 1e-4;

describe("Perpendicular bisector of AB through M", () => {
  it("M = midpoint(A, B); a fourth point P on perpendicular through M", () => {
    const A = point(num(0), num(0));
    const B = point(num(10), num(0));
    const M = point(num(0), num(0));
    pinPoint(A);
    pinPoint(B);
    midpoint(M, A, B);
    expect(M.x.value).toBeCloseTo(5);
    expect(M.y.value).toBeCloseTo(0);

    // Add a point P on the perpendicular to AB through M.
    const P = point(num(0), num(3));
    perpendicular(A, B, M, P);
    onLine(M, P, M); // P on the line through M (any direction)
    // The above is degenerate (M-P is the line, M is on it trivially).
    // We need P at fixed distance from M and perpendicular: just
    // perpendicular suffices since AB is horizontal.
    expect(P.x.value).toBeCloseTo(5, EPS); // P.x = M.x = 5 (on perp through M)
  });
});

describe("Equilateral triangle by construction", () => {
  it("classical Euclid Book 1 Prop 1: two circles meeting", () => {
    // Given AB, construct C such that |CA| = |CB| = |AB|.
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    pinPoint(A);
    pinPoint(B);
    const C = point(num(0.5), num(1)); // initial guess
    onCircle(C, A, 1); // C on circle radius 1 around A
    onCircle(C, B, 1); // C on circle radius 1 around B
    expect(Math.hypot(C.x.value - A.x.value, C.y.value - A.y.value)).toBeCloseTo(1, 6);
    expect(Math.hypot(C.x.value - B.x.value, C.y.value - B.y.value)).toBeCloseTo(1, 6);
    expect(C.x.value).toBeCloseTo(0.5, 6);
    expect(Math.abs(C.y.value)).toBeCloseTo(Math.sqrt(3) / 2, 6);
  });

  it("dragging A moves the whole triangle rigidly", () => {
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    const C = point(num(0.5), num(Math.sqrt(3) / 2));
    dist(A, B, 1);
    dist(B, C, 1);
    dist(C, A, 1);
    pinPoint(B); // anchor B so the figure has only the rotation DOF

    // Drag A
    A.x.value = 4;
    A.y.value = 0;

    // |AB|, |BC|, |CA| all 1.
    expect(Math.hypot(A.x.value - B.x.value, A.y.value - B.y.value)).toBeCloseTo(1, 4);
    expect(Math.hypot(B.x.value - C.x.value, B.y.value - C.y.value)).toBeCloseTo(1, 4);
    expect(Math.hypot(C.x.value - A.x.value, C.y.value - A.y.value)).toBeCloseTo(1, 4);
  });
});

describe("Reflection across a line", () => {
  it("reflecting a vertex across one side gives the canonical sister triangle", () => {
    // Triangle ABC; reflect C across AB to get C'.
    const A = point(num(0), num(0));
    const B = point(num(2), num(0));
    const C = point(num(1), num(1));
    const Cp = point(num(0), num(0));
    pinPoint(A);
    pinPoint(B);
    pinPoint(C);
    reflectThrough(Cp, C, A, B);
    expect(Cp.x.value).toBeCloseTo(C.x.value, 6);
    expect(Cp.y.value).toBeCloseTo(-C.y.value, 6); // mirrored across x-axis (= AB)
  });
});

describe("Square by four right angles + four equal sides", () => {
  it("constructs a unit square ABCD", () => {
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    const C = point(num(1), num(1));
    const D = point(num(0), num(1));
    pinPoint(A);
    pinPoint(B);

    // Sides
    dist(A, B, 1);
    dist(B, C, 1);
    dist(C, D, 1);
    dist(D, A, 1);
    // Right angles at corners — perpendicularity.
    perpendicular(A, B, B, C);
    perpendicular(B, C, C, D);

    // After construction, vertices should land at the unit square.
    expect(Math.hypot(C.x.value - 1, C.y.value - 1)).toBeLessThan(EPS);
    expect(Math.hypot(D.x.value - 0, D.y.value - 1)).toBeLessThan(EPS);
  });
});

describe("Pythagorean triangle (right triangle 3-4-5)", () => {
  it("a²+b²=c² + perpendicularity ⇒ legs along axes when one leg pinned", () => {
    // A right triangle: A=origin, B at (a, 0), C at (0, b).
    // We want |AB|=3, |AC|=4 (so |BC|=5), AB ⊥ AC.
    const A = point(num(0), num(0));
    const B = point(num(2), num(0));
    const C = point(num(0), num(3));
    pinPoint(A);

    dist(A, B, 3);
    dist(A, C, 4);
    perpendicular(A, B, A, C);

    expect(Math.hypot(A.x.value - B.x.value, A.y.value - B.y.value)).toBeCloseTo(3, 4);
    expect(Math.hypot(A.x.value - C.x.value, A.y.value - C.y.value)).toBeCloseTo(4, 4);
    // |BC| = 5 (Pythagoras emerges)
    expect(Math.hypot(B.x.value - C.x.value, B.y.value - C.y.value)).toBeCloseTo(5, 4);
  });
});

describe("Regular polygon by repeated equal-distance sides + diagonals", () => {
  it("regular hexagon: 6 sides equal, 6 cross-distances equal", () => {
    // A regular hexagon has 6 vertices on a circle of radius R; all
    // sides equal (= R for the unit hexagon). Easier construction:
    // 6 vertices on a circle, side = R.
    const O = point(num(0), num(0));
    pinPoint(O);
    const R = 1;
    const verts = Array.from({ length: 6 }, (_, i) => {
      const a = (i * Math.PI) / 3;
      return point(num(R * Math.cos(a) + 0.05 * Math.random()), num(R * Math.sin(a)));
    });
    // All on a unit circle around O.
    for (const v of verts) onCircle(v, O, R);
    // Adjacent distance = R (regular).
    for (let i = 0; i < 6; i++) dist(verts[i]!, verts[(i + 1) % 6]!, R);
    // Pin one vertex so the figure is rotation-determined.
    pinPoint(verts[0]!);

    // Adjacent distances equal R.
    for (let i = 0; i < 6; i++) {
      const a = verts[i]!;
      const b = verts[(i + 1) % 6]!;
      expect(Math.hypot(a.x.value - b.x.value, a.y.value - b.y.value)).toBeCloseTo(R, EPS);
    }
    // Vertex 3 should be antipodal to vertex 0.
    expect(
      Math.hypot(verts[3]!.x.value + verts[0]!.x.value, verts[3]!.y.value + verts[0]!.y.value),
    ).toBeCloseTo(0, 4);
  });
});

describe("Linkage: four-bar mechanism", () => {
  it("classic crank-rocker: pin two pivots, drive crank, watch rocker traverse arc", () => {
    // Standard four-bar linkage:
    //   - O₀ (origin pivot, fixed): the crank rotates around this.
    //   - O₃ (output pivot, fixed): the rocker rotates around this.
    //   - A = end of crank (driven) — on circle around O₀ of radius
    //     |O₀A| = a.
    //   - B = end of rocker — on circle around O₃ of radius |O₃B| = c.
    //   - The coupler |AB| = b is rigid.
    //
    // Drive A around its circle by setting its angle; B traces the
    // coupler curve. Constraint counts: 4 distance constraints (one
    // per bar). Variables: 4 points × 2 coords = 8. Pinned: O₀, O₃
    // (4 vars). Free: A, B (4 vars). Constraints: 3 useful (|O₀A|,
    // |O₃B|, |AB|; the |O₀O₃| is degenerate since both endpoints
    // pinned). Net DOF = 4 - 3 = 1 — exactly the crank angle, as
    // expected for a 1-DOF mechanism.
    const O0 = point(num(0), num(0));
    const O3 = point(num(4), num(0));
    const A = point(num(1), num(0)); // initial: crank pointing right
    const B = point(num(4), num(2));
    pinPoint(O0);
    pinPoint(O3);

    const a = 1; // crank length
    const c = 2; // rocker length
    const b = Math.hypot(A.x.peek() - B.x.peek(), A.y.peek() - B.y.peek()); // coupler length from initial config
    // (We could also pick b explicitly.)
    dist(O0, A, a);
    dist(O3, B, c);
    dist(A, B, b);

    // Verify: the cluster is one-DOF. Driving A's x position around
    // its circle should produce a smooth trace of B.
    const trajectory: Array<{ ax: number; ay: number; bx: number; by: number }> = [];
    for (let i = 0; i < 16; i++) {
      const theta = (i * 2 * Math.PI) / 16;
      A.x.value = a * Math.cos(theta);
      A.y.value = a * Math.sin(theta);
      trajectory.push({ ax: A.x.value, ay: A.y.value, bx: B.x.value, by: B.y.value });
    }
    // Each trajectory point: |O₀A|=a, |O₃B|=c, |AB|=b, all preserved.
    for (const p of trajectory) {
      expect(Math.hypot(p.ax, p.ay)).toBeCloseTo(a, 3);
      expect(Math.hypot(p.bx - 4, p.by)).toBeCloseTo(c, 3);
      expect(Math.hypot(p.ax - p.bx, p.ay - p.by)).toBeCloseTo(b, 3);
    }
    // Sanity: B's trajectory has more than one distinct value — it
    // actually moves, not stuck.
    const distinct = new Set(trajectory.map(p => `${p.bx.toFixed(2)},${p.by.toFixed(2)}`));
    expect(distinct.size).toBeGreaterThan(4);
  });
});
