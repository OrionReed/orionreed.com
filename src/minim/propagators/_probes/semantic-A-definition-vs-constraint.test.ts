// semantic-A-definition-vs-constraint.test.ts
//
// SEMANTIC PROBE: lens = definition; propagator = constraint.
//
// A lens chain DEFINES a value. `c = a.add(b)` means c IS a + b,
// algebraically, by construction. There's nothing TO violate —
// c always satisfies the equation.
//
// A propagator IMPOSES a relation. `add(a, b, c)` means "these
// three cells should satisfy a + b = c." Each cell has its own
// identity; the relation is a separate object that maintains it.
//
// What does this distinction BUY us when we compose them?
// Specifically: we can write things that have NO clean lens form
// because they're CONSTRAINTS over LENS-DERIVED VALUES.
//
//   Example: "the midpoint of A and B must be on this line."
//   The midpoint is a definition (lens). The on-line property is
//   a constraint (propagator). Composing them lets us state the
//   relationship cleanly.

import { describe, expect, it } from "vitest";
import { centroidLens, midpointLens, num, vec } from "../../signals";
import { onLine, propagator, propagators } from "..";

describe("Semantic probe A: composing definitions and constraints", () => {
  it("midpoint (lens) constrained to a line (propagator)", () => {
    // A and B move freely. The midpoint of A and B must stay on
    // the line through L1 and L2.
    //
    // The midpoint is a DEFINITION — `midpointLens(A, B)`. It's
    // not a separate cell with its own identity; it's algebra.
    //
    // The "on line" is a CONSTRAINT — onLine(p, l1, l2). It needs
    // a writable cell to project onto the line. Here, the writable
    // cell IS the lens.
    //
    // Composition: write through the lens to project the midpoint
    // onto the line, which redistributes to A and B.
    const A = vec(0, 0);
    const B = vec(20, 20);
    const L1 = vec(0, 5);
    const L2 = vec(20, 5); // horizontal line y = 5

    const mid = midpointLens(A, B); // definition

    const p = propagators();
    p.add(onLine(mid, L1, L2)); // constraint on the definition

    // Initial: midpoint of (0,0) and (20,20) = (10, 10).
    // Project onto line y = 5: (10, 5).
    // Lens distributes delta (0, -5) to A and B:
    //   A = (0, -5), B = (20, 15). Midpoint = (10, 5). On line ✓
    expect(mid.value.x).toBeCloseTo(10);
    expect(mid.value.y).toBeCloseTo(5);
    expect(A.value.y).toBeCloseTo(-5);
    expect(B.value.y).toBeCloseTo(15);

    // Drag A. Midpoint moves; constraint re-projects; B compensates.
    A.value = { x: -10, y: -10 };
    // Midpoint is now ((-10 + B.x)/2, (-10 + B.y)/2). Hmm — depends
    // on what B is. Let's measure.
    // After this drag, the constraint should re-fire and project
    // the new midpoint onto y=5. The lens then redistributes.
    expect(mid.value.y).toBeCloseTo(5); // still on the line

    p.dispose();
  });

  it("centroid (lens) constrained to a target (propagator) — group movement", () => {
    // 3 vertices form a triangle. Centroid (lens) is constrained
    // to track an external target.
    //
    // The centroid is a definition — algebraically the mean.
    // The "follow target" is a constraint enforced by a propagator
    // that writes through the centroid lens.
    //
    // Result: drag the target → entire triangle translates.
    const v1 = vec(0, 0);
    const v2 = vec(10, 0);
    const v3 = vec(5, 10);
    const target = vec(0, 0);

    const cent = centroidLens([v1, v2, v3]); // definition

    const p = propagators();
    p.add(propagator([target], [cent], () => { cent.value = target.value; }));

    target.value = { x: 100, y: 100 };
    // Triangle's centroid was (5, 10/3); now (100, 100). Each vertex
    // shifted by delta (95, 100 - 10/3).
    expect(v1.value.x).toBeCloseTo(95);
    expect(v2.value.x).toBeCloseTo(105);
    expect(v3.value.x).toBeCloseTo(100);

    p.dispose();
  });

  it("the killer move: chain of definitions, constraint at the top", () => {
    // Define a value through nested lens chains; constrain that
    // value at the very top. The propagator only sees the top
    // cell; lenses handle all the algebra below.
    //
    // Here: the average of two midpoints must satisfy a clamp.
    const a = num(0);
    const b = num(20);
    const c = num(0);
    const d = num(20);

    const midAB = a.add(b).scale(0.5); // (a + b) / 2
    const midCD = c.add(d).scale(0.5); // (c + d) / 2
    const avgOfMids = midAB.add(midCD).scale(0.5); // ((a+b)/2 + (c+d)/2) / 2

    // Constraint: avgOfMids must be in [5, 10].
    const p = propagators();
    p.add(propagator([avgOfMids], [avgOfMids], () => {
      const v = avgOfMids.value;
      if (v < 5) (avgOfMids as never as { value: number }).value = 5;
      else if (v > 10) (avgOfMids as never as { value: number }).value = 10;
    }));

    // Currently avgOfMids = ((0+20)/2 + (0+20)/2) / 2 = 10. On boundary.
    expect(avgOfMids.value).toBe(10);

    // Drag a way up. avgOfMids would exceed 10; constraint clamps;
    // the clamp's write cascades back through the lens chain to
    // distribute deltas across a, b, c, d.
    a.value = 100;
    // The clamp pulled avgOfMids back to 10. The chain's bwd
    // distributes the projection across all four parents.
    expect(avgOfMids.value).toBe(10);
    // Algebra: a' + b + c + d = 4 * 2 * 10 = 80. Sum was 0+20+0+20+(...new a 100 - delta).
    // The exact distribution depends on the lens's bwd policy.
    expect((a.value + b.value + c.value + d.value) / 4).toBeCloseTo(10);

    p.dispose();
  });
});

describe("Semantic probe A: takeaway", () => {
  it("lens defines values; propagator imposes properties", () => {
    // The composition story:
    //   - Use lenses to BUILD intermediate values you care about
    //     (midpoints, centroids, sums, distances, projections).
    //   - Use propagators to ENFORCE properties on those values
    //     (must equal target, must be on line, must be clamped).
    //
    // The propagator's reads/writes can be lens chains. Lenses are
    // the "intermediate language" — definitions you constrain via
    // propagators.
    //
    // Without composition, you'd have to embed all the lens
    // algebra inside the propagator body. Composition lets you
    // factor cleanly: definitions in one place, constraints in
    // another.
    expect(true).toBe(true);
  });
});
