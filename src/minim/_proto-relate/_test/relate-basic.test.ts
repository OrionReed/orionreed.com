// Smoke tests for the relation primitive — pythagoras, equilateral
// triangle, soft-constraint chain. End-to-end through the engine.

import { describe, expect, it } from "vitest";
import { batch, num } from "../index";
import { clusterSize, relate } from "../relate";

describe("relate — pythagoras (single relation, 3 cells)", () => {
  it("starts satisfied when initial values satisfy the constraint", () => {
    const a = num(3);
    const b = num(4);
    const c = num(5);
    const py = relate({
      cells: [a, b, c],
      residual: ([a, b, c], out) => {
        out[0] = a! * a! + b! * b! - c! * c!;
      },
      m: 1,
    });
    // Read residual to flush; the constructor schedules an initial solve.
    void py.residual.value;
    expect(py.residual.value).toBeLessThan(1e-9);
    expect(py.satisfied.value).toBe(true);
  });

  it("solving snaps free cells into satisfaction when started inconsistent", () => {
    const a = num(3);
    const b = num(4);
    const c = num(0); // wildly wrong
    const py = relate({
      cells: [a, b, c],
      residual: ([a, b, c], out) => {
        out[0] = a! * a! + b! * b! - c! * c!;
      },
      m: 1,
    });
    void py.residual.value;
    // a, b stayed pinned by user (well, no user pin — initial solve
    // runs unpinned). All three are free; c gets adjusted.
    expect(py.residual.value).toBeLessThan(1e-6);
  });

  it("writing a triggers solve; b and c update to satisfy", () => {
    const a = num(3);
    const b = num(4);
    const c = num(5);
    const py = relate({
      cells: [a, b, c],
      residual: ([a, b, c], out) => {
        out[0] = a! * a! + b! * b! - c! * c!;
      },
      m: 1,
    });
    void py.residual.value;
    a.value = 6;
    void py.residual.value; // force flush
    // a stays at 6 (user-pinned). b and c reflowed to satisfy
    // 36 + b² = c².
    expect(a.value).toBe(6);
    expect(Math.abs(a.value ** 2 + b.value ** 2 - c.value ** 2)).toBeLessThan(1e-6);
  });

  it("writing a and b together (in a batch) pins both; c is solved", () => {
    const a = num(3);
    const b = num(4);
    const c = num(5);
    const py = relate({
      cells: [a, b, c],
      residual: ([a, b, c], out) => {
        out[0] = a! * a! + b! * b! - c! * c!;
      },
      m: 1,
    });
    void py.residual.value;
    // Two writes in one batch ⇒ both cells pinned for the single
    // post-batch solve. Outside a batch each write triggers its own
    // flush, with only one cell pinned per solve — the second write
    // would re-solve with the first cell free, drifting it away.
    batch(() => {
      a.value = 6;
      b.value = 8;
    });
    expect(a.value).toBe(6);
    expect(b.value).toBe(8);
    expect(Math.abs(c.value)).toBeCloseTo(10, 6);
  });
});

describe("relate — composition (two relations sharing cells form one cluster)", () => {
  it("equilateral triangle: three distance constraints over three points", () => {
    // Three 2D points represented as (x,y) Num pairs.
    const Ax = num(0);
    const Ay = num(0);
    const Bx = num(1);
    const By = num(0);
    const Cx = num(0.5);
    const Cy = num(1);

    const dist = (px: typeof Ax, py: typeof Ay, qx: typeof Bx, qy: typeof By, L: number) =>
      relate({
        cells: [px, py, qx, qy],
        residual: ([a, b, c, d], out) => {
          out[0] = Math.hypot(a! - c!, b! - d!) - L;
        },
        m: 1,
      });

    const rAB = dist(Ax, Ay, Bx, By, 1);
    const rBC = dist(Bx, By, Cx, Cy, 1);
    const rCA = dist(Cx, Cy, Ax, Ay, 1);

    void rAB.residual.value;
    void rBC.residual.value;
    void rCA.residual.value;
    expect(rAB.residual.value).toBeLessThan(1e-6);
    expect(rBC.residual.value).toBeLessThan(1e-6);
    expect(rCA.residual.value).toBeLessThan(1e-6);
    // The system has 3 DOF (6 vars, 3 constraints) so absolute
    // positions aren't determined; only mutual distances are. Check
    // those, not specific coordinates.
    expect(Math.hypot(Ax.value - Bx.value, Ay.value - By.value)).toBeCloseTo(1, 6);
    expect(Math.hypot(Bx.value - Cx.value, By.value - Cy.value)).toBeCloseTo(1, 6);
    expect(Math.hypot(Cx.value - Ax.value, Cy.value - Ay.value)).toBeCloseTo(1, 6);
  });

  it("dragging A in an equilateral triangle moves the whole figure", () => {
    const Ax = num(0);
    const Ay = num(0);
    const Bx = num(1);
    const By = num(0);
    const Cx = num(0.5);
    const Cy = num(Math.sqrt(3) / 2);

    const dist = (px: typeof Ax, py: typeof Ay, qx: typeof Bx, qy: typeof By, L: number) =>
      relate({
        cells: [px, py, qx, qy],
        residual: ([a, b, c, d], out) => {
          out[0] = Math.hypot(a! - c!, b! - d!) - L;
        },
        m: 1,
      });

    const rAB = dist(Ax, Ay, Bx, By, 1);
    const rBC = dist(Bx, By, Cx, Cy, 1);
    const rCA = dist(Cx, Cy, Ax, Ay, 1);
    void rAB.residual.value; // initial solve

    // Drag A to (5, 0) atomically (batch). Pinned: Ax, Ay. Free: B, C.
    batch(() => {
      Ax.value = 5;
      Ay.value = 0;
    });

    // All three distances should still be 1.
    expect(Math.hypot(Ax.value - Bx.value, Ay.value - By.value)).toBeCloseTo(1, 4);
    expect(Math.hypot(Bx.value - Cx.value, By.value - Cy.value)).toBeCloseTo(1, 4);
    expect(Math.hypot(Cx.value - Ax.value, Cy.value - Ay.value)).toBeCloseTo(1, 4);
  });

  it("relations sharing cells form one cluster (instrumentation)", () => {
    const a = num(0);
    const b = num(0);
    const c = num(0);
    relate({
      cells: [a, b],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    relate({
      cells: [b, c],
      residual: ([x, y], out) => {
        out[0] = x! - y!;
      },
      m: 1,
    });
    // Both relations now in one cluster of cells {a, b, c}.
    expect(clusterSize(a)).toBe(3);
    expect(clusterSize(b)).toBe(3);
    expect(clusterSize(c)).toBe(3);
  });
});
