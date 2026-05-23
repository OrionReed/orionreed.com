// relate-clamp.test.ts — `clamp(x, lo, hi)` as a closed-form hard
// inequality. The relation has both:
//   - a fast-path that projects out-of-range pinned values onto
//     the boundary (zero Newton iters);
//   - a penalty residual that keeps a FREE x in range when other
//     relations are dragging it (LSQ + hard escalation).
//
// This is the prototype of "hard inequality with known projection
// → bypass Newton". Same idea generalises to wraparound (modular
// arithmetic), snap-to-grid, normalise-to-unit-vector, etc.

import { describe, expect, it } from "vitest";
import { clamp, leq, lensNum, softNum } from "../constraints";
import { num } from "../index";
import { clusterHealth, hardPin } from "../relate";

describe("clamp — closed-form hard range constraint", () => {
  it("user write below lo: clipped to lo, no Newton", () => {
    const x = num(5);
    clamp(x, 0, 10);
    x.value = -3;
    expect(x.value).toBe(0);
    expect(clusterHealth(x)!.peek().iters).toBe(0);
  });

  it("user write above hi: clipped to hi, no Newton", () => {
    const x = num(5);
    clamp(x, 0, 10);
    x.value = 17;
    expect(x.value).toBe(10);
    expect(clusterHealth(x)!.peek().iters).toBe(0);
  });

  it("user write in range: passes through unchanged", () => {
    const x = num(5);
    clamp(x, 0, 10);
    x.value = 7;
    expect(x.value).toBe(7);
    expect(clusterHealth(x)!.peek().iters).toBe(0);
  });

  it("multiple consecutive writes are each clamped independently", () => {
    const x = num(0);
    clamp(x, 0, 10);
    x.value = 100;
    expect(x.value).toBe(10);
    x.value = -50;
    expect(x.value).toBe(0);
    x.value = 5;
    expect(x.value).toBe(5);
  });

  it("clamp + lens chain: pin source, derive through lens, clip at end", () => {
    // a — lens → b ∈ [0, 100]. Pinning a high value derives b high,
    // which then gets clipped.
    const a = num(2);
    const b = num(20); // = 10*a
    lensNum(
      a,
      b,
      x => 10 * x,
      y => y / 10,
    );
    clamp(b, 0, 100);

    a.value = 15; // → b would be 150 → clamped to 100.
    expect(a.value).toBe(15);
    expect(b.value).toBe(100);
    expect(clusterHealth(a)!.peek().iters).toBe(0);

    a.value = 3; // → b = 30, in range.
    expect(b.value).toBe(30);

    a.value = -50; // → b = -500 → clamped to 0.
    expect(b.value).toBe(0);
  });

  it("clamp dominates a soft pull (penalty residual + hard escalation)", () => {
    // x has a soft pull to 100 (weight WEAK=1). clamp(x, 0, 10) is
    // hard. With escalation, clamp wins.
    const x = num(0);
    clamp(x, 0, 10);
    softNum(x, 100, 1);
    // No user write — initial solve runs once. x's only pin is the
    // soft pull (which isn't a pin, just an LSQ term). So Newton
    // pushes x toward 100, clamp residual kicks in, hard escalation
    // brings x close to 10.
    expect(x.value).toBeLessThanOrEqual(10 + 0.5);
    expect(x.value).toBeGreaterThan(5); // soft pulls past 5 at least
  });

  it("lens chain → clamp at end: derivation then projection", () => {
    // a — lens → b (b = 2a). clamp(b, 0, 5).
    // Drag a high; lens derives b=20; clamp clips to 5.
    // Lens then has unsatisfied residual (b ≠ 2a) — reported via
    // cluster.health but the cell values reflect the user's
    // priority: source set, lens projection, clamp boundary.
    const a = num(2);
    const b = num(4);
    lensNum(
      a,
      b,
      x => 2 * x,
      y => y / 2,
    );
    clamp(b, 0, 5);
    a.value = 10;
    expect(a.value).toBe(10); // user pin
    expect(b.value).toBe(5); // lens derived 20, clamp clipped to 5
    // Re-derive direction: a=1 → b=2, in range, no clamping.
    a.value = 1;
    expect(b.value).toBeCloseTo(2);
  });

  it("hard-pinned cell defeats clamp (hardPin > clamp)", () => {
    // hardPin always wins over clamp because clamp's fastPath only
    // fires on cells that AREN'T already in `fixed` (hard-pinned).
    const x = num(5);
    clamp(x, 0, 10);
    hardPin(x, 50); // out of range, but hard wins
    expect(x.value).toBe(50);
    // clamp's residual will report violation via cluster.health.
    const h = clusterHealth(x)!.peek();
    expect(h.residual).toBeGreaterThan(0);
  });

  it("two clamps on same cell: intersection wins", () => {
    const x = num(0);
    clamp(x, 0, 10);
    clamp(x, 5, 20);
    // Effective range: [5, 10]. Writing 100 → first clamp says 10,
    // second clamp says 10 too. Writing 0 → first says 0, second
    // says 5. Both fastPaths run in the peeling iteration; final
    // value depends on iteration order, but with the `fixed.has`
    // guard, the FIRST one that fires wins for that pass. Iteration
    // converges to the tightest bound.
    x.value = 100;
    expect(x.value).toBeLessThanOrEqual(10);
    expect(x.value).toBeGreaterThanOrEqual(5);
    x.value = -10;
    expect(x.value).toBeLessThanOrEqual(10);
    expect(x.value).toBeGreaterThanOrEqual(5);
  });

  it("composes with leq: clamp + leq give a tighter feasible region", () => {
    // x clamped to [0, 100], plus leq(x, b) where b is a free cell.
    // Drag b to 5: leq forces x ≤ 5 (penalty), clamp keeps x ≥ 0.
    const x = num(50);
    const b = num(50);
    clamp(x, 0, 100);
    leq(x, b, { hard: true });

    b.value = 5;
    // x should land in [0, 5] (clamp lo, leq hi via b).
    expect(x.value).toBeGreaterThanOrEqual(-1e-2);
    expect(x.value).toBeLessThanOrEqual(5 + 1e-2);
  });
});
