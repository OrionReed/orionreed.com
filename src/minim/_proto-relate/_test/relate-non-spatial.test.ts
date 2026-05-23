// relate-non-spatial.test.ts — constraints over non-point cells.
//
// The relation runtime is polymorphic in cell type via the per-class
// `packer` trait. Anything with a packer can be a cell: Num (dim 1),
// Vec (dim 2), Box (dim 4), Color (dim 4). Constraints can mix them
// freely in a single cluster.
//
// This file demonstrates:
//   - Color cells with perceptual / gamut constraints
//   - Box cells with layout constraints (via the packer, no
//     decomposition needed)
//   - Probabilistic simplex via a Num vector summing to 1
//
// The point: the abstraction handles any structured numeric value,
// not just spatial points.

import { describe, expect, it } from "vitest";
import { num, rgb, vec } from "../index";
import { Box } from "../values/box";
import { Color } from "../values/color";
import type { Writable } from "../writable";
import { hardPin, relate, Strength } from "../relate";

const EPS = 1e-3;

describe("Color cells", () => {
  it("two colors equal in luminance: 0.299r + 0.587g + 0.114b", () => {
    const c1 = rgb(0.5, 0.5, 0.5);
    const c2 = rgb(0.8, 0.2, 0.1);
    relate({
      cells: [c1, c2],
      residual: ([va, vb], out) => {
        const a = va as { r: number; g: number; b: number; a: number };
        const b = vb as { r: number; g: number; b: number; a: number };
        const La = 0.299 * a.r + 0.587 * a.g + 0.114 * a.b;
        const Lb = 0.299 * b.r + 0.587 * b.g + 0.114 * b.b;
        out[0] = La - Lb;
      },
      m: 1,
    });
    // Drag c1 — c2 reflows to match luminance.
    c1.value = { r: 0.7, g: 0.3, b: 0.1, a: 1 };
    const La = 0.299 * c1.value.r + 0.587 * c1.value.g + 0.114 * c1.value.b;
    const Lb = 0.299 * c2.value.r + 0.587 * c2.value.g + 0.114 * c2.value.b;
    expect(La).toBeCloseTo(Lb, 4);
  });

  it("color stays in sRGB gamut even when soft constraints push out", () => {
    // The color is FREE; gamut constraint is REQUIRED; a soft pull
    // tries to drag it out of gamut. Solver lands at the gamut
    // boundary.
    const c = rgb(0.5, 0.5, 0.5);
    relate({
      cells: [c],
      residual: ([v], out) => {
        const cc = v as { r: number; g: number; b: number; a: number };
        out[0] = Math.max(0, -cc.r);
        out[1] = Math.max(0, -cc.g);
        out[2] = Math.max(0, -cc.b);
        out[3] = Math.max(0, -cc.a);
        out[4] = Math.max(0, cc.r - 1);
        out[5] = Math.max(0, cc.g - 1);
        out[6] = Math.max(0, cc.b - 1);
        out[7] = Math.max(0, cc.a - 1);
      },
      m: 8,
      weight: Strength.REQUIRED,
    });
    // Soft pull to out-of-gamut (1.5, -0.3, 0.5, 1).
    relate({
      cells: [c],
      residual: ([v], out) => {
        const cc = v as { r: number; g: number; b: number; a: number };
        out[0] = cc.r - 1.5;
        out[1] = cc.g + 0.3;
        out[2] = cc.b - 0.5;
        out[3] = cc.a - 1;
      },
      m: 4,
      weight: Strength.WEAK,
    });
    // r and g land at gamut boundary; b at 0.5 (in gamut already).
    expect(c.value.r).toBeLessThanOrEqual(1.01);
    expect(c.value.g).toBeGreaterThanOrEqual(-0.01);
    expect(c.value.b).toBeCloseTo(0.5, 2);
  });

  it("color tween: c3 = average of c1 and c2", () => {
    const c1 = rgb(0, 0, 0); // black
    const c2 = rgb(1, 1, 1); // white
    const c3 = rgb(0.5, 0.5, 0.5); // grey (target: avg of c1, c2)
    relate({
      cells: [c1, c2, c3],
      residual: ([va, vb, vc], out) => {
        const a = va as { r: number; g: number; b: number; a: number };
        const b = vb as { r: number; g: number; b: number; a: number };
        const c = vc as { r: number; g: number; b: number; a: number };
        out[0] = c.r - (a.r + b.r) / 2;
        out[1] = c.g - (a.g + b.g) / 2;
        out[2] = c.b - (a.b + b.b) / 2;
      },
      m: 3,
    });
    hardPin(c1 as Writable<Color>, { r: 0.2, g: 0.4, b: 0.8, a: 1 });
    hardPin(c2 as Writable<Color>, { r: 0.8, g: 0.6, b: 0.2, a: 1 });
    expect(c3.value.r).toBeCloseTo(0.5, 4);
    expect(c3.value.g).toBeCloseTo(0.5, 4);
    expect(c3.value.b).toBeCloseTo(0.5, 4);
  });
});

describe("Box cells (composite layout values)", () => {
  it("box B follows box A — same width", () => {
    const A = new Box({ x: 0, y: 0, w: 100, h: 50 }) as Writable<Box>;
    const B = new Box({ x: 200, y: 0, w: 80, h: 50 }) as Writable<Box>;
    relate({
      cells: [A, B],
      residual: ([va, vb], out) => {
        const a = va as { x: number; y: number; w: number; h: number };
        const b = vb as { x: number; y: number; w: number; h: number };
        out[0] = a.w - b.w;
      },
      m: 1,
    });
    A.value = { x: 0, y: 0, w: 150, h: 50 };
    expect(B.value.w).toBeCloseTo(150, 4);
  });

  it("two boxes side by side: B.x = A.x + A.w + gap", () => {
    const A = new Box({ x: 0, y: 0, w: 100, h: 50 }) as Writable<Box>;
    const B = new Box({ x: 0, y: 0, w: 100, h: 50 }) as Writable<Box>;
    relate({
      cells: [A, B],
      residual: ([va, vb], out) => {
        const a = va as { x: number; y: number; w: number; h: number };
        const b = vb as { x: number; y: number; w: number; h: number };
        out[0] = b.x - (a.x + a.w + 10);
      },
      m: 1,
    });
    hardPin(A as Writable<Box>, { x: 50, y: 0, w: 100, h: 50 });
    expect(B.value.x).toBeCloseTo(50 + 100 + 10, 4);
  });
});

describe("Probability simplex (vector of Nums summing to 1)", () => {
  it("three probabilities, p1 + p2 + p3 = 1", () => {
    const p1 = num(0.5);
    const p2 = num(0.3);
    const p3 = num(0.1);
    relate({
      cells: [p1, p2, p3],
      residual: ([a, b, c], out) => {
        out[0] = (a as number) + (b as number) + (c as number) - 1;
      },
      m: 1,
      weight: Strength.REQUIRED,
    });
    // Initial sum = 0.9; after solve, sum should be 1.
    expect(p1.value + p2.value + p3.value).toBeCloseTo(1, 4);
    // Drag p1 to 0.6 — others reflow proportionally.
    p1.value = 0.6;
    expect(p1.value).toBeCloseTo(0.6, 4);
    expect(p1.value + p2.value + p3.value).toBeCloseTo(1, 4);
  });

  it("probability simplex with non-negativity (p_i ≥ 0)", () => {
    const p1 = num(0.6);
    const p2 = num(0.3);
    const p3 = num(0.1);
    relate({
      cells: [p1, p2, p3],
      residual: ([a, b, c], out) => {
        out[0] = (a as number) + (b as number) + (c as number) - 1;
      },
      m: 1,
      weight: Strength.REQUIRED,
    });
    // Each ≥ 0.
    relate({
      cells: [p1],
      residual: ([v], out) => {
        out[0] = Math.max(0, -(v as number));
      },
      m: 1,
      weight: Strength.REQUIRED,
    });
    relate({
      cells: [p2],
      residual: ([v], out) => {
        out[0] = Math.max(0, -(v as number));
      },
      m: 1,
      weight: Strength.REQUIRED,
    });
    relate({
      cells: [p3],
      residual: ([v], out) => {
        out[0] = Math.max(0, -(v as number));
      },
      m: 1,
      weight: Strength.REQUIRED,
    });
    // Drag p1 to 0.9 — sum-to-1 forces p2 + p3 = 0.1, but each ≥ 0.
    p1.value = 0.9;
    expect(p1.value + p2.value + p3.value).toBeCloseTo(1, 3);
    expect(p2.value).toBeGreaterThanOrEqual(-EPS);
    expect(p3.value).toBeGreaterThanOrEqual(-EPS);
  });
});

describe("Mixed-type cluster (Num + Vec + Color in one)", () => {
  it("pulse: a point's color brightens with its distance from origin", () => {
    const P = vec(0, 0);
    const c = rgb(0, 0, 0);
    const dist = num(0); // captured distance
    // dist = |P|
    relate({
      cells: [P, dist],
      residual: ([vp, vd], out) => {
        const p = vp as { x: number; y: number };
        out[0] = Math.hypot(p.x, p.y) - (vd as number);
      },
      m: 1,
    });
    // c.r = c.g = c.b = clamp(dist / 10, 0, 1) — intensity scales
    // with distance.
    relate({
      cells: [c, dist],
      residual: ([vc, vd], out) => {
        const cc = vc as { r: number; g: number; b: number; a: number };
        const target = Math.min(1, Math.max(0, (vd as number) / 10));
        out[0] = cc.r - target;
        out[1] = cc.g - target;
        out[2] = cc.b - target;
      },
      m: 3,
    });
    P.value = { x: 6, y: 8 }; // |P| = 10 → fully bright
    expect(dist.value).toBeCloseTo(10, 3);
    expect(c.value.r).toBeCloseTo(1, 2);
  });
});

void Color;
