// avbd-basic.test.ts — sanity checks on each constraint type.
//
// Smallest possible scenarios for each force, verifying:
//   - Constraint is satisfied at convergence (residual ≤ tol).
//   - Pin priority works as expected (kinematic cells stay put).
//   - Inequalities clamp correctly.
//   - Soft constraints behave like springs.
//
// These don't push performance — they're correctness scaffolding.

import { describe, expect, it } from "vitest";
import {
  Cell,
  clamp,
  distance,
  eq,
  lensNum,
  pin,
  softTarget,
  Solver,
  spring,
} from "../index";

describe("AVBD basic — single constraint correctness", () => {
  it("hard equality between two Num cells", () => {
    const a = new Cell(1, [3]);
    const b = new Cell(1, [7]);
    const s = new Solver({ iterations: 10 });
    s.addCell(a);
    s.addCell(b);
    eq(s, a, b);
    s.step();
    expect(s.residualNorm()).toBeLessThan(1e-3);
    expect(Math.abs(a.position[0]! - b.position[0]!)).toBeLessThan(1e-3);
  });

  it("hard equality with one cell pinned (kinematic)", () => {
    const a = new Cell(1, [3]);
    const b = new Cell(1, [0]);
    a.mass = 0; // pin a in place
    const s = new Solver();
    s.addCell(a);
    s.addCell(b);
    eq(s, a, b);
    s.step();
    expect(a.position[0]!).toBe(3); // never moved
    expect(Math.abs(b.position[0]! - 3)).toBeLessThan(1e-3);
  });

  it("Num lens b = 2a, with a pinned", () => {
    const a = new Cell(1, [4]);
    const b = new Cell(1, [0]);
    a.mass = 0;
    const s = new Solver({ iterations: 10 });
    s.addCell(a);
    s.addCell(b);
    lensNum(s, a, b, x => 2 * x);
    s.step();
    expect(b.position[0]!).toBeCloseTo(8, 3);
  });

  it("Num lens b = 2a, with b pinned (back-propagation via dual)", () => {
    const a = new Cell(1, [0]);
    const b = new Cell(1, [10]);
    b.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(a);
    s.addCell(b);
    lensNum(s, a, b, x => 2 * x);
    s.step();
    // 10 = 2a → a = 5. AVBD should converge.
    expect(a.position[0]!).toBeCloseTo(5, 3);
  });

  it("distance constraint with one endpoint pinned, drag the other", () => {
    const a = new Cell(2, [0, 0]);
    const b = new Cell(2, [1, 0]);
    a.mass = 0; // anchor a
    const s = new Solver({ iterations: 20 });
    s.addCell(a);
    s.addCell(b);
    distance(s, a, b, 5); // |a - b| should be 5
    s.step();
    s.step(); // a couple of steps to converge from initial guess
    s.step();
    s.step();
    s.step();
    const dx = b.position[0]! - a.position[0]!;
    const dy = b.position[1]! - a.position[1]!;
    expect(Math.hypot(dx, dy)).toBeCloseTo(5, 2);
  });

  it("clamp(x, 0, 10) — pull below clips to 0", () => {
    const x = new Cell(1, [5]);
    const s = new Solver({ iterations: 10 });
    s.addCell(x);
    clamp(s, x, 0, 10);
    softTarget(s, x, [-50], 10); // pull toward -50
    s.step();
    s.step();
    s.step();
    expect(x.position[0]!).toBeGreaterThanOrEqual(-0.5);
    expect(x.position[0]!).toBeLessThan(1.0); // pulled hard against the bound
  });

  it("clamp(x, 0, 10) — pull above clips to 10", () => {
    const x = new Cell(1, [5]);
    const s = new Solver({ iterations: 10 });
    s.addCell(x);
    clamp(s, x, 0, 10);
    softTarget(s, x, [100], 10);
    s.step();
    s.step();
    s.step();
    expect(x.position[0]!).toBeLessThanOrEqual(10.5);
    expect(x.position[0]!).toBeGreaterThan(9.0);
  });

  it("soft spring stretches under conflicting pin", () => {
    // Spring of rest 1, soft stiffness 10 between two Vecs;
    // pin one at origin and the other at distance 5 → spring stretches
    // and exerts a force, but doesn't fully snap to rest.
    const a = new Cell(2, [0, 0]);
    const b = new Cell(2, [5, 0]);
    a.mass = 0;
    b.mass = 0; // both pinned for this test; spring just reports residual
    const s = new Solver({ iterations: 5 });
    s.addCell(a);
    s.addCell(b);
    const f = spring(s, a, b, 1, 10);
    s.step();
    // Both pinned → constraint can't be satisfied; residual reports
    // the violation magnitude.
    expect(Math.abs(f.C[0]!)).toBeCloseTo(4, 1); // |5 - 1| = 4
  });
});
