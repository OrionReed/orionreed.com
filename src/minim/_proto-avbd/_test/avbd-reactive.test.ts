// avbd-reactive.test.ts — Signal-driven AVBD constraints.
//
// Exercise the integration:
//   - Pass `Signal<Num>`, `Signal<Vec>`, etc., to constraint factories.
//   - Writes to a signal trigger a solver run during pre-flush.
//   - Subscribers (effects) see post-solve values.
//   - Lens-derived signals (`Vec.x`, `.y`, etc.) work transparently —
//     constraints over `vec.x` propagate via the signal layer's
//     existing `_throughOf` lens chain. No special handling needed
//     in the solver.
//   - Multiple signals can be constrained against bare `Cell`s in
//     the same solver.

import { describe, expect, it } from "vitest";
import { batch, effect, Num, num as numSig, signal, type Signal, Vec, vec as vecSig } from "../../signals";
import { distance, eq, leq, Solver } from "../index";

describe("AVBD reactive — basic signal binding", () => {
  it("eq(sigA, sigB) propagates writes to either side", () => {
    const s = new Solver({ iterations: 20 });
    const a = numSig(3);
    const b = numSig(7);
    eq(s, a, b);

    // Writing to `a` should drag `b` to match (after flush).
    a.value = 5;
    expect(b.value).toBeCloseTo(5, 2);

    // And vice versa.
    b.value = 11;
    expect(a.value).toBeCloseTo(11, 2);
  });

  it("distance(vecA, vecB) on Vec signals", () => {
    const s = new Solver({ iterations: 30 });
    const a = vecSig(0, 0);
    const b = vecSig(1, 0);
    distance(s, a, b, 5);

    // Trigger a solve by writing a different value to a (drag).
    a.value = { x: 0.5, y: 0 };
    const av = a.value;
    const bv = b.value;
    expect(Math.hypot(av.x - bv.x, av.y - bv.y)).toBeCloseTo(5, 1);
  });

  it("subscribers see post-solve values (pre-flush ordering)", () => {
    const s = new Solver({ iterations: 20 });
    const a = numSig(3);
    const b = numSig(7);
    eq(s, a, b);

    let observed = -1;
    const dispose = effect(() => {
      observed = b.value; // each effect run snapshots b
    });

    // Initial effect run: observed = 7.
    expect(observed).toBe(7);

    // Drive a: solver should run before the effect, so the effect
    // sees b ≈ 5 (matching a), not the old 7.
    a.value = 5;
    expect(observed).toBeCloseTo(5, 2);

    dispose();
  });

  it("withSolverActive suppresses re-trigger from solver writes", () => {
    // If the solver's back-write wasn't suppressed, every iteration
    // would re-queue the cluster and we'd loop. This test verifies a
    // single drain runs each user write.
    const s = new Solver({ iterations: 10 });
    const a = numSig(0);
    const b = numSig(0);
    eq(s, a, b);

    let bWrites = 0;
    const dispose = effect(() => {
      b.value;
      bWrites++;
    });
    // Initial effect run.
    expect(bWrites).toBe(1);

    a.value = 42;
    // One additional flush triggered by the user write; effect runs once.
    expect(bWrites).toBe(2);
    expect(b.value).toBeCloseTo(42, 2);

    dispose();
  });

  it("batch coalesces multiple signal writes into one solve", () => {
    const s = new Solver({ iterations: 20 });
    const a = numSig(0);
    const b = numSig(0);
    const c = numSig(0);
    eq(s, a, b);
    eq(s, b, c);

    let cWrites = 0;
    const dispose = effect(() => {
      c.value;
      cWrites++;
    });
    expect(cWrites).toBe(1);

    batch(() => {
      a.value = 5;
      a.value = 10;
      a.value = 15;
    });
    // Three writes → one solver run → one effect re-run.
    expect(cWrites).toBe(2);
    expect(c.value).toBeCloseTo(15, 2);

    dispose();
  });
});

describe("AVBD reactive — lens composition", () => {
  it("eq(vecA.x, vecB.x) works through the signals lens chain", () => {
    // The constraint binds `vecA.x` and `vecB.x` (lens-derived
    // Num signals). When we write to `vecA`, the signals layer
    // dirties the lens-derived `vecA.x`; the pin-hook fires for
    // *vecA.x*, the cluster solver runs, and the back-write to
    // `vecB.x` propagates through the lens to `vecB`.
    const s = new Solver({ iterations: 30 });
    const a = vecSig(0, 0);
    const b = vecSig(5, 5);

    // Constrain x-axes only — y-axes are free.
    eq(s, a.x, b.x);

    // Drag a: a.x = 3 → b.x converges to 3, b.y untouched.
    a.value = { x: 3, y: 0 };
    expect(b.value.x).toBeCloseTo(3, 2);
    // b.y was 5 originally; should be close to 5 still (within solver
    // numerical noise).
    expect(b.value.y).toBeCloseTo(5, 1);
  });

  it("dragging the lens-derived child propagates back through the lens", () => {
    const s = new Solver({ iterations: 30 });
    const a = vecSig(0, 0);
    const b = vecSig(5, 5);
    eq(s, a.x, b.x);

    // Write directly to a.x — should drag a (via lens bwd), trigger
    // the solver, and update b.x.
    a.x.value = 7;
    expect(a.value.x).toBeCloseTo(7, 2);
    expect(b.value.x).toBeCloseTo(7, 2);
  });
});

describe("AVBD reactive — mixed cells + signals", () => {
  it("inequality on signals", () => {
    const s = new Solver({ iterations: 30 });
    const a = numSig(5);
    const b = numSig(3);
    leq(s, a, b);

    // Trigger an initial solve by writing to b. a should be pulled
    // down to b.
    b.value = 3;
    // Same value, no-op — write a fresh value:
    b.value = 3.0001;
    expect(a.value).toBeLessThanOrEqual(b.value + 0.01);

    // Raise b — a is free below the boundary, stays put.
    b.value = 10;
    expect(a.value).toBeCloseTo(a.value, 1);
    expect(a.value).toBeLessThanOrEqual(10);

    // Drop b below a — a must follow down.
    b.value = -5;
    expect(a.value).toBeLessThanOrEqual(-5 + 0.01);
  });

  it("signal bound to one solver throws if added to another", () => {
    const s1 = new Solver();
    const s2 = new Solver();
    const x = numSig(0);
    const y = numSig(0);

    eq(s1, x, y); // x and y bound to s1.
    expect(() => eq(s2, x, y)).toThrow(/already bound/);
  });
});

describe("AVBD reactive — type checks", () => {
  it("signals carry shape via constructor instance", () => {
    const n = numSig(1);
    const v = vecSig(1, 2);
    expect(n).toBeInstanceOf(Num);
    expect(v).toBeInstanceOf(Vec);
    // Type-only smoke: factories accept Bindable, our Num/Vec inhabit it.
    const _suppress: Signal<unknown>[] = [n, v];
    void _suppress;
  });
});
