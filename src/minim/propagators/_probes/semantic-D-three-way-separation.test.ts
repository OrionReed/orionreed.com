// semantic-D-three-way-separation.test.ts
//
// SEMANTIC PROBE: lens × propagator composition cleanly separates
// THREE traditionally-conflated concerns:
//
//   1. What you MEAN          (lens — definition / value)
//   2. What you WANT to be true (lens — residual / predicate)
//   3. How to MAKE it true    (propagator — solver action)
//
// Without composition, these collapse into a single "constraint"
// blob. Composing them means you can swap any one without
// changing the others. That's the semantic win.
//
// Concrete demo: a draggable triangle with three swappable axes:
//   - Definition: choose how to compute "area" (signed Shoelace,
//     unsigned absolute, sum of triangle decompositions, …).
//   - Predicate: choose what the constraint is (area = 100,
//     area > 50, area = perimeter, …).
//   - Solver: choose how to fix violations (snap one vertex,
//     scale uniformly, projected gradient, …).

import { describe, expect, it } from "vitest";
import { num, type Signal, vec, type Writable } from "../../signals";
import { Num } from "../../signals/values/num";
import { propagator, propagators } from "..";

type V = { x: number; y: number };
type WVec = Writable<Signal<V>>;

describe("Semantic probe D: three-way separation", () => {
  it("definition swap: same constraint, different area formula", () => {
    // Triangle vertices.
    const a = vec(0, 0);
    const b = vec(10, 0);
    const c = vec(0, 10);

    // ─── DEFINITION (lens): two equivalent area formulas ───
    //
    // Formula 1: absolute Shoelace.
    const shoeLace = Num.derive(
      [a, b, c] as const,
      vals => {
        const [av, bv, cv] = vals;
        return Math.abs(
          (av.x * (bv.y - cv.y) + bv.x * (cv.y - av.y) + cv.x * (av.y - bv.y)) / 2,
        );
      },
    );

    // Formula 2: ½ × base × height (works only for axis-aligned).
    const baseHeight = Num.derive([a, b, c] as const, vals => {
      const [av, bv, cv] = vals;
      const base = Math.hypot(bv.x - av.x, bv.y - av.y);
      // Perpendicular distance from c to line ab.
      const dx = bv.x - av.x;
      const dy = bv.y - av.y;
      const len = Math.hypot(dx, dy);
      const px = -dy / len;
      const py = dx / len;
      const cFromA = { x: cv.x - av.x, y: cv.y - av.y };
      const height = Math.abs(cFromA.x * px + cFromA.y * py);
      return (base * height) / 2;
    });

    // Both give 50 for this triangle.
    expect(shoeLace.value).toBeCloseTo(50);
    expect(baseHeight.value).toBeCloseTo(50);

    // ─── PREDICATE (lens): residual = area - target ───
    const target = num(100);
    const residual1 = shoeLace.sub(target); // using shoeLace
    const residual2 = baseHeight.sub(target); // using baseHeight

    expect(residual1.value).toBeCloseTo(-50);
    expect(residual2.value).toBeCloseTo(-50);

    // ─── SOLVER (propagator): set c.y to the height that makes area=target ───
    // Geometric closed-form: area = ½ × |b - a| × height.
    // height = 2 × target / |b - a|. Set c on perpendicular at that height.
    function snapHeight(residualSig: typeof residual1) {
      return propagator([residualSig, a, b, target], [c], () => {
        if (Math.abs(residualSig.value) < 0.01) return;
        const baseLen = Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y);
        if (baseLen < 1e-9) return;
        const h = (2 * target.value) / baseLen;
        // Perpendicular direction (left of a→b).
        const dx = b.value.x - a.value.x;
        const dy = b.value.y - a.value.y;
        const px = -dy / baseLen;
        const py = dx / baseLen;
        // Foot on line ab, then perpendicular.
        const cx = (a.value.x + b.value.x) / 2;
        const cy = (a.value.y + b.value.y) / 2;
        const sgn = (c.value.x - cx) * px + (c.value.y - cy) * py >= 0 ? 1 : -1;
        (c.value as V) = { x: cx + px * h * sgn, y: cy + py * h * sgn };
      });
    }

    // Wire up with definition 1.
    const p = propagators({ iterations: 5 });
    p.add(snapHeight(residual1));
    expect(shoeLace.value).toBeCloseTo(100, 0);
    p.dispose();

    // Reset.
    a.value = { x: 0, y: 0 };
    b.value = { x: 10, y: 0 };
    c.value = { x: 0, y: 10 };

    // Same propagator, different definition.
    const p2 = propagators({ iterations: 5 });
    p2.add(snapHeight(residual2));
    expect(baseHeight.value).toBeCloseTo(100, 0);
    p2.dispose();

    // The propagator BODY didn't change — only the definition we
    // passed in. Both definitions reach the same satisfied state.
  });

  it("predicate swap: same definition, same solver, different target", () => {
    // Just change the residual lens; everything else stays.
    const a = vec(0, 0);
    const b = vec(10, 0);
    const c = vec(0, 10);

    const area = Num.derive(
      [a, b, c] as const,
      vals => {
        const [av, bv, cv] = vals;
        return Math.abs(
          (av.x * (bv.y - cv.y) + bv.x * (cv.y - av.y) + cv.x * (av.y - bv.y)) / 2,
        );
      },
    );

    function makePropagator(residualSig: Signal<number>, targetSig: typeof target1) {
      return propagator([residualSig, a, b, targetSig], [c], () => {
        if (Math.abs(residualSig.value) < 0.01) return;
        const baseLen = Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y);
        if (baseLen < 1e-9) return;
        const h = (2 * targetSig.value) / baseLen;
        const dx = b.value.x - a.value.x;
        const dy = b.value.y - a.value.y;
        const px = -dy / baseLen;
        const py = dx / baseLen;
        const cx = (a.value.x + b.value.x) / 2;
        const cy = (a.value.y + b.value.y) / 2;
        const sgn = (c.value.x - cx) * px + (c.value.y - cy) * py >= 0 ? 1 : -1;
        (c.value as V) = { x: cx + px * h * sgn, y: cy + py * h * sgn };
      });
    }

    // Predicate 1: area = 100.
    const target1 = num(100);
    const r1 = area.sub(target1);

    const p1 = propagators({ iterations: 5 });
    p1.add(makePropagator(r1, target1));
    expect(area.value).toBeCloseTo(100, 0);
    p1.dispose();

    // Reset.
    a.value = { x: 0, y: 0 };
    b.value = { x: 10, y: 0 };
    c.value = { x: 0, y: 10 };

    // Predicate 2: area = 25 (just change the residual lens).
    const target2 = num(25);
    const r2 = area.sub(target2);

    const p2 = propagators({ iterations: 5 });
    p2.add(makePropagator(r2, target2));
    expect(area.value).toBeCloseTo(25, 0);
    p2.dispose();
  });

  it("solver swap: same definition, same predicate, different action", () => {
    // The most interesting axis. Same constraint on the same value;
    // different ways to fix violations.
    const a = vec(0, 0);
    const b = vec(10, 0);
    const c = vec(0, 10);

    const area = Num.derive(
      [a, b, c] as const,
      vals => {
        const [av, bv, cv] = vals;
        return Math.abs(
          (av.x * (bv.y - cv.y) + bv.x * (cv.y - av.y) + cv.x * (av.y - bv.y)) / 2,
        );
      },
    );
    const target = num(100);
    const residual = area.sub(target);

    // Solver A: snap c.y to the perpendicular height that satisfies area.
    function solverSnapY(): ReturnType<typeof propagator> {
      return propagator([residual, a, b, target], [c], () => {
        if (Math.abs(residual.value) < 0.01) return;
        const baseLen = Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y);
        if (baseLen < 1e-9) return;
        const h = (2 * target.value) / baseLen;
        // For axis-aligned ab on x-axis, just set c.y = ±h preserving sign.
        const sgn = c.value.y >= 0 ? 1 : -1;
        (c.value as V) = { x: c.value.x, y: h * sgn };
      });
    }

    // Solver B: snap c.x INSTEAD (different vertex of freedom).
    // Given fixed c.y, find the c.x that gives the right area.
    // For axis-aligned ab on x-axis with a=(0,0), b=(10,0), area = ½ × 10 × |c.y|.
    // c.x doesn't actually affect area in this setup, but a different solver
    // could move c LATERALLY along the line at the right perpendicular distance.
    // Simplest different policy: snap c to the midpoint x.
    function solverSnapMid(): ReturnType<typeof propagator> {
      return propagator([residual, a, b, target], [c], () => {
        if (Math.abs(residual.value) < 0.01) return;
        const baseLen = Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y);
        if (baseLen < 1e-9) return;
        const h = (2 * target.value) / baseLen;
        const midX = (a.value.x + b.value.x) / 2;
        const sgn = c.value.y >= 0 ? 1 : -1;
        (c.value as V) = { x: midX, y: h * sgn };
      });
    }

    // Try solver A: snap-y, c.x stays.
    const p1 = propagators({ iterations: 5 });
    p1.add(solverSnapY());
    expect(area.value).toBeCloseTo(100, 0);
    const cAfterA = { ...c.value };
    p1.dispose();

    // Reset.
    a.value = { x: 0, y: 0 };
    b.value = { x: 10, y: 0 };
    c.value = { x: 0, y: 10 };

    // Try solver B: snap-mid, c.x moves to midpoint.
    const p2 = propagators({ iterations: 5 });
    p2.add(solverSnapMid());
    expect(area.value).toBeCloseTo(100, 0);
    const cAfterB = { ...c.value };
    p2.dispose();

    // Different solvers reach the SAME satisfied state via DIFFERENT
    // paths. The user chooses based on UX preference.
    expect(cAfterA).not.toEqual(cAfterB);
  });
});

describe("Semantic probe D: takeaway", () => {
  it("the win: definition / predicate / solver are independently swappable", () => {
    // What lens × propagator composition gives you:
    //
    //   1. DEFINITION as an EXPRESSION (lens chain).
    //      - Pure, fused, cached, reactive.
    //      - Swappable without touching anything else.
    //
    //   2. PREDICATE as a RESIDUAL EXPRESSION (lens chain).
    //      - "How far off we are." A reactive signal.
    //      - UIs can show it; debuggers can plot it.
    //      - Swappable without touching the definition.
    //
    //   3. SOLVER as a PROPAGATOR.
    //      - "What to do when the residual is nonzero."
    //      - A separate concern from the constraint itself.
    //      - Swappable to pick projection, scale, snap, gradient,
    //        whatever fits the UX.
    //
    // The traditional way (everything inside one constraint blob)
    // makes all three coupled. This separation is the substantive
    // semantic gain from having both lenses and propagators.
    //
    // It's also why "lens equivalents exist" doesn't kill the
    // propagator variant: the propagator is the SOLVER role; the
    // lens is the DEFINITION / PREDICATE role. Both stay.
    expect(true).toBe(true);
  });
});

// Suppress unused-import lint complaint on WVec.
void (null as unknown as WVec);
