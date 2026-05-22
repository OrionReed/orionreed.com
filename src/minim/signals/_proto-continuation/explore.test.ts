// explore.test.ts — exercise three framings of "signals + generators
// + lenses" with manually-stepped time to see what holds up.
//
// The goal isn't to write production primitives; it's to verify
// (a) the lens framing for continuation lenses,
// (b) the drag-vs-spring multi-writer scenario,
// (c) the cleanest expression of stateful interaction.

import { describe, expect, it } from "vitest";
import { effect, type Num as NumT, num, signal, type Writable } from "../index";

// A tiny scheduler stand-in: a list of frame callbacks, manually
// stepped with `tick(dt)`. Replaces `this.anim.start(drive(...))` so
// tests are deterministic.
class FakeAnim {
  private cbs = new Set<(dt: number) => boolean | void>();
  schedule(fn: (dt: number) => boolean | void): () => void {
    this.cbs.add(fn);
    return () => this.cbs.delete(fn);
  }
  tick(dt: number): void {
    for (const fn of [...this.cbs]) {
      const keep = fn(dt);
      if (keep === false) this.cbs.delete(fn);
    }
  }
}

// ── Framing 1: smoothLens (the "continuation lens") ──────────────

import { smoothLens } from "./explore";

// (we'll need to adjust the import shape; the explore.ts module
// exports `smoothLens(target, { duration, schedule })`).

describe("Framing 1: smoothLens as a continuation lens", () => {
  it("writes start a tween; reads return intermediate values", () => {
    const anim = new FakeAnim();
    const t = num(0);
    const animated = smoothLens(t, { duration: 1, schedule: f => anim.schedule(f) });

    animated.value = 10;
    // Right after the write, no time has passed; source unchanged.
    expect(t.peek()).toBe(0);
    // After 0.5s, halfway.
    anim.tick(0.5);
    expect(t.peek()).toBeCloseTo(5, 1);
    // After another 0.5s, at target.
    anim.tick(0.5);
    expect(t.peek()).toBe(10);
  });

  it("PutPut: second write cancels the first", () => {
    const anim = new FakeAnim();
    const t = num(0);
    const animated = smoothLens(t, { duration: 1, schedule: f => anim.schedule(f) });

    animated.value = 10;
    anim.tick(0.3); // partway through first tween
    const mid = t.peek(); // somewhere around 3
    animated.value = 20; // cancel; start new tween from `mid` to 20

    anim.tick(1); // run new tween to completion
    expect(t.peek()).toBe(20);
    // The PutPut "last-write-wins" semantic holds at the limit.
    void mid;
  });

  it("PutGet FAILS: immediately after write, the read is NOT the target", () => {
    const anim = new FakeAnim();
    const t = num(0);
    const animated = smoothLens(t, { duration: 1, schedule: f => anim.schedule(f) });

    animated.value = 10;
    // PutGet at t=0: get returns... 0 (the current state, unchanged).
    expect(animated.peek()).toBe(0); // NOT 10
    // PutGet at convergence: holds.
    anim.tick(1);
    expect(animated.peek()).toBe(10);
  });

  it("GetPut: writing the current value still spawns a (zero-distance) tween", () => {
    const anim = new FakeAnim();
    const t = num(5);
    const animated = smoothLens(t, { duration: 1, schedule: f => anim.schedule(f) });

    animated.value = animated.peek(); // writes 5 → tweens 5 to 5
    anim.tick(0.5);
    expect(t.peek()).toBe(5); // unchanged, as expected.
    anim.tick(0.5);
    expect(t.peek()).toBe(5);
    // But: did we run an effect for "no real change"? Yes — the
    // animator is running. That's a *side effect of writing*. So
    // GetPut holds at the value level but not at the scheduling level.
  });
});

// ── Framing 2: goalChaser (separation of intent vs state) ────────

import { goalChaser } from "./explore";

describe("Framing 2: goalChaser — drag writes goal, animator chases", () => {
  it("releasing drag mid-flight: source continues toward the held goal", () => {
    const anim = new FakeAnim();
    const { state, goal, stop } = goalChaser(0, 0, {
      k: 8,
      schedule: f => anim.schedule(f),
    });

    // Simulate drag: user moves pointer to 10.
    goal.value = 10;
    // Animator chases over time.
    for (let i = 0; i < 30; i++) anim.tick(0.016); // ~0.5s
    expect(state.value).toBeCloseTo(10, 0); // settled

    // User starts dragging again, sets goal to 20, then RELEASES while
    // the source is still moving. No more drag events. Source should
    // continue toward 20 — NOT tug back to 0 or jitter.
    goal.value = 20;
    anim.tick(0.05); // ~3 frames of motion
    const partial = state.peek();
    expect(partial).toBeGreaterThan(10);
    expect(partial).toBeLessThan(20);

    // Now: simulate "release" — user lifts finger. They might WANT
    // the source to go back to rest (0). To express that, the caller
    // writes goal := 0 on release.
    goal.value = 0;
    for (let i = 0; i < 60; i++) anim.tick(0.016); // ~1s
    expect(state.peek()).toBeCloseTo(0, 0);

    stop();
  });

  it("drag-pause behaviour: source settles at held goal, no jitter", () => {
    // The motivating problem: with `spring(sig, rest, { rate: ... })`,
    // a paused drag would let the spring fight the held value.
    // With goalChaser, the goal is just held; source settles at it.
    const anim = new FakeAnim();
    const { state, goal, stop } = goalChaser(0, 0, {
      k: 8,
      schedule: f => anim.schedule(f),
    });

    // User drags to 5, then pauses (no more goal writes).
    goal.value = 5;
    for (let i = 0; i < 30; i++) anim.tick(0.016); // ~0.5s

    // State should settle at 5; pause doesn't reverse it.
    expect(state.peek()).toBeCloseTo(5, 0);

    // 5 more frames with no goal change. State stays at 5.
    for (let i = 0; i < 5; i++) anim.tick(0.016);
    expect(state.peek()).toBeCloseTo(5, 0);

    stop();
  });
});

// ── Framing 3: lens algebra ON TOP of goal/state ────────────────

describe("Framing 3: lens chains compose with goal/state", () => {
  it("goal can be a lens (e.g., affine-transformed); writes propagate", () => {
    const anim = new FakeAnim();
    const { state, goal, stop } = goalChaser(0, 0, {
      k: 8,
      schedule: f => anim.schedule(f),
    });

    // Wrap goal in an affine lens: external "pointer" maps via x =
    // pointer * 0.1 to goal.
    const pointerToGoal = goal.affine(0.1, 0);
    // pointerToGoal.value = 100 should set goal = 10 (via affine inverse:
    // (100 - 0) / 0.1 = 1000? No — `affine(k, off)` is v ↦ v*k + off.
    // bwd: n ↦ (n - off) / k.
    // So pointerToGoal.value = 100 ⇒ goal = (100 - 0) / 0.1 = 1000.)
    // Let's check.
    pointerToGoal.value = 100;
    expect(goal.peek()).toBeCloseTo(1000); // affine bwd math.

    // Reset for the test we actually want:
    goal.value = 0;

    // Slider view: pointer ∈ [0, 100] maps to goal ∈ [0, 10].
    // Affine: pointer ↦ pointer * 0.1. So target = pointer.
    const slider = goal.affine(10, 0); // goal = slider.value / 10 - 0 ... wait
    // Hmm. v ↦ v * k + off. If goal = pointer/10, then pointer = goal*10.
    // So slider is the "view" of goal: slider.value = goal.value * 10.
    // Writing slider.value = 50 ⇒ goal = (50 - 0) / 10 = 5.
    slider.value = 50;
    expect(goal.peek()).toBe(5);

    for (let i = 0; i < 30; i++) anim.tick(0.016);
    expect(state.peek()).toBeCloseTo(5, 0);

    stop();
  });
});
