// cluster-reactive.test.ts — signal-driven constraint propagation.
//
// Exercise the integration:
//   - Pass `Num`, `Vec`, `Box`, `Color` signals (and any subclass
//     that declares the `pack` trait) to constraint factories.
//   - Writes to a signal trigger a cluster run on the next flush.
//   - Subscribers (effects) see post-solve values.
//   - Lens-derived signals (`Vec.x`, `.y`, …) work transparently —
//     the signal layer's `_fusedOf` chain dirties them when the
//     parent is written; the cluster effect fires; solver runs;
//     writeBack propagates without re-triggering the cluster.
//
// **Pin model**: the reactive layer does *not* auto-pin user-
// written signals. To "drag" a signal (force the solver to honor
// the user's value, dragging others to match), use the explicit
// `pin()` helper (or set `cell.mass = 0` directly).

import { describe, expect, it } from "vitest";
import { batch, effect, Num, num as numSig, Vec, vec as vecSig } from "../../signals";
import { Cluster, distance, eq, leq } from "../index";

describe("AVBD reactive — basic signal binding", () => {
  it("eq(sigA, sigB) settles to a common value when both are free", () => {
    const s = new Cluster({ iterations: 20 });
    const a = numSig(3);
    const b = numSig(7);
    eq(s, a, b);

    // No pin: triggering a solve drives both toward the midpoint.
    a.value = 5;
    expect(a.value).toBeCloseTo(b.value, 2);
  });

  it("pin(a) + write a → b drags to match (Sketchpad-style drag)", () => {
    const s = new Cluster({ iterations: 20 });
    const a = numSig(3);
    const b = numSig(7);
    eq(s, a, b);

    const release = s.pin(a);
    a.value = 5;
    expect(a.value).toBeCloseTo(5, 2);
    expect(b.value).toBeCloseTo(5, 2);
    release();
  });

  it("distance(vecA, vecB) on Vec signals", () => {
    const s = new Cluster({ iterations: 30 });
    const a = vecSig(0, 0);
    const b = vecSig(1, 0);
    distance(s, a, b, 5);

    // Pin a so the constraint pulls b out, not both toward each other.
    s.pin(a);
    // Write a fresh value to a (different from initial) to trigger the solver.
    a.value = { x: 0.1, y: 0 };
    const av = a.value;
    const bv = b.value;
    expect(Math.hypot(av.x - bv.x, av.y - bv.y)).toBeCloseTo(5, 1);
  });

  it("subscribers see post-solve values (pre-flush ordering)", () => {
    const s = new Cluster({ iterations: 20 });
    const a = numSig(3);
    const b = numSig(7);
    eq(s, a, b);
    s.pin(a);

    let observed = -1;
    const dispose = effect(() => {
      observed = b.value;
    });
    expect(observed).toBe(7);

    a.value = 5;
    // Pre-effect (solver) drains before regular effects, so the
    // effect sees b ≈ 5 (matching a), not the old 7.
    expect(observed).toBeCloseTo(5, 2);

    dispose();
  });

  it("self-mute prevents back-write loops", () => {
    // If the solver's back-write re-triggered the pre-effect, every
    // user write would loop. We verify a single user write produces
    // exactly one extra effect run.
    const s = new Cluster({ iterations: 10 });
    const a = numSig(0);
    const b = numSig(0);
    eq(s, a, b);
    s.pin(a);

    let bWrites = 0;
    const dispose = effect(() => {
      b.value;
      bWrites++;
    });
    expect(bWrites).toBe(1);

    a.value = 42;
    expect(bWrites).toBe(2);
    expect(b.value).toBeCloseTo(42, 2);

    dispose();
  });

  it("batch coalesces multiple signal writes into one solve", () => {
    const s = new Cluster({ iterations: 20 });
    const a = numSig(0);
    const b = numSig(0);
    const c = numSig(0);
    eq(s, a, b);
    eq(s, b, c);
    s.pin(a);

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
    // Three writes → one pre-effect run → one effect re-run.
    expect(cWrites).toBe(2);
    expect(c.value).toBeCloseTo(15, 2);

    dispose();
  });
});

describe("AVBD reactive — lens composition", () => {
  it("eq(a.x, b.x) propagates writes through the signals fusion chain", () => {
    // The constraint binds `a.x` and `b.x` (lens-derived Num signals).
    // Writing the parent `a` dirties `a.x` via the existing `_fusedOf`
    // chain; the pre-effect's deps include `a.x` so it fires; solver
    // runs; back-write to `b.x` propagates back to `b` via the lens.
    const s = new Cluster({ iterations: 30 });
    const a = vecSig(0, 0);
    const b = vecSig(5, 5);

    eq(s, a.x, b.x);
    s.pin(a.x);
    a.value = { x: 3, y: 0 };

    expect(b.value.x).toBeCloseTo(3, 2);
    expect(b.value.y).toBeCloseTo(5, 1); // y untouched by the constraint
  });

  it("writing the lens-derived child propagates through the lens both ways", () => {
    const s = new Cluster({ iterations: 30 });
    const a = vecSig(0, 0);
    const b = vecSig(5, 5);
    eq(s, a.x, b.x);
    s.pin(a.x);

    a.x.value = 7;
    expect(a.value.x).toBeCloseTo(7, 2);
    expect(b.value.x).toBeCloseTo(7, 2);
  });
});

describe("AVBD reactive — inequalities", () => {
  it("leq(a, b) saturates: writing a above b pulls a down", () => {
    const s = new Cluster({ iterations: 30 });
    const a = numSig(3);
    const b = numSig(3);
    leq(s, a, b);
    s.pin(b);

    // Push a above b; constraint should saturate.
    a.value = 10; // expect to be pulled back to ≤ b
    // Without pinning a, the solver finds the closest feasible point
    // — so a should land at b.
    expect(a.value).toBeLessThanOrEqual(b.value + 0.01);

    // Move b up — a is free below the boundary, stays put.
    b.value = 20;
    expect(a.value).toBeLessThanOrEqual(20);

    // Drop b below a — a must follow down.
    b.value = -5;
    expect(a.value).toBeLessThanOrEqual(-5 + 0.01);
  });
});

describe("AVBD reactive — type checks", () => {
  it("signals carry shape via constructor instance", () => {
    const n = numSig(1);
    const v = vecSig(1, 2);
    expect(n).toBeInstanceOf(Num);
    expect(v).toBeInstanceOf(Vec);
  });
});
