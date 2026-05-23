// relate-demo-projections.test.ts — composed demos showing the
// closed-form layer carrying real workloads end-to-end with zero
// Newton iterations.
//
// What this file demonstrates:
//   1. A constrained slider: clamp + snap + value-lens.
//   2. A through-lens chain (engine-level) auto-injected and solved.
//   3. A "rotor" — Vec normalised onto the unit circle, with an
//      angle-derived position fed by a softNum.
//   4. Cyclic angle: `wrap` keeps an accumulated angle bounded.
//
// In all of these, the cluster's `iters` should report 0 — the
// closed-form peeling pass handles everything before Newton even
// runs.

import { describe, expect, it } from "vitest";
import { clamp, lensNum, normalizeVec, snapToGrid, softNum, wrap } from "../constraints";
import { num, vec } from "../index";
import { clusterHealth } from "../relate";

describe("Constrained slider — clamp + snap + value-lens", () => {
  it("user drags slider to a value above max → clipped, snapped, lens-derived", () => {
    // sliderX ∈ [0, 100], snapped to multiples of 5.
    // sliderValue = sliderX / 100 * 50  (a 0..50 scale)
    const sliderX = num(0);
    const sliderValue = sliderX.through(
      px => (px / 100) * 50,
      v => (v / 50) * 100,
    );
    clamp(sliderX, 0, 100);
    snapToGrid(sliderX, 5);

    sliderX.value = 73; // out of grid, in range
    expect(sliderX.value).toBe(75); // snapped
    expect(sliderValue.value).toBeCloseTo(37.5);

    sliderX.value = 200; // out of range
    expect(sliderX.value).toBe(100); // clamped, then snapped (100 is on grid)
    expect(sliderValue.value).toBeCloseTo(50);

    sliderX.value = -10;
    expect(sliderX.value).toBe(0);
    expect(sliderValue.value).toBeCloseTo(0);

    // All in zero Newton iters — pure closed-form chain.
    expect(clusterHealth(sliderX)!.peek().iters).toBe(0);
  });

  it("write through value-lens: bwd → snap → clamp, all closed-form", () => {
    // Bidirectional: writing sliderValue propagates back to sliderX
    // via lens bwd, then sliderX gets snapped/clamped.
    const sliderX = num(50);
    const sliderValue = sliderX.through(
      px => (px / 100) * 50,
      v => (v / 50) * 100,
    );
    clamp(sliderX, 0, 100);
    snapToGrid(sliderX, 5);

    // Note: the through-lens is an engine-level lens. Writing it
    // sets the source via bwd. The cluster contains sliderX (via
    // clamp + snap relations); auto-injected lens relation links
    // sliderValue (when it's in cluster) to sliderX.
    //
    // Here sliderValue is NOT in the cluster (no relation
    // references it). Writing it just propagates to sliderX via
    // bwd; the cluster then runs corrections on sliderX.
    sliderValue.value = 23.7; // → sliderX = 47.4 → clamp ok → snap to 45
    expect(sliderX.value).toBe(45);
    // sliderValue reads through getter: 45/100 * 50 = 22.5
    expect(sliderValue.value).toBeCloseTo(22.5);
  });
});

describe("Through-lens chain in cluster — auto-injection", () => {
  it("a → b → c, all in cluster, zero Newton iters", () => {
    const a = num(1);
    const b = a.through(
      x => 2 * x,
      y => y / 2,
    );
    const c = b.through(
      x => x + 5,
      y => y - 5,
    );
    // All cells in cluster; no explicit user relation. The auto-
    // injected lens relations form the cluster.
    softNum(a, 7, 1); // pull a toward 7

    // Initial solve: softNum pulls a → 7. Lens chain derives b=14, c=19.
    // Wait — softNum is a relation, so the cluster has relations,
    // but a isn't pinned, so the softNum residual minimises in LSQ.
    // Without a strong pin, a settles at 7 (the soft target).
    // Lens then derives b, c.
    a.value = 7; // explicit pin to make the test deterministic
    expect(a.value).toBe(7);
    expect(b.value).toBeCloseTo(14);
    expect(c.value).toBeCloseTo(19);
    expect(clusterHealth(a)!.peek().iters).toBe(0);
  });

  it("pinning the tip of a chain back-propagates via composed bwd", () => {
    const a = num(0);
    const c = a
      .through(
        x => 2 * x,
        y => y / 2,
      )
      .through(
        x => x + 5,
        y => y - 5,
      );
    softNum(a, 0, 1); // weak pull on a; we'll override with c.value=…
    c.value = 19; // bwd: a = (19 - 5) / 2 = 7
    expect(a.value).toBeCloseTo(7);
    expect(c.value).toBeCloseTo(19);
  });
});

describe("Rotor — Vec normalised to unit circle", () => {
  it("drag a Vec; normalize corrects to unit length", () => {
    const v = vec(3, 4);
    normalizeVec(v); // unit length
    // After construction, v should be normalized.
    expect(Math.hypot(v.value.x, v.value.y)).toBeCloseTo(1, 5);

    v.value = { x: 6, y: 8 }; // length 10, will be clipped to 1
    expect(Math.hypot(v.value.x, v.value.y)).toBeCloseTo(1, 5);
    expect(v.value.x).toBeCloseTo(0.6, 5);
    expect(v.value.y).toBeCloseTo(0.8, 5);
    expect(clusterHealth(v)!.peek().iters).toBe(0);
  });

  it("with a target magnitude > 1", () => {
    const v = vec(1, 0);
    normalizeVec(v, 5);
    expect(Math.hypot(v.value.x, v.value.y)).toBeCloseTo(5, 5);

    v.value = { x: 30, y: 40 }; // length 50
    expect(Math.hypot(v.value.x, v.value.y)).toBeCloseTo(5, 5);
  });
});

describe("Cyclic angle — `wrap` keeps θ ∈ [-π, π)", () => {
  it("accumulating rotation wraps automatically", () => {
    const theta = num(0);
    wrap(theta, -Math.PI, Math.PI);
    theta.value = 4 * Math.PI + 0.1; // way out of range
    expect(theta.value).toBeCloseTo(0.1, 5);
    expect(clusterHealth(theta)!.peek().iters).toBe(0);

    theta.value = -10; // wraps too
    // -10 ≡ -10 + 4π ≈ -10 + 12.566 = 2.566; that's in range.
    expect(theta.value).toBeGreaterThan(-Math.PI);
    expect(theta.value).toBeLessThan(Math.PI);
  });

  it("hue wrapped to [0, 360)", () => {
    const hue = num(0);
    wrap(hue, 0, 360);
    hue.value = 720;
    expect(hue.value).toBe(0);
    hue.value = -30;
    expect(hue.value).toBe(330);
    hue.value = 180;
    expect(hue.value).toBe(180);
  });
});

describe("Combined: slider + lens + clamp + snap + softNum priors", () => {
  it("full chain solves in zero Newton iters with no contention", () => {
    // A typical UI control: a slider with snap + clamp, value-lens
    // through to a 0-1 normalised value, then through to a percent.
    const px = num(0);
    const norm = px.through(
      p => p / 100,
      n => n * 100,
    );
    const pct = norm.through(
      n => n * 100,
      p => p / 100,
    );
    clamp(px, 0, 100);
    snapToGrid(px, 1);

    px.value = 47.6; // → snap 48, in range, norm = 0.48, pct = 48
    expect(px.value).toBe(48);
    expect(norm.value).toBeCloseTo(0.48);
    expect(pct.value).toBeCloseTo(48);
    expect(clusterHealth(px)!.peek().iters).toBe(0);

    // Write to pct: bwd through both lenses, snap on px.
    pct.value = 73.4; // → norm = 0.734 → px = 73.4 → snap to 73
    expect(px.value).toBe(73);
    expect(norm.value).toBeCloseTo(0.73);
    expect(pct.value).toBeCloseTo(73);
  });
});
