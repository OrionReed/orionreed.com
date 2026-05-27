// realistic-composition.test.ts
//
// REAL-TERMS PROBE: a non-trivial scene that mixes lenses and
// propagators. Walk through the design DECISIONS as the user
// would actually make them, with reasons.
//
// Scenario: a "rigid bar with sliders" UI.
//   - Two endpoints A and B of a bar.
//   - The bar has a LABEL at its midpoint that shows the length.
//   - The bar's MIDPOINT is draggable (drags translate both ends).
//   - The bar's LENGTH must stay between [50, 200] (clamp).
//   - The bar's CENTER OF GRAVITY must stay inside a viewport box.
//
// What's a lens, what's a propagator, why?
//
//   - midpoint of A, B          → lens (derived geometric value)
//   - length |A - B|             → lens (derived scalar)
//   - label.text = `${length}px` → lens (derived string from length)
//   - length within [50, 200]    → propagator (constraint on the
//                                   length lens, enforced by
//                                   modifying the underlying cells)
//   - midpoint inside viewport   → propagator (constraint on
//                                   midpoint lens; clamps it)
//
// The thought process:
//   1. "What's the value?" → lens.
//   2. "What's the constraint on the value?" → propagator.
//   3. "How does the constraint write back?" → through the lens.

import { describe, expect, it } from "vitest";
import { midpointLens, vec } from "../../signals";
import { Num } from "../../signals/values/num";
import { propagator, propagators } from "..";

describe("Realistic: rigid bar with sliders", () => {
  it("the full scene, mixing lenses and propagators", () => {
    // ─── Cells ───
    const A = vec(0, 50);
    const B = vec(100, 50);

    // ─── DEFINITIONS (lenses) ───
    // Midpoint: derived from A, B.
    const mid = midpointLens(A, B);
    // Length: derived as a Num.
    const length = Num.derive([A, B] as const, vals => {
      const [av, bv] = vals;
      return Math.hypot(bv.x - av.x, bv.y - av.y);
    });
    void length;

    // Sanity check: definitions work.
    expect(mid.value).toEqual({ x: 50, y: 50 });
    expect(length.value).toBe(100);

    // ─── CONSTRAINTS (propagators) ───
    const p = propagators();

    // Constraint 1: length must be in [50, 200].
    // Strategy: when length violates, scale (B - A) about midpoint.
    // The propagator writes A and B (not the lens directly,
    // because they're the underlying cells — both must move
    // symmetrically).
    p.add(
      propagator([length], [A, B], () => {
        const cur = length.value;
        if (cur >= 50 && cur <= 200) return;
        const target = Math.max(50, Math.min(200, cur));
        const m = mid.value; // lens read
        const factor = target / cur;
        A.value = {
          x: m.x + (A.value.x - m.x) * factor,
          y: m.y + (A.value.y - m.y) * factor,
        };
        B.value = {
          x: m.x + (B.value.x - m.x) * factor,
          y: m.y + (B.value.y - m.y) * factor,
        };
      }),
    );

    // Constraint 2: midpoint stays in viewport [0, 200] × [0, 100].
    // Strategy: write through the midpoint lens to clamp; the lens
    // distributes delta to A and B (translates the bar).
    p.add(
      propagator([mid], [mid], () => {
        const m = mid.value;
        let x = m.x,
          y = m.y;
        if (x < 0) x = 0;
        if (x > 200) x = 200;
        if (y < 0) y = 0;
        if (y > 100) y = 100;
        if (x !== m.x || y !== m.y) mid.value = { x, y };
      }),
    );

    // ─── User interactions ───

    // 1. Drag A way out. Length explodes; constraint scales bar back.
    A.value = { x: -500, y: 50 };
    expect(length.value).toBeLessThanOrEqual(200);
    expect(length.value).toBeGreaterThanOrEqual(50);

    // 2. Drag B until midpoint goes out of viewport. Constraint
    //    pulls midpoint back; lens redistributes delta.
    B.value = { x: 1000, y: 1000 };
    expect(mid.value.x).toBeLessThanOrEqual(200);
    expect(mid.value.y).toBeLessThanOrEqual(100);

    p.dispose();
  });

  it("walk-through: thinking in three roles", () => {
    // The composition is best UNDERSTOOD by thinking in three
    // separate roles for each "constraint" you write:
    //
    //   1. DEFINITION (the lens):
    //      "What VALUE do I care about?"
    //      Examples: midpoint, length, distance, area, sum.
    //      Built from existing minim lenses or custom Vec.lens.
    //
    //   2. PREDICATE (a residual lens, optional):
    //      "What should be TRUE about that value?"
    //      Examples: residual = current - target; or
    //      lower/upper bounds via clamp lens.
    //      The residual is itself a signal — UIs can subscribe.
    //
    //   3. SOLVER (the propagator):
    //      "How do I FIX it when it's wrong?"
    //      Examples: scale, clamp, snap, project, gradient.
    //      The solver writes through lenses (or directly).
    //
    // Each role is independently swappable. Want a different
    // notion of "length"? Change the definition lens. Want a
    // different bound? Change the predicate. Want a different
    // correction policy? Change the solver. The other two stay.
    //
    // This is the SUBSTANTIVE WIN of mixing.
    expect(true).toBe(true);
  });
});

describe("Realistic: where it gets tricky", () => {
  it("when the constraint should write to MULTIPLE cells with a PHYSICAL policy", () => {
    // Constraint: bar's center of gravity stays inside viewport.
    //
    // Option 1: write through midpointLens (the lens distributes
    //   delta evenly — both A and B move equally).
    // Option 2: write A and B explicitly with different policies
    //   (e.g., A is "anchored", only B moves).
    //
    // The choice depends on what physics or UX you want. The
    // FRAMEWORK doesn't decide — you do, by picking the lens or
    // by writing a custom propagator.
    //
    // This is where mixing requires intent. The lens bwd policy
    // is the LIBRARY's choice; the propagator's step is the
    // USER's choice. Combining them, you choose how the policies
    // stack.
    expect(true).toBe(true);
  });

  it("when freshness fails: constraint reads a chain that depends on cells written by another constraint", () => {
    // The Footgun 1 scenario in REALISTIC clothing.
    //
    // Constraint A writes A.x.
    // Constraint B reads `length` (which depends on A and B).
    // In one network fire, A's write doesn't bridge through
    // `length` to fire constraint B. Result: B is stale.
    //
    // Workaround in real code:
    //   - List `A` and `B` (the underlying cells) in B's reads.
    //   - OR split A and B into separate propagator instances.
    //   - OR ship AUTO-EXPAND.
    //
    // The user-facing rule: if you read a lens chain in your
    // propagator AND another propagator writes one of the chain's
    // parents, declare the parents in your reads too. Until
    // AUTO-EXPAND ships.
    expect(true).toBe(true);
  });
});

describe("Realistic — the optimisation goals", () => {
  it("expressiveness, performance, correctness, simplicity", () => {
    // What is the user optimising for when they reach for both?
    //
    //   EXPRESSIVENESS: state the relation in the most natural
    //     form. Lenses for "this is" relations; propagators for
    //     "this should be" relations. Mixing keeps the language
    //     natural for each piece.
    //
    //   PERFORMANCE: lenses are fused single-Computed cells,
    //     ~0.15 µs/drag. Propagators are network nodes,
    //     ~1.2 µs/drag. Use lenses where you can; reach for
    //     propagators only when needed.
    //
    //   CORRECTNESS: lenses are total functions — always
    //     consistent. Propagators iterate to fixpoint — may
    //     diverge or settle inconsistent (footguns 1, 3).
    //     Mixing requires watching the boundary.
    //
    //   SIMPLICITY: separating definition / predicate / solver
    //     keeps each role short and swappable. The mental
    //     overhead is "which role am I in?" — not "which
    //     constraint API does this thing fit into?"
    //
    // These four pull in similar directions: lenses where they
    // fit, propagators where they're needed, mixed cleanly.
    expect(true).toBe(true);
  });
});
