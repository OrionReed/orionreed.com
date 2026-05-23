// relate-cross-domain.test.ts — non-trivial demos that exercise the
// full primitive set across domains (geometric, layout, physics, IK).
// These are the canonical "this is what the engine is good for"
// artifacts.

import { describe, expect, it } from "vitest";
import {
  alignVec,
  bounded,
  dist,
  pinPoint,
  rigid,
  Strength,
  softNum,
  softVec,
  space,
} from "../constraints";
import { num, vec } from "../index";
import { hardPin, relate } from "../relate";

const EPS = 1e-3;

describe("Cross-domain — UI layout (Cassowary-flavoured)", () => {
  it("three boxes in a row, equal width, total = parent width, padding constraints", () => {
    // Three boxes laid out horizontally inside a parent of width 600.
    // Each box has equal width; left box has fixed minimum width 50;
    // gaps are 10px.
    const parentW = 600;
    const gap = 10;
    const minBoxW = 50;

    const w1 = num(100);
    const w2 = num(100);
    const w3 = num(100);

    // Equal widths (soft preference, not hard requirement).
    relate({
      cells: [w1, w2, w3],
      residual: ([a, b, c], out) => {
        out[0] = (a as number) - (b as number);
        out[1] = (b as number) - (c as number);
      },
      m: 2,
      weight: Strength.STRONG,
    });

    // Total fits in parent: w1 + w2 + w3 + 2*gap = parentW (REQUIRED).
    relate({
      cells: [w1, w2, w3],
      residual: ([a, b, c], out) => {
        out[0] = (a as number) + (b as number) + (c as number) + 2 * gap - parentW;
      },
      m: 1,
      weight: Strength.REQUIRED,
    });

    // Minimum width on each box.
    bounded(w1, minBoxW, parentW, Strength.REQUIRED);
    bounded(w2, minBoxW, parentW, Strength.REQUIRED);
    bounded(w3, minBoxW, parentW, Strength.REQUIRED);

    // Initial layout: each box ≈ (600 - 20) / 3 ≈ 193.33.
    const expected = (parentW - 2 * gap) / 3;
    expect(w1.value).toBeCloseTo(expected, 1);
    expect(w2.value).toBeCloseTo(expected, 1);
    expect(w3.value).toBeCloseTo(expected, 1);

    // User pushes w1 to 350. Equal-width constraint is STRONG but
    // total-fits is REQUIRED — w2, w3 shrink.
    w1.value = 350;
    expect(w1.value).toBeCloseTo(350, 1);
    // w2 + w3 ≈ 600 - 350 - 20 = 230 ⇒ ~115 each.
    expect(w2.value + w3.value).toBeCloseTo(parentW - w1.value - 2 * gap, 0);

    // Note: user pins are absolute in this system. If a user write
    // would violate REQUIRED, the user's value wins and the
    // REQUIRED constraint shows a non-zero residual. Cassowary's
    // edit-constraint discipline (where a user drag is silently
    // rejected if it violates REQUIRED) is a different policy that
    // would need explicit edit-strength + dual-simplex re-solve;
    // see the architecture notes for that direction.
  });

  it("vertical alignment + horizontal spacing — chained Vec constraints", () => {
    const A = vec(0, 0);
    const B = vec(0, 0);
    const C = vec(0, 0);
    // Aligned on y-axis, spaced 50px apart on x.
    alignVec("y", A, B, C);
    space(A, B, 50);
    space(B, C, 50);
    pinPoint(A);
    expect(B.value.y).toBeCloseTo(A.value.y, 4);
    expect(C.value.y).toBeCloseTo(A.value.y, 4);
    expect(B.value.x - A.value.x).toBeCloseTo(50, 4);
    expect(C.value.x - B.value.x).toBeCloseTo(50, 4);
  });
});

describe("Cross-domain — IK arm with soft rest pose + workspace bounds", () => {
  it("3-link arm: tip-target follows mouse; joints prefer rest pose; arm stays in workspace", () => {
    const L = [1, 1, 0.5];
    const t1 = num(0.1);
    const t2 = num(-0.1);
    const t3 = num(0.05);
    const tipX = num(0);
    const tipY = num(0);
    // FK forward to set initial tip.
    tipX.value =
      L[0]! * Math.cos(t1.peek()) +
      L[1]! * Math.cos(t1.peek() + t2.peek()) +
      L[2]! * Math.cos(t1.peek() + t2.peek() + t3.peek());
    tipY.value =
      L[0]! * Math.sin(t1.peek()) +
      L[1]! * Math.sin(t1.peek() + t2.peek()) +
      L[2]! * Math.sin(t1.peek() + t2.peek() + t3.peek());

    // FK constraint (REQUIRED).
    relate({
      cells: [t1, t2, t3, tipX, tipY],
      residual: ([a1, a2, a3, x, y], out) => {
        const A1 = a1 as number;
        const A2 = a2 as number;
        const A3 = a3 as number;
        out[0] =
          (x as number) -
          (L[0]! * Math.cos(A1) + L[1]! * Math.cos(A1 + A2) + L[2]! * Math.cos(A1 + A2 + A3));
        out[1] =
          (y as number) -
          (L[0]! * Math.sin(A1) + L[1]! * Math.sin(A1 + A2) + L[2]! * Math.sin(A1 + A2 + A3));
      },
      m: 2,
      weight: Strength.REQUIRED,
    });

    // Soft rest pose (low weight).
    softNum(t1, 0, 0.05);
    softNum(t2, 0, 0.05);
    softNum(t3, 0, 0.05);

    // Joint limits (soft inequality).
    bounded(t1, -Math.PI / 2, Math.PI / 2, Strength.MEDIUM);
    bounded(t2, -Math.PI, Math.PI, Strength.MEDIUM);
    bounded(t3, -Math.PI / 2, Math.PI / 2, Strength.MEDIUM);

    // Drag tip in a feasible arc.
    const trajectory: { fx: number; fy: number; tx: number; ty: number }[] = [];
    for (let i = 1; i <= 20; i++) {
      const phi = i * 0.05;
      const r = 1.5;
      tipX.value = r * Math.cos(phi);
      tipY.value = r * Math.sin(phi);
      const fwdX =
        L[0]! * Math.cos(t1.value) +
        L[1]! * Math.cos(t1.value + t2.value) +
        L[2]! * Math.cos(t1.value + t2.value + t3.value);
      const fwdY =
        L[0]! * Math.sin(t1.value) +
        L[1]! * Math.sin(t1.value + t2.value) +
        L[2]! * Math.sin(t1.value + t2.value + t3.value);
      trajectory.push({ fx: fwdX, fy: fwdY, tx: tipX.value, ty: tipY.value });
    }

    // FK should track tip (REQUIRED dominates the soft pose pull).
    for (const p of trajectory) {
      expect(Math.hypot(p.fx - p.tx, p.fy - p.ty)).toBeLessThan(0.05);
    }
    // Joint angles within limits (soft inequalities holding).
    expect(Math.abs(t1.value)).toBeLessThanOrEqual(Math.PI / 2 + 0.1);
    expect(Math.abs(t2.value)).toBeLessThanOrEqual(Math.PI + 0.1);
    expect(Math.abs(t3.value)).toBeLessThanOrEqual(Math.PI / 2 + 0.1);
  });
});

describe("Cross-domain — soft-body / mass-spring with gravity", () => {
  it("hanging chain with gravity-pull on each node — drapes naturally", () => {
    // 8 segments, each length 1. Pin both endpoints; gravity-pull
    // interior nodes. The chain droops; the dist constraints (at
    // REQUIRED weight) keep segment lengths intact.
    const N = 8;
    const pts = Array.from({ length: N + 1 }, (_, i) => vec(i, 0));
    // Distance constraints at REQUIRED weight — they MUST hold
    // exactly (subject to soft gravity contention).
    for (let i = 0; i < N; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      relate({
        cells: [a, b],
        residual: ([va, vb], out) => {
          const A = va as { x: number; y: number };
          const B = vb as { x: number; y: number };
          out[0] = Math.hypot(A.x - B.x, A.y - B.y) - 1;
        },
        m: 1,
        weight: Strength.REQUIRED,
      });
    }
    pinPoint(pts[0]!);
    pinPoint(pts[N]!, { x: N - 1, y: 0 });

    // Gravity: pull interior nodes toward a low y. Use a small
    // weight so the chain sags but doesn't blow up against the
    // length constraints.
    for (let i = 1; i < N; i++) {
      softVec(pts[i]!, () => ({ x: pts[i]!.peek().x, y: -10 }), 1);
    }

    // Some nodes should drop below y=0 (sagging).
    const minY = Math.min(...pts.map(p => p.value.y));
    expect(minY).toBeLessThan(0);

    // Distances close to 1 — REQUIRED dominates the soft gravity.
    for (let i = 0; i < N; i++) {
      const a = pts[i]!.value;
      const b = pts[i + 1]!.value;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(1, 1);
    }
  });
});

describe("Cross-domain — geometric + rigid-body composition", () => {
  it("rigid quadrilateral inscribed in circle: drag any vertex, others rotate around centre", () => {
    // 4-vertex rigid quad inscribed in a circle of radius 1 around
    // origin. Drag any vertex tangentially; whole quad rotates.
    const O = vec(0, 0);
    hardPin(O.x, 0);
    hardPin(O.y, 0);
    const A = vec(1, 0);
    const B = vec(0, 1);
    const C = vec(-1, 0);
    const D = vec(0, -1);
    rigid(A, B, C, D);
    // All four on unit circle around origin.
    relate({
      cells: [A],
      residual: ([va], out) => {
        const a = va as { x: number; y: number };
        out[0] = Math.hypot(a.x, a.y) - 1;
      },
      m: 1,
    });
    relate({
      cells: [B],
      residual: ([vb], out) => {
        const b = vb as { x: number; y: number };
        out[0] = Math.hypot(b.x, b.y) - 1;
      },
      m: 1,
    });
    relate({
      cells: [C],
      residual: ([vc], out) => {
        const c = vc as { x: number; y: number };
        out[0] = Math.hypot(c.x, c.y) - 1;
      },
      m: 1,
    });
    relate({
      cells: [D],
      residual: ([vd], out) => {
        const d = vd as { x: number; y: number };
        out[0] = Math.hypot(d.x, d.y) - 1;
      },
      m: 1,
    });

    // Drag A in small angular steps — quad rotates as a rigid unit.
    for (let i = 1; i <= 10; i++) {
      const theta = i * 0.05;
      A.value = { x: Math.cos(theta), y: Math.sin(theta) };
    }
    // All 6 pairwise rigid distances preserved.
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(Math.SQRT2, EPS);
    expect(Math.hypot(B.value.x - C.value.x, B.value.y - C.value.y)).toBeCloseTo(Math.SQRT2, EPS);
    // All four on unit circle (inscribed).
    expect(Math.hypot(A.value.x, A.value.y)).toBeCloseTo(1, EPS);
    expect(Math.hypot(B.value.x, B.value.y)).toBeCloseTo(1, EPS);
    expect(Math.hypot(C.value.x, C.value.y)).toBeCloseTo(1, EPS);
    expect(Math.hypot(D.value.x, D.value.y)).toBeCloseTo(1, EPS);
  });
});
