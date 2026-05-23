// cluster-lazy.test.ts — verifies the laziness properties that
// motivate this design.
//
// Properties:
//   1. **Solve runs on read, not on write.** N writes followed by
//      one read produce one solve.
//   2. **Solve runs at most once per dirty epoch.** Reading multiple
//      cluster signals after a single batch of writes solves once.
//   3. **Subscribers see post-solve values via standard effect()**.
//      No `preEffect` needed: writes propagate dirty → effects
//      re-run → effect reads → solve fires lazily inside the read.
//   4. **No solver runs at all if nothing reads.** Pure deferred.

import { describe, expect, it, vi } from "vitest";
import { batch, effect, num, vec } from "../../signals";
import { Cluster, distance, eq } from "../index";

describe("Cluster lazy-solve properties", () => {
  it("N writes + 1 read → 1 solve", () => {
    const c = new Cluster({ iterations: 20 });
    const a = num(0);
    const b = num(0);
    eq(c, a, b);
    c.pin(a);

    const stepSpy = vi.spyOn(c.solver, "step");

    a.value = 1;
    a.value = 2;
    a.value = 3;
    a.value = 4;
    a.value = 5;
    expect(stepSpy).toHaveBeenCalledTimes(0); // no solve on writes

    expect(b.value).toBeCloseTo(5, 1); // read triggers solve
    expect(stepSpy).toHaveBeenCalledTimes(1);

    stepSpy.mockRestore();
  });

  it("multiple reads after one write batch → 1 solve", () => {
    const c = new Cluster({ iterations: 20 });
    const a = num(0);
    const b = num(0);
    const cc = num(0);
    eq(c, a, b);
    eq(c, b, cc);
    c.pin(a);

    a.value = 7;
    const stepSpy = vi.spyOn(c.solver, "step");

    // Read all three; each one's getter checks dirty. First read
    // triggers solve and clears dirty; subsequent reads see clean.
    const av = a.value;
    const bv = b.value;
    const cv = cc.value;
    expect(stepSpy).toHaveBeenCalledTimes(1);

    expect(av).toBeCloseTo(7, 1);
    expect(bv).toBeCloseTo(7, 1);
    expect(cv).toBeCloseTo(7, 1);

    stepSpy.mockRestore();
  });

  it("write + no-read → no solve at all", () => {
    const c = new Cluster({ iterations: 20 });
    const a = num(0);
    const b = num(0);
    eq(c, a, b);
    c.pin(a);

    const stepSpy = vi.spyOn(c.solver, "step");

    a.value = 99;
    a.value = 100;
    a.value = 101;
    // Never read → never solved.
    expect(stepSpy).toHaveBeenCalledTimes(0);

    stepSpy.mockRestore();
  });

  it("subscribers see post-solve values via standard effect()", () => {
    const c = new Cluster({ iterations: 20 });
    const a = num(3);
    const b = num(7);
    eq(c, a, b);
    c.pin(a);

    const observed: number[] = [];
    const dispose = effect(() => {
      observed.push(b.value); // each effect run reads → triggers solve if dirty
    });
    expect(observed).toEqual([7]); // initial run

    a.value = 5;
    // Pulse increment fires propagate → effects re-run → reading b
    // triggers solve → effect sees the solved value.
    expect(observed[observed.length - 1]).toBeCloseTo(5, 1);

    dispose();
  });

  it("batch coalesces multiple writes into a single effect re-run", () => {
    const c = new Cluster({ iterations: 20 });
    const a = num(0);
    const b = num(0);
    eq(c, a, b);
    c.pin(a);

    let runs = 0;
    const dispose = effect(() => {
      b.value;
      runs++;
    });
    expect(runs).toBe(1);

    batch(() => {
      a.value = 1;
      a.value = 2;
      a.value = 3;
    });
    // Single batch → single effect re-run → single solve.
    expect(runs).toBe(2);
    expect(b.value).toBeCloseTo(3, 1);

    dispose();
  });

  it("write-then-read-self returns solved value (intentional semantic)", () => {
    // This is the trade-off documented in the cluster header:
    // writing a non-pinned signal and immediately reading it
    // returns the solved value, not what was written. To get the
    // "drag" semantic, pin the signal explicitly.
    const c = new Cluster({ iterations: 20 });
    const a = num(0);
    const b = num(10);
    eq(c, a, b);
    // No pin.
    a.value = 5;
    // a's read triggers solve. With both free, solver finds (a, b)
    // = midpoint. So a.value reads back as ~7.5, not 5.
    expect(a.value).toBeCloseTo(b.value, 1);
    expect(a.value).not.toBe(5);

    // To get drag semantics, explicitly pin:
    c.pin(a);
    a.value = 5;
    expect(a.value).toBeCloseTo(5, 1);
    expect(b.value).toBeCloseTo(5, 1);
  });
});

describe("Cluster lazy-solve — lens-derived signals (known gap)", () => {
  // **Known gap.** Binding `a.x` (a `_fusedOf`-style lens of `a`)
  // replaces its `getter` with the cluster's getter. That breaks
  // the dependency edge `a.x → a` that the lens used to provide,
  // so writes to `a` no longer propagate to `a.x`.
  //
  // The fix needs either:
  //   (A) Auto-bind ancestors when binding a lens and inject a
  //       synthetic `a.x = lens.fwd(a)` constraint into the
  //       solver (the `_proto-relate` approach).
  //   (B) The cluster's getter for a lens-bound signal calls the
  //       original `_fusedOf.fwd` to maintain the dependency
  //       edge, but solves through the cluster.
  //   (C) Disallow binding lens children — require users to bind
  //       roots only, then use solver-side lens forces.
  //
  // Out of scope for this first prototype. Documenting the gap.
  it.skip("eq(a.x, b.x) propagates writes through the lens chain", () => {
    const c = new Cluster({ iterations: 30 });
    const a = vec(0, 0);
    const b = vec(5, 5);
    eq(c, a.x, b.x);
    c.pin(a.x);
    a.value = { x: 3, y: 0 };
    expect(b.value.x).toBeCloseTo(3, 1);
    expect(b.value.y).toBeCloseTo(5, 1);
  });

  it.skip("write a.x.value → b.x updates via lens bwd + cluster", () => {
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

describe("Cluster lazy-solve — distance constraint", () => {
  it("drag end of distance chain → other end follows on read", () => {
    const c = new Cluster({ iterations: 30 });
    const a = vec(0, 0);
    const b = vec(1, 0);
    distance(c, a, b, 5);
    c.pin(a);

    a.value = { x: 0.001, y: 0 };
    const stepSpy = vi.spyOn(c.solver, "step");

    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(5, 1);

    stepSpy.mockRestore();
  });
});
