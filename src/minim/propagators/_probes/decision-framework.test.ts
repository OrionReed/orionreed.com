// decision-framework.test.ts
//
// REAL-TERMS PROBE: when does a user reach for a lens, when for a
// propagator, and what's their thought process when mixing?
//
// Goal: produce a usable decision framework. Not abstract — every
// case is a worked example of code the user might actually write.
//
// The framework, distilled:
//
//   START: what's your relation about?
//
//   ┌─ A NEW VALUE that's a function of others
//   │   └─→ LENS. (Also: do I want bidirectionality? Lens chains
//   │              are bidirectional automatically.)
//   │
//   ├─ A CONSTRAINT between EXISTING cells (each has identity
//   │  for other reasons — UI handles, animations, externally
//   │  written)
//   │   └─→ PROPAGATOR (or AVBD if iterative numerical)
//   │
//   ├─ Multiple OUTPUTS or branches
//   │   └─→ PROPAGATOR (lenses are 1-output)
//   │
//   ├─ Iterative narrowing (sets, intervals, fixpoint)
//   │   └─→ PROPAGATOR
//   │
//   └─ MIX: a value that's derived AND constrained
//       └─→ LENS for the value + PROPAGATOR for the constraint
//          (writes flow through the lens via its bwd)

import { describe, expect, it } from "vitest";
import { centroidLens, midpointLens, num, vec } from "../../signals";
import { propagator, propagators } from "..";

describe("Decision: 'I want a derived value'", () => {
  it("Q: I want c to be a + b. → lens", () => {
    const a = num(2);
    const b = num(3);
    const c = a.add(b); // lens chain
    expect(c.value).toBe(5);

    // Bidirectional out of the box. Drag c, a updates.
    c.value = 10;
    expect(a.value).toBe(7);
    // Why lens: closed-form, fused, cheap, always correct.
  });

  it("Q: I want c to be the centroid of N vecs. → centroidLens", () => {
    const verts = [vec(0, 0), vec(10, 0), vec(5, 10)];
    const c = centroidLens(verts);
    expect(c.value.x).toBeCloseTo(5);
    // Why lens: same reasons, plus N-input bidirectional bwd
    // already coded in `aggregates.ts`.
  });
});

describe("Decision: 'I want to constrain existing cells'", () => {
  it("Q: I have UI handles a, b. Their distance must equal d. → propagator (or AVBD)", () => {
    // a, b come from somewhere external (UI). I can't replace
    // them with a lens-derived cell. I need to ENFORCE a relation
    // BETWEEN them. This is a propagator.
    const a = vec(0, 0);
    const b = vec(20, 0);
    const d = num(10);

    const p = propagators();
    p.add(
      propagator([a, d], [b], () => {
        // Project b along (b - a) to distance d.
        const dx = b.value.x - a.value.x;
        const dy = b.value.y - a.value.y;
        const cur = Math.hypot(dx, dy);
        if (cur < 1e-9) return;
        const k = d.value / cur;
        b.value = { x: a.value.x + dx * k, y: a.value.y + dy * k };
      }),
    );

    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(10);
    p.dispose();
    // Why propagator: existing cell identities preserved; the
    // constraint is enforced by intervention, not definition.
  });
});

describe("Decision: 'I want multiple outputs'", () => {
  it("Q: a + b = c + d (two outputs, no clear 'derived' cell). → propagator", () => {
    const a = num(1);
    const b = num(2);
    const c = num(0);
    const d = num(3);

    const p = propagators();
    p.add(
      propagator([a, b, c, d], [c, d], () => {
        const lhs = a.value + b.value;
        const rhs = c.value + d.value;
        const r = lhs - rhs;
        if (Math.abs(r) > 1e-9) {
          c.value += r / 2;
          d.value += r / 2;
        }
      }),
    );

    expect(c.value + d.value).toBeCloseTo(a.value + b.value);
    p.dispose();
    // Why propagator: a lens has ONE output. M:N relations are
    // propagator-only.
  });
});

describe("Decision: 'I want both — derived value with a constraint'", () => {
  it("Q: midpoint of A,B must lie on line through L1,L2 → lens + propagator", () => {
    // Three concerns:
    //   - midpoint = lens (a derived value)
    //   - on-line  = constraint (a propagator that writes through the lens)
    //   - the propagator's WRITE distributes via the lens's bwd
    const A = vec(0, 0);
    const B = vec(20, 20);
    const L1 = vec(0, 5);
    const L2 = vec(20, 5);

    const mid = midpointLens(A, B); // LENS

    const p = propagators();
    p.add(
      propagator([mid, L1, L2], [mid], () => {
        // Project mid onto line L1-L2.
        const dx = L2.value.x - L1.value.x;
        const dy = L2.value.y - L1.value.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-12) return;
        const px = mid.value.x - L1.value.x;
        const py = mid.value.y - L1.value.y;
        const t = (px * dx + py * dy) / len2;
        const nx = L1.value.x + t * dx;
        const ny = L1.value.y + t * dy;
        if (Math.abs(nx - mid.value.x) > 1e-9 || Math.abs(ny - mid.value.y) > 1e-9) {
          mid.value = { x: nx, y: ny };
        }
      }),
    );

    // Mid was (10, 10). Projected onto y=5: (10, 5).
    // Lens distributes delta (0, -5) to A and B:
    expect(A.value.y).toBeCloseTo(-5);
    expect(B.value.y).toBeCloseTo(15);
    expect(mid.value.y).toBeCloseTo(5);
    p.dispose();
    // Why both: definition (midpoint) is closed-form → lens.
    // Constraint (on-line) is procedural → propagator. Mixing
    // gives clean factorization: each tool does what it's good at.
  });
});

describe("Decision: 'I'm not sure'", () => {
  it("default heuristic: try the lens first; fall back to propagator if needed", () => {
    // Lenses are the cheaper, more-composable default. Reach for
    // them first. If you discover:
    //   - the relation has multiple outputs → propagator
    //   - you can't replace the cell → propagator
    //   - the bwd needs iteration → propagator
    //   - the relation involves set/interval narrowing → propagator
    // Then upgrade to a propagator. The transition cost is low —
    // your lens-derived cells stay; the propagator just adds a
    // constraint over them.
    expect(true).toBe(true);
  });
});

describe("The mental model", () => {
  it("lenses define values; propagators enforce properties", () => {
    // When you write `c = a.add(b)`, you're DEFINING c. There's
    // nothing to violate; c IS a + b by construction. The relation
    // is in the cell's IDENTITY.
    //
    // When you write `p.add(distance(a, b, d))`, you're DEMANDING
    // that |a - b| = d. The relation is SEPARATE from the cells;
    // it's enforced by the propagator's step body, on demand.
    //
    // Composition: lenses build derived values; propagators
    // enforce properties on those values. The propagator's reads
    // can be lens chains (it observes derived values); the
    // propagator's writes can be lens chains (the lens's bwd
    // distributes to underlying cells).
    //
    // Mental shortcut:
    //   "It's a function of these"   → lens
    //   "It must satisfy this"       → propagator
    //   "Both"                       → both
    expect(true).toBe(true);
  });
});
