// relate-hard-inequalities.test.ts — true-hard inequality
// satisfaction via the cluster solver's escalation outer loop.
//
// Background: the standard penalty-form `leq(a, b)` adds a soft
// term `max(0, a - b)²` to the LSQ objective, weighted by `weight`.
// That penalty COMPETES with other terms — e.g. a `softNum(a, 7)`
// term might pull `a` past `b` if its weight is comparable.
//
// The `hard` flag wraps the cluster's solve in an outer escalation
// loop: after Newton converges, any hard relation whose unweighted
// residual exceeds `tol × 10` gets its effective weight bumped 10×.
// Repeated up to 5 times. After the cluster finishes, base weights
// are restored so the next solve sees the user's declared weight.
//
// This is a pragmatic substitute for active-set or KKT-style hard
// inequality satisfaction. It works well for non-contradictory
// hard sets; contradictory sets degrade to LSQ best-fit (residual
// reported via cluster health).

import { describe, expect, it } from "vitest";
import { bounded, geq, leq, softNum } from "../constraints";
import { num } from "../index";
import { hardPin } from "../relate";

describe("Hard inequality constraints", () => {
  it("hard `leq(a, b)` clamps when soft pulls past the bound", () => {
    // a wants to be at 10 (soft, weight 1); b is hard-pinned at 5.
    // a ≤ b is hard. So a should clip to 5.
    const a = num(0);
    const b = num(5);
    hardPin(b, 5);
    softNum(a, 10, 1);
    leq(a, b, { hard: true });
    expect(a.value).toBeLessThanOrEqual(5 + 1e-3);
    expect(a.value).toBeGreaterThan(4); // still pulled toward 10, hits ceiling
  });

  it("hard `bounded(x, 0, 10)` clips both ways across separate clusters", () => {
    // First cluster: pull below.
    {
      const x = num(0);
      bounded(x, 0, 10, { hard: true });
      softNum(x, -50, 1);
      expect(x.value).toBeGreaterThanOrEqual(-1e-2);
    }
    // Second cluster: pull above.
    {
      const x = num(0);
      bounded(x, 0, 10, { hard: true });
      softNum(x, 100, 1);
      expect(x.value).toBeLessThanOrEqual(10 + 1e-2);
    }
  });

  it("hard pair: `geq(a, lo)` AND `leq(a, hi)` non-contradictory", () => {
    const a = num(50);
    const lo = num(10);
    const hi = num(20);
    hardPin(lo, 10);
    hardPin(hi, 20);
    softNum(a, 0, 1); // pull below
    geq(a, lo, { hard: true });
    leq(a, hi, { hard: true });
    // Should clamp into [lo, hi] tightly, picking the lo end since
    // the soft pull is towards 0.
    expect(a.value).toBeGreaterThanOrEqual(10 - 1e-2);
    expect(a.value).toBeLessThanOrEqual(20 + 1e-2);
    expect(a.value).toBeLessThan(15); // soft pulls toward lo
  });

  it("contradictory hard set degrades gracefully (no NaN, no freeze)", () => {
    // a ≤ 3 AND a ≥ 7: infeasible. LSQ best-fit puts a near 5.
    // Solver must NOT freeze, NaN, or escalate to overflow.
    const a = num(0);
    const lo = num(7);
    const hi = num(3);
    hardPin(lo, 7);
    hardPin(hi, 3);
    geq(a, lo, { hard: true });
    leq(a, hi, { hard: true });
    expect(Number.isFinite(a.value)).toBe(true);
    expect(a.value).toBeGreaterThan(2.5);
    expect(a.value).toBeLessThan(7.5);
  });

  it("soft `leq` (no hard flag) — penalty is defeated by stronger pull", () => {
    // Confirms the inverse case: without `hard`, a stronger soft
    // pull WILL violate the inequality. This justifies the hard flag.
    const a = num(0);
    const b = num(5);
    hardPin(b, 5);
    softNum(a, 100, 100); // strong pull to 100
    leq(a, b); // weak default, NOT hard
    // Without hard, a settles in (5, 100) — penalty compromised.
    expect(a.value).toBeGreaterThan(5);
  });

  it("hard `leq` survives strong contention up to its escalation budget", () => {
    // With soft pull weight 1e6 and leq base weight MEDIUM=1e3,
    // 5 escalations bring leq to 1e8 — 100× the soft. LSQ
    // equilibrium then sits very close to (but slightly above) the
    // boundary at 5. This documents the limit of weight-escalation:
    // it's bounded, so contention can still bias the solution by
    // a small amount. The right tool for "exact satisfaction or
    // bust" is active-set / KKT, not penalty methods.
    const a = num(0);
    const b = num(5);
    hardPin(b, 5);
    softNum(a, 100, 1e6); // very strong pull to 100
    leq(a, b, { hard: true });
    // Hard escalation drives a to within ~1 unit of 5 — far closer
    // than soft-only, which would settle near 100.
    expect(a.value).toBeLessThan(7);
    expect(a.value).toBeGreaterThanOrEqual(5);
    // Soft-only (no hard) for comparison:
    const a2 = num(0);
    const b2 = num(5);
    hardPin(b2, 5);
    softNum(a2, 100, 1e6);
    leq(a2, b2); // not hard
    // Without escalation, leq is overwhelmed.
    expect(a2.value).toBeGreaterThan(50);
  });

  it("hard escalation doesn't poison subsequent solves (weights restored)", () => {
    // After a cluster solve escalates a hard relation's weight, the
    // base weight is restored. Subsequent solves use base weight.
    const a = num(0);
    const b = num(5);
    hardPin(b, 5);
    leq(a, b, { hard: true });
    softNum(a, 100, 1);

    const after1 = a.value;
    expect(after1).toBeLessThanOrEqual(5 + 1e-2);

    // Re-solve via a no-op write through hardPin update.
    hardPin(b, 5)();
    hardPin(b, 5);
    expect(a.value).toBeLessThanOrEqual(5 + 1e-2);
    expect(Math.abs(a.value - after1)).toBeLessThan(1e-2);
  });
});
