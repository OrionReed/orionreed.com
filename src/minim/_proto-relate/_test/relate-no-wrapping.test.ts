// relate-no-wrapping.test.ts — first-class signal cells without wrappers.
//
// The point of these tests: `relate` accepts ANY signal directly as a
// cell — Num, Vec, Box, etc. — without `point()`-style wrapping or
// parent tracking. The runtime uses each value class's `packer`
// trait to translate between cells' typed values and the solver's
// flat state.

import { describe, expect, it } from "vitest";
import { dist, pinPoint } from "../constraints";
import { batch, num, vec } from "../index";
import { clusterSize, hardPin, relate } from "../relate";

describe("Cells are signals — no wrapping needed", () => {
  it("Num cells: pass directly", () => {
    const a = num(3);
    const b = num(4);
    const c = num(5);
    relate({
      cells: [a, b, c],
      // Residual receives typed values per cell — for Nums, numbers.
      residual: ([va, vb, vc], out) => {
        out[0] = (va as number) ** 2 + (vb as number) ** 2 - (vc as number) ** 2;
      },
      m: 1,
    });
    a.value = 6;
    expect(a.value ** 2 + b.value ** 2).toBeCloseTo(c.value ** 2);
  });

  it("Vec cells: pass directly, residual receives {x, y} per cell", () => {
    const A = vec(0, 0);
    const B = vec(5, 0);
    relate({
      cells: [A, B],
      residual: ([va, vb], out) => {
        const a = va as { x: number; y: number };
        const b = vb as { x: number; y: number };
        out[0] = Math.hypot(a.x - b.x, a.y - b.y) - 5;
      },
      m: 1,
    });
    A.value = { x: -3, y: 0 };
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(5, 4);
  });

  it("Mixed Num + Vec cells in same cluster", () => {
    const length = num(2);
    const A = vec(0, 0);
    const B = vec(2, 0);
    // Distance |AB| equals `length`.
    relate({
      cells: [A, B, length],
      residual: ([va, vb, vl], out) => {
        const a = va as { x: number; y: number };
        const b = vb as { x: number; y: number };
        out[0] = Math.hypot(a.x - b.x, a.y - b.y) - (vl as number);
      },
      m: 1,
    });
    // Drag length — points reflow. (length is user-pinned this batch.)
    length.value = 5;
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(5, 4);
    // Pin length so subsequent writes don't re-free it. Then drag A.
    hardPin(length, 5);
    A.value = { x: 0, y: 0 };
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(5, 4);
    expect(length.value).toBe(5);
  });

  it("dist() factory accepts Vec instances directly (no point() wrapper)", () => {
    const A = vec(0, 0);
    const B = vec(5, 0);
    dist(A, B, 5);
    A.value = { x: -3, y: 0 };
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(5, 4);
  });

  it("Equilateral triangle from three Vec cells, no wrappers", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    const C = vec(0.5, Math.sqrt(3) / 2);
    dist(A, B, 1);
    dist(B, C, 1);
    dist(C, A, 1);

    // Drag A; B and C reflow as a free rigid group with one rotation
    // DOF (which Newton picks via warm-start). Don't pinPoint(B):
    // pinning B would make A=(5,0) unreachable (|AB|=4 ≠ 1).
    A.value = { x: 5, y: 0 };
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(1, 3);
    expect(Math.hypot(B.value.x - C.value.x, B.value.y - C.value.y)).toBeCloseTo(1, 3);
    expect(Math.hypot(C.value.x - A.value.x, C.value.y - A.value.y)).toBeCloseTo(1, 3);
  });

  it("clusterSize counts Vec cells as one cell, not two", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    relate({
      cells: [A, B],
      residual: () => {},
      m: 0,
    });
    expect(clusterSize(A)).toBe(2); // 2 Vec cells, not 4 axes
  });

  it("Pinning a Vec via user write works without parent tracking", () => {
    const A = vec(0, 0);
    const B = vec(1, 0);
    dist(A, B, 1);
    // Both axes pinned in one batch via composite write.
    batch(() => {
      A.value = { x: 5, y: 0 };
    });
    expect(A.value.x).toBe(5);
    expect(A.value.y).toBe(0);
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(1, 4);
  });

  it("Hard-pin a Vec cell via per-axis pinPoint", () => {
    const A = vec(0, 0);
    const B = vec(5, 0);
    dist(A, B, 5);
    pinPoint(A); // hard-pins A.x and A.y
    // User write to A is silently overridden.
    A.value = { x: 999, y: 999 };
    expect(A.value.x).toBe(0);
    expect(A.value.y).toBe(0);
    // B reflects the constraint; |A-B|=5 still.
    expect(Math.hypot(A.value.x - B.value.x, A.value.y - B.value.y)).toBeCloseTo(5, 4);
  });
});

describe("Backward compat: per-axis Num cells via field lenses still work", () => {
  it("Num decomposition of a Vec, with parent tracking via point()", async () => {
    // For consumers who want individual axis cells (e.g. to drag
    // just the x of a point with a separate spring per axis), they
    // can still decompose. The point() helper bundles two Nums.
    const { point } = await import("../constraints");
    const ax = num(0);
    const ay = num(0);
    const bx = num(5);
    const by = num(0);
    dist(point(ax, ay), point(bx, by), 5);
    ax.value = -3;
    expect(Math.hypot(ax.value - bx.value, ay.value - by.value)).toBeCloseTo(5, 4);
  });
});

void hardPin;
