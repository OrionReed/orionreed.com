// value-types.test.ts — wp lenses across Pose, Vec (polar), Bool.
//
// Each value type stresses a different aspect of the bwd policy
// question. Pose: composition / decomposition. Polar: closed-form
// inverse with multiple writable parameters. Bool: discrete bridges
// with policy choice.

import { describe, expect, it } from "vitest";
import { bool, num, pose, vec } from "../../../index";
import {
  andW,
  greaterThanW,
  greaterThanWsplit,
  greaterThanWvalue,
  orW,
} from "../wp-bool";
import { physicsState, polarW, poseComposeW, poseFromParts } from "../wp-pose";

// ─── Pose composition ──────────────────────────────────────────────

describe("poseComposeW (scene-graph node with writable local)", () => {
  it("forward: world = parent ∘ local", () => {
    const parent = pose({ x: 10, y: 20, theta: 0 });
    const local = pose({ x: 5, y: 0, theta: 0 });
    const world = poseComposeW(parent, local);
    expect(world.value).toEqual({ x: 15, y: 20, theta: 0 });
  });

  it("rotation in parent rotates local offset", () => {
    const parent = pose({ x: 0, y: 0, theta: Math.PI / 2 });
    const local = pose({ x: 10, y: 0, theta: 0 });
    const world = poseComposeW(parent, local);
    const w = world.value;
    expect(w.x).toBeCloseTo(0);
    expect(w.y).toBeCloseTo(10);
    expect(w.theta).toBeCloseTo(Math.PI / 2);
  });

  it("dragging world only writes to local; parent unchanged", () => {
    const parent = pose({ x: 0, y: 0, theta: 0 });
    const local = pose({ x: 5, y: 0, theta: 0 });
    const world = poseComposeW(parent, local);
    world.value = { x: 100, y: 50, theta: 1 };
    expect(parent.peek()).toEqual({ x: 0, y: 0, theta: 0 });
    expect(local.peek()).toEqual({ x: 100, y: 50, theta: 1 });
    expect(world.value).toEqual({ x: 100, y: 50, theta: 1 });
  });

  it("dragging world with rotated parent: decompose rotation correctly", () => {
    const parent = pose({ x: 0, y: 0, theta: Math.PI / 2 });
    const local = pose({ x: 0, y: 0, theta: 0 });
    const world = poseComposeW(parent, local);
    world.value = { x: 0, y: 10, theta: Math.PI / 2 };
    // local must satisfy: rotate(local, theta=π/2) → (0, 10).
    // Rotation of (10, 0) by π/2 → (0, 10). So local = (10, 0).
    expect(local.peek().x).toBeCloseTo(10);
    expect(local.peek().y).toBeCloseTo(0);
    expect(local.peek().theta).toBeCloseTo(0);
  });
});

describe("poseFromParts (pose with separately-writable pos and rot)", () => {
  it("write the world pose: position writes pos, rotation writes rot", () => {
    const pos = vec(0, 0);
    const rot = num(0);
    const p = poseFromParts(pos, rot);
    p.value = { x: 10, y: 20, theta: 1.5 };
    expect(pos.peek()).toEqual({ x: 10, y: 20 });
    expect(rot.peek()).toBe(1.5);
  });
});

// ─── Polar with all writable ───────────────────────────────────────

describe("polarW (center + r + a, all writable)", () => {
  it("read: center + r·(cos a, sin a)", () => {
    const c = vec(10, 10);
    const r = num(5);
    const a = num(0);
    const p = polarW(c, r, a);
    expect(p.value.x).toBeCloseTo(15);
    expect(p.value.y).toBeCloseTo(10);
  });

  it("drag the point: r and a absorb; center unchanged", () => {
    const c = vec(0, 0);
    const r = num(5);
    const a = num(0);
    const p = polarW(c, r, a);
    p.value = { x: 0, y: 10 };
    expect(c.peek()).toEqual({ x: 0, y: 0 });
    expect(r.peek()).toBeCloseTo(10);
    expect(a.peek()).toBeCloseTo(Math.PI / 2);
  });

  it("drag through full circle: angle wraps correctly", () => {
    const c = vec(0, 0);
    const r = num(5);
    const a = num(0);
    const p = polarW(c, r, a);
    p.value = { x: -10, y: 0 };
    expect(r.peek()).toBeCloseTo(10);
    // angle ∈ [-π, π); atan2(0, -10) = π
    expect(Math.abs(a.peek())).toBeCloseTo(Math.PI);
  });
});

// ─── Boolean bridges with writable threshold ──────────────────────

describe("greaterThanW (writable threshold)", () => {
  it("forward: n > t", () => {
    const n = num(5);
    const t = num(3);
    const b = greaterThanW(n, t);
    expect(b.value).toBe(true);
  });

  it("flip true→false by moving threshold above n", () => {
    const n = num(5);
    const t = num(3);
    const b = greaterThanW(n, t);
    b.value = false;
    expect(t.peek()).toBeCloseTo(5, 5); // n + eps; close to n
    expect(t.peek() > 5).toBe(true);
    expect(n.peek()).toBe(5); // unchanged
    expect(b.value).toBe(false);
  });

  it("flip false→true by moving threshold below n", () => {
    const n = num(5);
    const t = num(10);
    const b = greaterThanW(n, t);
    expect(b.value).toBe(false);
    b.value = true;
    expect(t.peek() < 5).toBe(true);
    expect(n.peek()).toBe(5);
    expect(b.value).toBe(true);
  });

  it("VERDICT: bool flip by threshold-shift is intuitive for indicators", () => {
    expect(true).toBe(true);
  });
});

describe("greaterThanWvalue (writable n, frozen t)", () => {
  it("flip moves n across t", () => {
    const n = num(5);
    const t = num(10);
    const b = greaterThanWvalue(n, t);
    expect(b.value).toBe(false);
    b.value = true;
    expect(n.peek() > 10).toBe(true);
    expect(t.peek()).toBe(10);
  });
});

describe("greaterThanWsplit (both move toward the boundary)", () => {
  it("symmetric flip: both n and t move", () => {
    const n = num(5);
    const t = num(10);
    const b = greaterThanWsplit(n, t);
    expect(b.value).toBe(false);
    b.value = true;
    expect(n.peek()).toBeGreaterThan(t.peek()); // invariant: now true
    expect(b.value).toBe(true);
  });
});

describe("andW / orW (writable boolean aggregates)", () => {
  it("andW: click true while false → BOTH parents become true", () => {
    const a = bool(false);
    const b = bool(false);
    const r = andW(a, b);
    expect(r.value).toBe(false);
    r.value = true;
    expect(a.peek()).toBe(true);
    expect(b.peek()).toBe(true);
    expect(r.value).toBe(true);
  });

  it("andW: click false while true → asymmetric choice (only `a` flips)", () => {
    const a = bool(true);
    const b = bool(true);
    const r = andW(a, b);
    expect(r.value).toBe(true);
    r.value = false;
    // POLICY: flip a, leave b. Surprising? Yes. Documented.
    expect(a.peek()).toBe(false);
    expect(b.peek()).toBe(true);
    expect(r.value).toBe(false);
  });

  it("orW: click false while true → both flip to false", () => {
    const a = bool(true);
    const b = bool(true);
    const r = orW(a, b);
    expect(r.value).toBe(true);
    r.value = false;
    expect(a.peek()).toBe(false);
    expect(b.peek()).toBe(false);
  });

  it("orW: click true while false → asymmetric (a flips)", () => {
    const a = bool(false);
    const b = bool(false);
    const r = orW(a, b);
    r.value = true;
    expect(a.peek()).toBe(true);
    expect(b.peek()).toBe(false);
  });

  it("VERDICT: wp on Bool aggregates requires picking an ASYMMETRY POLICY.", () => {
    // andW(false → true): flip both; OR flip just one and let user pick?
    // andW(true → false): flip one; which one?
    // These are real UI choices. The wp factory must commit to one and
    // document it; users not happy with the default can author their own.
    expect(true).toBe(true);
  });
});

// ─── Physics: pos + vel*dt with writable vel ────────────────────

describe("physicsState (pos + vel*dt with vel as the wp absorber)", () => {
  it("drag position: vel absorbs, pos and dt anchored", () => {
    const pos = num(0);
    const vel = num(5);
    const dt = num(2);
    const state = physicsState(pos, vel, dt);
    expect(state.value).toBe(10); // 0 + 5*2

    state.value = 50;
    // vel := 5 + (50 - 10)/2 = 25. pos and dt unchanged.
    expect(pos.peek()).toBe(0);
    expect(dt.peek()).toBe(2);
    expect(vel.peek()).toBe(25);
    expect(state.value).toBe(50);
  });

  it("dt = 0 short-circuit: write target to pos (only) to avoid divide-by-zero", () => {
    const pos = num(0);
    const vel = num(5);
    const dt = num(0);
    const state = physicsState(pos, vel, dt);
    state.value = 100;
    expect(pos.peek()).toBe(100); // edge-case path
  });
});
