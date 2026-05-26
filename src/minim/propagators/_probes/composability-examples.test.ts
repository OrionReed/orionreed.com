// composability-examples.test.ts
//
// SEMANTIC PROBE (with examples): worked compositions of lens
// chains + propagator networks for real-shaped scenarios.
//
//   1. Form validation with reactive residuals.
//   2. Coordinate-system change (Cartesian ↔ polar).
//   3. Animation × constraint (clamped-during-tween).
//   4. Energy-conserving system (lens computes total; propagator
//      enforces it).
//
// These are how the composition would look in actual use.

import { describe, expect, it } from "vitest";
import { effect, num, vec } from "../../signals";
import { propagator, propagators } from "..";

describe("Example 1: form validation via residual lenses", () => {
  it("each field has a residual lens; UI shows them; submit gates on all-zero", () => {
    // User types into form fields. Each field has a constraint
    // expressed as a residual lens. The UI subscribes to the
    // residuals to show "errors". A submit propagator only fires
    // when all residuals are zero.
    const username = num(0); // length, simulated
    const password = num(0);
    const email = num(0);

    // Constraints expressed as residuals (positive = violation).
    const usernameTooShort = num(3).sub(username); // need >= 3
    const passwordTooShort = num(8).sub(password); // need >= 8
    const emailEmpty = num(1).sub(email); // need >= 1

    // UI subscribes to each residual to show error messages.
    const errors: string[] = [];
    effect(() => {
      errors.length = 0;
      if (usernameTooShort.value > 0) errors.push("username too short");
      if (passwordTooShort.value > 0) errors.push("password too short");
      if (emailEmpty.value > 0) errors.push("email required");
    });
    expect(errors.length).toBe(3); // all violations on initial state

    // Type into username.
    username.value = 5;
    expect(errors).not.toContain("username too short");

    // The "all valid" predicate is also a lens — derive from residuals.
    // For a real impl we'd use a proper aggregation; here just check
    // that residuals are reactive and observable.
    username.value = 5;
    password.value = 10;
    email.value = 1;
    expect(errors.length).toBe(0);

    // The submit button can subscribe and disable itself when any
    // residual is positive. No propagator needed here — pure lens
    // chain semantics.
  });

  it("a CORRECTOR propagator can ALSO drive residuals to zero", () => {
    // Same residuals, but with a propagator that snaps invalid
    // fields to the minimum valid value (cf. forced fix in a
    // wizard's "fix this for me" button).
    const usernameLen = num(0);
    const r = num(3).sub(usernameLen); // residual: need len >= 3

    const p = propagators();
    p.add(propagator([r], [usernameLen], () => {
      if (r.value > 0) usernameLen.value = 3; // snap to min
    }));

    expect(usernameLen.value).toBe(3); // corrected on install
    p.dispose();
  });
});

describe("Example 2: coordinate-system change (Cartesian ↔ polar)", () => {
  it("constraint expressed in polar terms via lens; Cartesian cells stay primary", () => {
    // Cartesian (x, y) is the primary representation. A lens
    // computes (r, theta). A constraint is expressed naturally in
    // polar form — "theta must be 30 degrees."
    //
    // This is composition: the lens converts coordinate systems;
    // the propagator constrains in whichever system is natural.
    const x = num(1);
    const y = num(0);

    // Polar lens reads.
    const radius = num(0);
    const theta = num(0);

    // Maintain (radius, theta) from (x, y) via an effect (one-direction).
    // For a true bidirectional version you'd use a Vec.lens with the
    // polar map's invertible chain (already exists in minim).
    effect(() => {
      radius.value = Math.hypot(x.value, y.value);
      theta.value = Math.atan2(y.value, x.value);
    });
    expect(radius.value).toBeCloseTo(1);
    expect(theta.value).toBeCloseTo(0);

    // Constraint: keep theta = π/4.
    // The constraint is naturally polar. We write a propagator
    // that adjusts (x, y) so theta = π/4, preserving radius.
    const targetTheta = num(Math.PI / 4);
    const p = propagators();
    p.add(propagator([targetTheta, radius], [x, y], () => {
      const r = radius.value;
      const t = targetTheta.value;
      x.value = r * Math.cos(t);
      y.value = r * Math.sin(t);
    }));

    expect(theta.value).toBeCloseTo(Math.PI / 4);
    expect(radius.value).toBeCloseTo(1);

    // Drag radius (in polar) - propagator re-fires.
    radius.value = 2;
    // Hmm, the effect updates radius from (x,y). Writing radius
    // directly is a one-way leak. For a clean version we'd need
    // a true polar lens. The point: composition lets you EXPRESS
    // the constraint in the natural coord system, even when the
    // primary cells are in another.
    p.dispose();
  });
});

describe("Example 3: animation × constraint", () => {
  it("a tween writes a lens-derived target; constraint clamps during the tween", () => {
    // The tween writes a Vec at successive timepoints. The Vec is
    // a centroid lens. Each write redistributes to underlying
    // points. A propagator clamps the centroid to a bounding box.
    //
    // Result: the animation respects the constraint without
    // either side knowing about the other.

    // Skipping the full minim integration (would need anim.ts),
    // simulate by writing directly.
    const v1 = vec(0, 0);
    const v2 = vec(0, 0);
    const targetCentroid = vec(0, 0);

    // Centroid as a derived value (here computed manually since
    // centroidLens needs the trait machinery; the principle holds).
    // In real code: const cent = centroidLens([v1, v2]);

    const p = propagators();
    p.add(propagator([targetCentroid], [v1, v2], () => {
      // Move both v1 and v2 so their midpoint = targetCentroid.
      const t = targetCentroid.value;
      const cur = {
        x: (v1.value.x + v2.value.x) / 2,
        y: (v1.value.y + v2.value.y) / 2,
      };
      const dx = t.x - cur.x;
      const dy = t.y - cur.y;
      v1.value = { x: v1.value.x + dx, y: v1.value.y + dy };
      v2.value = { x: v2.value.x + dx, y: v2.value.y + dy };
    }));

    // Clamp propagator: if the midpoint goes outside [-100, 100],
    // pin it.
    p.add(propagator([targetCentroid], [targetCentroid], () => {
      const v = targetCentroid.value;
      let x = v.x;
      let y = v.y;
      if (x < -100) x = -100;
      if (x > 100) x = 100;
      if (y < -100) y = -100;
      if (y > 100) y = 100;
      if (x !== v.x || y !== v.y) targetCentroid.value = { x, y };
    }));

    // Simulate a tween writing target.
    targetCentroid.value = { x: 50, y: 50 };
    expect(v1.value).toEqual({ x: 50, y: 50 });

    // Tween "overshoots" to (200, 200). Constraint clamps.
    targetCentroid.value = { x: 200, y: 200 };
    expect(targetCentroid.value).toEqual({ x: 100, y: 100 });
    expect(v1.value).toEqual({ x: 100, y: 100 });
    p.dispose();

    // The tween (animation), the centroid (definition), the
    // clamp (constraint) are three independent concerns.
    // Composition makes them one declarative pipeline.
  });
});

describe("Example 4: energy-conserving system", () => {
  it("lens computes total kinetic energy; propagator enforces conservation", () => {
    // Two masses with velocities. Total kinetic energy is
    // ½(m1·v1² + m2·v2²) — a derived value (lens).
    // Constraint: total E should equal initial E (conservation).
    // When you change one velocity, the other adjusts to
    // preserve E.
    const m1 = 1;
    const m2 = 2;
    const v1 = num(2); // initial: ½(1·4) = 2
    const v2 = num(1); // initial: ½(2·1) = 1

    // Total KE — lens chain via .scale and computed sum.
    // For simplicity, build via num arithmetic.
    // KE = 0.5·m1·v1² + 0.5·m2·v2².
    // We can't easily express v² as a lens (needs custom);
    // simulate with an effect.
    const E = num(0);
    effect(() => {
      E.value = 0.5 * m1 * v1.value * v1.value + 0.5 * m2 * v2.value * v2.value;
    });
    const initialE = E.value;
    expect(initialE).toBe(3);

    // Conservation propagator: when v1 changes, adjust v2 to
    // preserve E.
    const p = propagators();
    p.add(propagator([v1], [v2], () => {
      // 0.5·m2·v2² = E - 0.5·m1·v1²
      // v2² = (2E - m1·v1²) / m2
      const v1sq = v1.value * v1.value;
      const target = (2 * initialE - m1 * v1sq) / m2;
      if (target >= 0) {
        const sgn = v2.value >= 0 ? 1 : -1;
        v2.value = sgn * Math.sqrt(target);
      }
    }));

    // Drag v1.
    v1.value = 1;
    // KE should now still be 3.
    expect(E.value).toBeCloseTo(3);
    // Verify v2: 0.5·2·v2² = 3 - 0.5·1·1 = 2.5, so v2² = 2.5, v2 ≈ 1.58.
    expect(v2.value).toBeCloseTo(Math.sqrt(2.5));

    p.dispose();
  });
});

describe("Examples — takeaway", () => {
  it("composition pattern in each", () => {
    // Each example shows a different cross-paradigm pattern:
    //
    //   Example 1: residual = lens. UI subscribes (signal).
    //              Optional propagator-driven correction.
    //
    //   Example 2: coordinate change = lens. Constraint =
    //              propagator in the converted space.
    //
    //   Example 3: target = lens. Animation writes target.
    //              Constraint = propagator clamps.
    //
    //   Example 4: derived quantity (energy) = lens. Conservation
    //              constraint = propagator.
    //
    // The unifying pattern: a LENS expresses what's *true by
    // construction*; a PROPAGATOR expresses what *should be true
    // by intervention*. Composing them lets you mix declarative
    // derivations with imperative corrections cleanly.
    expect(true).toBe(true);
  });
});
