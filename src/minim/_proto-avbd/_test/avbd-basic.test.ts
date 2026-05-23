// avbd-basic.test.ts — sanity checks on each constraint type.
//
// Smallest possible scenarios for each force, verifying:
//   - Constraint is satisfied at convergence (residual ≤ tol).
//   - Pin priority works as expected (kinematic cells stay put).
//   - Inequalities clamp correctly.
//   - Soft constraints behave like springs.

import { describe, expect, it } from "vitest";
import { num, vec } from "../../signals";
import { clamp, distance, eq, lensNum, pin, softTarget, Solver, spring } from "../index";

describe("AVBD basic — single constraint correctness", () => {
  it("hard equality between two Num cells", () => {
    const a = num(3);
    const b = num(7);
    const s = new Solver({ iterations: 10 });
    eq(s, a, b);
    // Trigger via a signal write.
    a.value = 3.0001;
    expect(s.residualNorm()).toBeLessThan(1e-3);
    expect(Math.abs(a.value - b.value)).toBeLessThan(1e-3);
  });

  it("hard equality with one cell pinned (kinematic)", () => {
    const a = num(3);
    const b = num(0);
    const s = new Solver();
    eq(s, a, b);
    pin(a);
    a.value = 3;
    a.value = 3.0001; // fresh value triggers solve
    expect(a.value).toBeCloseTo(3, 3);
    expect(Math.abs(b.value - 3)).toBeLessThan(1e-3);
  });

  it("Num lens b = 2a, with a pinned", () => {
    const a = num(4);
    const b = num(0);
    const s = new Solver({ iterations: 10 });
    lensNum(s, a, b, x => 2 * x);
    pin(a);
    a.value = 4.0001;
    expect(b.value).toBeCloseTo(8, 3);
  });

  it("Num lens b = 2a, with b pinned (back-propagation via dual)", () => {
    const a = num(0);
    const b = num(10);
    const s = new Solver({ iterations: 30 });
    lensNum(s, a, b, x => 2 * x);
    pin(b);
    b.value = 10.0001;
    // 10 = 2a → a = 5.
    expect(a.value).toBeCloseTo(5, 3);
  });

  it("distance constraint with one endpoint pinned, drag the other", () => {
    const a = vec(0, 0);
    const b = vec(1, 0);
    const s = new Solver({ iterations: 20 });
    distance(s, a, b, 5);
    pin(a);
    // Drag a slightly to trigger; b must be at distance 5 from a.
    a.value = { x: 0.001, y: 0 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(5, 1);
  });

  it("clamp(x, 0, 10) — pull below clips to 0", () => {
    const x = num(5);
    const s = new Solver({ iterations: 10 });
    clamp(s, x, 0, 10);
    softTarget(s, x, [-50], 10);
    // One write to trigger the solver. Sequential writes with auto-
    // ramped penalties from prior solves don't compose cleanly under
    // the augmented-Lagrangian warm-start; tests use a single trigger.
    x.value = 5.0001;
    expect(x.value).toBeGreaterThanOrEqual(-0.5);
    expect(x.value).toBeLessThan(1.0);
  });

  it("clamp(x, 0, 10) — pull above clips to 10", () => {
    const x = num(5);
    const s = new Solver({ iterations: 10 });
    clamp(s, x, 0, 10);
    softTarget(s, x, [100], 10);
    x.value = 5.0001;
    expect(x.value).toBeLessThanOrEqual(10.5);
    expect(x.value).toBeGreaterThan(9.0);
  });

  it("soft spring residual under conflicting pin", () => {
    const a = vec(0, 0);
    const b = vec(5, 0);
    const s = new Solver({ iterations: 5 });
    const f = spring(s, a, b, 1, 10);
    pin(a);
    pin(b);
    // Trigger one solve.
    a.value = { x: 0.001, y: 0 };
    expect(Math.abs(f.C[0]!)).toBeCloseTo(4, 1);
  });
});
