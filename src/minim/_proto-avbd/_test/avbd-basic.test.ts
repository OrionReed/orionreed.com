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
  clamp,
  distance,
  eq,
  lensNum,
  num,
  softTarget,
  Solver,
  spring,
  vec,
} from "../index";

describe("AVBD basic — single constraint correctness", () => {
  it("hard equality between two Num cells", () => {
    const a = num(3);
    const b = num(7);
    const s = new Solver({ iterations: 10 });
    s.addCell(a);
    s.addCell(b);
    eq(s, a, b);
    s.step();
    expect(s.residualNorm()).toBeLessThan(1e-3);
    expect(Math.abs(a.value - b.value)).toBeLessThan(1e-3);
  });

  it("hard equality with one cell pinned (kinematic)", () => {
    const a = num(3);
    const b = num(0);
    a.mass = 0; // pin a in place
    const s = new Solver();
    s.addCell(a);
    s.addCell(b);
    eq(s, a, b);
    s.step();
    expect(a.value).toBe(3); // never moved
    expect(Math.abs(b.value - 3)).toBeLessThan(1e-3);
  });

  it("Num lens b = 2a, with a pinned", () => {
    const a = num(4);
    const b = num(0);
    a.mass = 0;
    const s = new Solver({ iterations: 10 });
    s.addCell(a);
    s.addCell(b);
    lensNum(s, a, b, x => 2 * x);
    s.step();
    expect(b.value).toBeCloseTo(8, 3);
  });

  it("Num lens b = 2a, with b pinned (back-propagation via dual)", () => {
    const a = num(0);
    const b = num(10);
    b.mass = 0;
    const s = new Solver({ iterations: 30 });
    s.addCell(a);
    s.addCell(b);
    lensNum(s, a, b, x => 2 * x);
    s.step();
    // 10 = 2a → a = 5. AVBD should converge.
    expect(a.value).toBeCloseTo(5, 3);
  });

  it("distance constraint with one endpoint pinned, drag the other", () => {
    const a = vec(0, 0);
    const b = vec(1, 0);
    a.mass = 0; // anchor a
    const s = new Solver({ iterations: 20 });
    s.addCell(a);
    s.addCell(b);
    distance(s, a, b, 5); // |a - b| should be 5
    s.step();
    s.step();
    s.step();
    s.step();
    s.step();
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    expect(Math.hypot(dx, dy)).toBeCloseTo(5, 2);
  });

  it("clamp(x, 0, 10) — pull below clips to 0", () => {
    const x = num(5);
    const s = new Solver({ iterations: 10 });
    s.addCell(x);
    clamp(s, x, 0, 10);
    softTarget(s, x, [-50], 10); // pull toward -50
    s.step();
    s.step();
    s.step();
    expect(x.value).toBeGreaterThanOrEqual(-0.5);
    expect(x.value).toBeLessThan(1.0); // pulled hard against the bound
  });

  it("clamp(x, 0, 10) — pull above clips to 10", () => {
    const x = num(5);
    const s = new Solver({ iterations: 10 });
    s.addCell(x);
    clamp(s, x, 0, 10);
    softTarget(s, x, [100], 10);
    s.step();
    s.step();
    s.step();
    expect(x.value).toBeLessThanOrEqual(10.5);
    expect(x.value).toBeGreaterThan(9.0);
  });

  it("soft spring stretches under conflicting pin", () => {
    // Spring of rest 1, soft stiffness 10 between two Vecs;
    // pin one at origin and the other at distance 5 → spring stretches
    // and exerts a force, but doesn't fully snap to rest.
    const a = vec(0, 0);
    const b = vec(5, 0);
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
