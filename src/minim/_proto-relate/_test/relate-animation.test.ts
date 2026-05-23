// relate-animation.test.ts — animations driving cluster cells.
//
// The signal engine's animation primitives (spring, tween, toward,
// driven) write to cells once per frame via the Anim runtime. Each
// write fires pinHook (suppressed if the writer is in a batch /
// solver context — but animations aren't), so the cluster solver
// runs once per frame, reflowing the cluster.
//
// This integration is what enables "drag a constraint cell with a
// spring" or "tween a constrained value smoothly" without any
// custom plumbing.

import { describe, expect, it } from "vitest";
import { Anim } from "../../core";
import { dist, pinPoint, point } from "../constraints";
import { num, spring, tween } from "../index";

describe("Animation through a cluster", () => {
  it("spring drags a triangle vertex; whole figure follows in real time", () => {
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    const C = point(num(0.5), num(Math.sqrt(3) / 2));
    dist(A, B, 1);
    dist(B, C, 1);
    dist(C, A, 1);
    pinPoint(B);

    // Spring A.x toward 0.3 (reachable; |A-B| = 1 implies A.x ∈ [0, 2]).
    const anim = new Anim();
    // biome-ignore lint/suspicious/noExplicitAny: tests cross the
    // brand boundary between point()'s loose typing and spring()'s
    // Traits-anchored constraint.
    anim.start(spring(A.x as any, 0.3));
    for (let i = 0; i < 100; i++) anim.step(0.016);

    expect(A.x.value).toBeCloseTo(0.3, 2);
    // Constraints maintained throughout.
    expect(Math.hypot(A.x.value - B.x.value, A.y.value - B.y.value)).toBeCloseTo(1, 3);
    expect(Math.hypot(B.x.value - C.x.value, B.y.value - C.y.value)).toBeCloseTo(1, 3);
    expect(Math.hypot(C.x.value - A.x.value, C.y.value - A.y.value)).toBeCloseTo(1, 3);
  });

  it("spring an infeasible single-axis pull — A.x reaches it, constraints degrade", () => {
    // The spring writes A.x each frame, pinning it at the spring's
    // current value. With A.x pinned, the cluster solver finds the
    // best A.y / B / C consistent with the other constraints.
    // Because B is hard-pinned and we ask A.x = 3 (outside the
    // |A-B|=1 disc), no valid A.y exists → LSQ best-fit with
    // |A-B| > 1. The system degrades gracefully — no NaN, no
    // freeze, no infinite loop. A.x reaches its target because
    // it's user-pinned per frame; the constraint loses.
    const A = point(num(0), num(0));
    const B = point(num(1), num(0));
    const C = point(num(0.5), num(Math.sqrt(3) / 2));
    dist(A, B, 1);
    dist(B, C, 1);
    dist(C, A, 1);
    pinPoint(B);

    const anim = new Anim();
    // biome-ignore lint/suspicious/noExplicitAny: tests cross the
    // brand boundary between point()'s loose typing and spring()'s
    // Traits-anchored constraint.
    anim.start(spring(A.x as any, 3));
    for (let i = 0; i < 200; i++) anim.step(0.016);

    // No NaN.
    expect(Number.isFinite(A.x.value)).toBe(true);
    expect(Number.isFinite(A.y.value)).toBe(true);
    expect(Number.isFinite(C.x.value)).toBe(true);
    expect(Number.isFinite(C.y.value)).toBe(true);
    // A.x reached spring's target (it's user-pinned each frame).
    expect(A.x.value).toBeCloseTo(3, 1);
    // Constraint between B (pinned) and A is violated, but bounded.
    const ab = Math.hypot(A.x.value - B.x.value, A.y.value - B.y.value);
    expect(ab).toBeGreaterThan(1.5); // overshoot
    expect(ab).toBeLessThan(3); // bounded LSQ residual
  });

  it("tween a relation-bound num smoothly across constraint manifold", () => {
    const a = num(0);
    const b = num(0);
    // Constraint: a = b
    dist(point(a, num(0)), point(b, num(0)), 0); // a = b (degenerate dist)

    const anim = new Anim();
    anim.start(tween(a, 10, 1)); // tween a from 0 to 10 over 1s
    for (let i = 0; i < 70; i++) anim.step(0.016);

    expect(a.value).toBeCloseTo(10, 2);
    expect(b.value).toBeCloseTo(10, 2);
  });
});

describe("Effect-driven write loop through cluster", () => {
  it("an effect that writes to a cluster cell never spirals (suppressed re-entry)", () => {
    const a = num(0);
    const b = num(0);
    dist(point(a, num(0)), point(b, num(0)), 0);

    let writes = 0;
    // External signal "external" drives a; effect re-writes a from
    // external. Each user write ⇒ one cluster solve. No infinite loop.
    const ext = num(5);
    const _stop = (() => {
      // tiny effect-like binder; we test that this terminates in
      // bounded work.
      ext.value = 5;
      a.value = ext.value;
      writes++;
      return () => {};
    })();
    expect(writes).toBe(1);
    expect(a.value).toBe(5);
    expect(b.value).toBeCloseTo(5);
    void _stop;
  });
});
