// cluster-basic.test.ts — verify the write-attribution model.

import { describe, expect, it, vi } from "vitest";
import { batch, effect, num, vec } from "../../signals";
import { Cluster, distance, eq, leq, lensNum } from "../index";

describe("Cluster (writeBack) — basic correctness", () => {
  it("eq: pinned a, write a → b matches", () => {
    const c = new Cluster({ iterations: 10 });
    const a = num(3);
    const b = num(7);
    eq(c, a, b);
    c.pin(a);
    a.value = 5;
    expect(b.value).toBeCloseTo(5, 2);
  });

  it("distance: pinned a, drag → b at distance 5", () => {
    const c = new Cluster({ iterations: 20 });
    const a = vec(0, 0);
    const b = vec(1, 0);
    distance(c, a, b, 5);
    c.pin(a);
    a.value = { x: 0.001, y: 0 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(5, 1);
  });

  it("lensNum: pin b, write b → a back-propagates to b/2", () => {
    const c = new Cluster({ iterations: 30 });
    const a = num(0);
    const b = num(10);
    lensNum(c, a, b, x => 2 * x);
    c.pin(b);
    b.value = 10.0001;
    expect(a.value).toBeCloseTo(5, 1);
  });

  it("leq: a above b is pulled down", () => {
    const c = new Cluster({ iterations: 30 });
    const a = num(5);
    const b = num(3);
    leq(c, a, b);
    c.pin(b);
    b.value = 3.0001;
    expect(a.value).toBeLessThanOrEqual(b.value + 1e-2);
  });
});

describe("Cluster (writeBack) — structural single-fire", () => {
  it("one user write = one solver step (NOT two)", () => {
    const c = new Cluster({ iterations: 20 });
    const a = num(0);
    const b = num(0);
    eq(c, a, b);
    c.pin(a);
    // Trigger initial run via a write.
    a.value = 1;
    const stepSpy = vi.spyOn(c.solver, "step");

    a.value = 5;
    // Single solve. The cluster's writeBack to b excludes the
    // cluster effect from propagation, so it doesn't re-fire.
    expect(stepSpy).toHaveBeenCalledTimes(1);
    expect(b.value).toBeCloseTo(5, 1);

    stepSpy.mockRestore();
  });

  it("batch coalesces multiple writes; cluster runs once", () => {
    const c = new Cluster({ iterations: 20 });
    const a = num(0);
    const b = num(0);
    eq(c, a, b);
    c.pin(a);
    a.value = 1; // initial run
    const stepSpy = vi.spyOn(c.solver, "step");

    batch(() => {
      a.value = 2;
      a.value = 3;
      a.value = 4;
    });
    expect(stepSpy).toHaveBeenCalledTimes(1);
    expect(b.value).toBeCloseTo(4, 1);

    stepSpy.mockRestore();
  });

  it("subscriber sees post-solve value via standard effect()", () => {
    const c = new Cluster({ iterations: 20 });
    const a = num(3);
    const b = num(7);
    eq(c, a, b);
    c.pin(a);

    const observed: number[] = [];
    const dispose = effect(() => {
      observed.push(b.value);
    });
    expect(observed).toEqual([7]);

    a.value = 5;
    // The cluster's writeBack to b notifies b's other subs (the
    // user's effect) but not the cluster itself. The user's effect
    // re-runs and reads the solved value.
    expect(observed[observed.length - 1]).toBeCloseTo(5, 1);
    dispose();
  });
});

describe("Cluster (writeBack) — lens composition", () => {
  // Lens composition works transparently: the cluster reads
  // `a.x.value` (through the lens fwd) and writes `a.x.value = X`
  // via writeBack (through the lens bwd → writes parent →
  // propagates normally). Nothing about the lens is replaced.

  it("eq(a.x, b.x) with parent write propagates correctly", () => {
    const c = new Cluster({ iterations: 30 });
    const a = vec(0, 0);
    const b = vec(5, 5);
    eq(c, a.x, b.x);
    c.pin(a.x);
    a.value = { x: 3, y: 0 };
    expect(b.value.x).toBeCloseTo(3, 1);
    expect(b.value.y).toBeCloseTo(5, 1); // y untouched
  });

  it("eq(a.x, b.x) with lens-child write back-propagates", () => {
    const c = new Cluster({ iterations: 30 });
    const a = vec(0, 0);
    const b = vec(5, 5);
    eq(c, a.x, b.x);
    c.pin(a.x);
    a.x.value = 7;
    expect(a.value.x).toBeCloseTo(7, 1);
    expect(b.value.x).toBeCloseTo(7, 1);
  });
});

describe("Cluster — numerical robustness", () => {
  it("aggressive random drag stays finite (no NaN poisoning)", async () => {
    const { distance, perpendicular } = await import("../index");
    const c = new Cluster({ iterations: 8 });
    const A = vec(0, 0);
    const B = vec(100, 0);
    const C = vec(100, 60);
    const D = vec(180, 60);
    distance(c, A, B, 100);
    distance(c, B, C, 60);
    distance(c, C, D, 80);
    // Intentionally use the duplicated-cell form: this used to feed
    // NaN through `solveSPD` whenever the local LHS went rank-
    // deficient. The guard in `_primalSweep` should keep positions
    // finite regardless.
    perpendicular(c, A, B, B, C);
    c.pin(A);

    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    for (let i = 0; i < 200; i++) {
      const ang = rand() * Math.PI * 2;
      const r = 50 + rand() * 200;
      A.value = { x: Math.cos(ang) * r, y: Math.sin(ang) * r };
    }
    for (const sig of [A, B, C, D]) {
      expect(Number.isFinite(sig.value.x)).toBe(true);
      expect(Number.isFinite(sig.value.y)).toBe(true);
    }
  });
});

describe("Cluster — constraint lifecycle", () => {
  it("force.dispose() removes the constraint at the next solve", () => {
    const c = new Cluster({ iterations: 20 });
    const a = num(0);
    const b = num(0);
    const link = eq(c, a, b);
    c.pin(a);
    a.value = 5;
    expect(b.value).toBeCloseTo(5, 2);

    link.dispose();
    c.update();
    a.value = 9;
    expect(b.value).toBeCloseTo(5, 1); // b stays put — no longer linked
  });

  it("cluster.update() forces a solve without a signal write", () => {
    const c = new Cluster({ iterations: 20 });
    const a = vec(0, 0);
    const b = vec(1, 0);
    const link = distance(c, a, b, 3);
    c.pin(a);
    a.value = { x: 0.0001, y: 0 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(3, 1);

    link.dispose();
    c.update();
    expect(c.solver.forces.length).toBe(0);
  });
});
