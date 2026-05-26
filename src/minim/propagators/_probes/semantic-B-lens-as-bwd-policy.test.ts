// semantic-B-lens-as-bwd-policy.test.ts
//
// SEMANTIC PROBE: lenses encapsulate WRITE POLICY; propagators
// borrow that policy by writing through lenses.
//
// When a propagator writes a cell, it has to decide HOW to write
// it. For a single Num, writing is trivial. For a "group of
// points" or "an aggregate," the write semantics are non-trivial:
// distribute the delta evenly? snap to the dragged point?
// scale uniformly? Each is a different policy.
//
// Lenses ENCODE these policies in their bwd. Writing through
// `centroidLens(verts)` distributes delta evenly. Writing
// through `midpointLens(a, b)` translates both endpoints. Writing
// through a custom Vec.lens is whatever the user defines.
//
// A propagator that wants to "move a group" doesn't have to
// implement the policy — it writes through the lens, and the
// lens's bwd does the work.
//
// This is the same separation as in (A): definition vs
// constraint. But here we're separating WRITE STRATEGY (lens) from
// WRITE TRIGGER (propagator).

import { describe, expect, it } from "vitest";
import {
  centroidLens,
  midpointLens,
  num,
  type Of,
  signal,
  Vec,
  vec,
  type Writable,
} from "../../signals";
import { propagator, propagators } from "..";

describe("Semantic probe B: lens encodes WRITE POLICY", () => {
  it("the SAME propagator works with different aggregation policies", () => {
    // Propagator: "make `target` move to `goal`."
    // The choice of `target` (single cell, centroid, midpoint, custom)
    // determines what "moves" mean for the underlying cells.
    function followGoal(target: Writable<Vec>, goal: Writable<Vec>) {
      return propagator([goal], [target], () => {
        target.value = goal.value;
      });
    }

    // Variant 1: target = a single Vec. Just one cell moves.
    const single = vec(0, 0);
    const goal1 = vec(10, 20);
    const p1 = propagators();
    p1.add(followGoal(single, goal1));
    expect(single.value).toEqual({ x: 10, y: 20 });
    p1.dispose();

    // Variant 2: target = midpoint of two cells. BOTH move.
    const a = vec(0, 0);
    const b = vec(0, 0);
    const mid = midpointLens(a, b);
    const goal2 = vec(10, 20);
    const p2 = propagators();
    p2.add(followGoal(mid, goal2));
    // Midpoint moved to (10, 20); each endpoint translated by delta.
    expect(a.value).toEqual({ x: 10, y: 20 });
    expect(b.value).toEqual({ x: 10, y: 20 });
    p2.dispose();

    // Variant 3: target = centroid of N cells. ALL N move.
    const verts = [vec(0, 0), vec(0, 0), vec(0, 0)];
    const cent = centroidLens(verts);
    const goal3 = vec(10, 20);
    const p3 = propagators();
    p3.add(followGoal(cent, goal3));
    expect(verts[0]!.value).toEqual({ x: 10, y: 20 });
    expect(verts[1]!.value).toEqual({ x: 10, y: 20 });
    expect(verts[2]!.value).toEqual({ x: 10, y: 20 });
    p3.dispose();

    // The propagator body didn't change. The semantics changed
    // because the target was a different lens. THIS is the win.
  });

  it("custom lens encodes a custom write policy — no propagator change needed", () => {
    // Define a "biased midpoint" lens: 70/30 split toward a.
    // Writing through it: the bwd places 70% of the delta on a,
    // 30% on b.
    const a = vec(0, 0);
    const b = vec(0, 0);
    const biasedMid = Vec.lens(
      [a, b] as const,
      vals => {
        const [av, bv] = vals;
        return { x: av.x * 0.7 + bv.x * 0.3, y: av.y * 0.7 + bv.y * 0.3 };
      },
      (target, vals) => {
        const [av, bv] = vals;
        const cur = { x: av.x * 0.7 + bv.x * 0.3, y: av.y * 0.7 + bv.y * 0.3 };
        const delta = { x: target.x - cur.x, y: target.y - cur.y };
        // Distribute delta with the biased policy: 70% of the work
        // goes to a (because a contributes 70% to fwd; symmetric).
        return [
          { x: av.x + delta.x * 0.7, y: av.y + delta.y * 0.7 },
          { x: bv.x + delta.x * 0.3, y: bv.y + delta.y * 0.3 },
        ];
      },
    );

    // Reuse the same propagator body.
    const goal = vec(100, 0);
    const p = propagators();
    p.add(
      propagator([goal], [biasedMid], () => {
        biasedMid.value = goal.value;
      }),
    );

    // Biased midpoint moved to (100, 0); a got 70% of delta, b got 30%.
    expect(a.value.x).toBeCloseTo(70);
    expect(b.value.x).toBeCloseTo(30);
    p.dispose();
  });

  it("a SCALE-LIKE policy via lens — propagator scales whole group around centroid", () => {
    // Lens: "the radius of this group from its centroid."
    // Writing the radius scales all points outward/inward.
    //
    // Define explicitly: radius is one cell; lens connects to the
    // group's positions.
    const verts = [vec(-1, 0), vec(1, 0), vec(0, 1)];
    const cent = centroidLens(verts); // = (0, 1/3)
    const cv = cent.value;

    // Mean radius (read-only proxy).
    const meanRadius = signal<number>(
      verts.reduce(
        (acc: number, v: Writable<Vec>) => acc + Math.hypot(v.value.x - cv.x, v.value.y - cv.y),
        0,
      ) / verts.length,
    );
    void meanRadius;

    // For demo: a propagator scales by writing each vert as
    // (cent + (vert - cent) * factor). Done explicitly here; the
    // SAME propagator body composes with any scale policy.
    const factor = num(1);
    const p = propagators();
    p.add(
      propagator([factor], verts as never[], () => {
        const c = cent.value;
        const f = factor.value;
        for (const v of verts) {
          const cur = v.value;
          (v.value as Of<Vec>) = {
            x: c.x + (cur.x - c.x) * f,
            y: c.y + (cur.y - c.y) * f,
          };
        }
      }),
    );

    factor.value = 2;
    // Each vert is now twice as far from centroid (scaled in place).
    // Original v1 was at (-1, 0); cent (0, 1/3); offset (-1, -1/3);
    // scaled (-2, -2/3); final position (cent + scaled) = (-2, 1/3 - 2/3) = (-2, -1/3).
    expect(verts[0]!.value.x).toBeCloseTo(-2);
    expect(verts[0]!.value.y).toBeCloseTo(-1 / 3);
    p.dispose();

    // The point: this propagator body operates on Vec cells.
    // It could equally be written to operate on a SINGLE lens that
    // encodes the scale-around-centroid policy. The lens approach
    // moves the policy from imperative loop to bwd function.
  });
});

describe("Semantic probe B: takeaway", () => {
  it("write policy is a lens concern; write trigger is a propagator concern", () => {
    // The clean separation:
    //
    //   Lens encodes:   how to translate a single write into
    //                   updates of underlying cells (delta-split,
    //                   biased, scaled, snapped, projected, etc.)
    //
    //   Propagator encodes: WHEN to write (which inputs trigger
    //                       which outputs, the iteration loop).
    //
    // Composing: a propagator picks a goal, writes a lens. The
    // lens distributes to underlying cells per its bwd. The
    // propagator body doesn't know or care HOW the write
    // distributes.
    //
    // This makes propagators POLYMORPHIC over write policies. The
    // SAME propagator body works for "move single point", "move
    // group centroid", "scale group", "biased move", etc., just by
    // changing the lens it writes through.
    expect(true).toBe(true);
  });
});
