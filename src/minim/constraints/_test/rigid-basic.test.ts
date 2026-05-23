// rigid-basic.test.ts — sanity tests for the 2D rigid-body extension.

import { describe, expect, it } from "vitest";
import { Body, BoxContact, RigidWorld } from "../index";

describe("box-box SAT collide", () => {
  it("box overlapping ground produces contacts", () => {
    const w = new RigidWorld({ gravity: [0, -10] });
    const ground = w.add({ size: { w: 50, h: 1 }, density: 0 }, { x: 0, y: 0 });
    const box = w.add({ size: { w: 1, h: 1 } }, { x: 0, y: 0.5 }); // overlapping
    const m = new BoxContact(w.cluster.solver, ground as Body, box as Body);
    w.cluster.solver.addForce(m);
    const ok = m.initialize();
    expect(ok).toBe(true);
    expect(m.numContacts).toBeGreaterThan(0);
  });

  it("box well above ground produces no contacts", () => {
    const w = new RigidWorld({ gravity: [0, -10] });
    const ground = w.add({ size: { w: 50, h: 1 }, density: 0 }, { x: 0, y: 0 });
    const box = w.add({ size: { w: 1, h: 1 } }, { x: 0, y: 10 });
    const m = new BoxContact(w.cluster.solver, ground as Body, box as Body);
    m.initialize();
    expect(m.numContacts).toBe(0);
  });
});

describe("RigidWorld — basics", () => {
  it("box falls under gravity", () => {
    const w = new RigidWorld({ gravity: [0, -10], iterations: 10, postStabilize: true });
    const box = w.add({ size: { w: 1, h: 1 } }, { x: 0, y: 10 });
    const y0 = box.pose().y;
    for (let f = 0; f < 30; f++) w.step(1 / 60);
    const yEnd = box.pose().y;
    // Free-fall for 0.5 sec at g=10 → drop ≈ 1.25.
    expect(y0 - yEnd).toBeGreaterThan(0.5);
    expect(y0 - yEnd).toBeLessThan(2);
  });

  it("box rests on a static ground", () => {
    const w = new RigidWorld({ gravity: [0, -10], iterations: 10, postStabilize: true });
    const ground = w.add({ size: { w: 50, h: 1 }, density: 0 }, { x: 0, y: 0 });
    const box = w.add({ size: { w: 1, h: 1 } }, { x: 0, y: 5 });
    for (let f = 0; f < 240; f++) w.step(1 / 60);
    // Box should rest on top of ground (y ≈ ground.top + box.h/2 = 0.5 + 0.5 = 1).
    const p = box.pose();
    expect(p.y).toBeGreaterThan(0.4);
    expect(p.y).toBeLessThan(1.5);
    expect(Number.isFinite(p.theta)).toBe(true);
    void ground;
  });

  it("static body has zero mass", () => {
    const w = new RigidWorld({ gravity: [0, -10] });
    const ground = w.add({ size: { w: 50, h: 1 }, density: 0 }, { x: 0, y: 0 });
    expect(ground.mass).toBe(0);
    expect(w.cluster.solver.massOf(ground.cellId)).toBe(0);
  });

  it("body's mass matrix is diag(m, m, I)", () => {
    const w = new RigidWorld();
    const box = w.add({ size: { w: 2, h: 1 }, density: 1 }, { x: 0, y: 0 });
    const off = w.cluster.solver.offsets[box.cellId]!;
    const masses = w.cluster.solver.masses;
    expect(masses[off]!).toBeCloseTo(2); // m = 2*1*1
    expect(masses[off + 1]!).toBeCloseTo(2);
    expect(masses[off + 2]!).toBeCloseTo((2 * (4 + 1)) / 12); // I = m*(w² + h²)/12
  });

  it("two stacked boxes settle", () => {
    const w = new RigidWorld({ gravity: [0, -10], iterations: 12, postStabilize: true });
    w.add({ size: { w: 50, h: 1 }, density: 0 }, { x: 0, y: 0 });
    const b1 = w.add({ size: { w: 1, h: 1 } }, { x: 0, y: 5 });
    const b2 = w.add({ size: { w: 1, h: 1 } }, { x: 0, y: 7 });
    for (let f = 0; f < 480; f++) w.step(1 / 60);
    const p1 = b1.pose();
    const p2 = b2.pose();
    expect(Number.isFinite(p1.y)).toBe(true);
    expect(Number.isFinite(p2.y)).toBe(true);
    // b2 should be above b1.
    expect(p2.y).toBeGreaterThan(p1.y);
    // Stack is roughly y = 1, 2 (centres).
    expect(p1.y).toBeGreaterThan(0.4);
    expect(p2.y).toBeGreaterThan(1.4);
  });

  it("settled stack has near-zero residual velocity (no perpetual jitter)", () => {
    const w = new RigidWorld({ gravity: [0, -10], iterations: 14, postStabilize: true });
    w.add({ size: { w: 50, h: 1 }, density: 0, friction: 0.6 }, { x: 0, y: 0 });
    const boxes = [];
    for (let i = 0; i < 5; i++) {
      boxes.push(w.add({ size: { w: 1, h: 1 }, friction: 0.5 }, { x: 0, y: 5 + i * 1.05 }));
    }
    for (let f = 0; f < 600; f++) w.step(1 / 60);
    let maxV = 0;
    for (const b of boxes) {
      const off = w.cluster.solver.offsets[b.cellId]!;
      const vx = w.simulation.velocities[off]!;
      const vy = w.simulation.velocities[off + 1]!;
      const va = w.simulation.velocities[off + 2]!;
      const speed = Math.hypot(vx, vy) + Math.abs(va);
      if (speed > maxV) maxV = speed;
    }
    expect(maxV).toBeLessThan(0.5);
  });

  it("joint: pendulum swings under gravity", () => {
    const w = new RigidWorld({ gravity: [0, -10], iterations: 12, postStabilize: true });
    const anchor = w.add({ size: { w: 0.2, h: 0.2 }, density: 0 }, { x: 0, y: 5 });
    // Bob is a 1m bar; joint connects anchor's local (0,0) to bob's
    // left-end local (-0.5, 0). Pendulum length = 0.5m (anchor to bob center).
    const bob = w.add({ size: { w: 1, h: 0.2 } }, { x: 0.5, y: 5 });
    w.joint(anchor, bob, { x: 0, y: 0 }, { x: -0.5, y: 0 });
    let maxX = -Infinity;
    let minX = Infinity;
    for (let f = 0; f < 240; f++) {
      w.step(1 / 60);
      const p = bob.pose();
      maxX = Math.max(maxX, p.x);
      minX = Math.min(minX, p.x);
    }
    const p = bob.pose();
    const len = Math.hypot(p.x, p.y - 5);
    // Joint should hold the bob center at distance 0.5 from anchor.
    expect(len).toBeCloseTo(0.5, 1);
    // Pendulum should actually swing.
    expect(maxX - minX).toBeGreaterThan(0.2);
  });

  it("joint: 8-link rope stays bounded under gravity", () => {
    const w = new RigidWorld({ gravity: [0, -10], iterations: 14, postStabilize: true });
    const anchor = w.add({ size: { w: 0.2, h: 0.2 }, density: 0 }, { x: 0, y: 5 });
    const link = 0.5;
    const bodies = [anchor];
    for (let i = 0; i < 8; i++) {
      const b = w.add({ size: { w: link, h: 0.1 } }, { x: link / 2 + i * link, y: 5 });
      bodies.push(b);
      const prev = bodies[i]!;
      const rA = i === 0 ? { x: 0, y: 0 } : { x: link / 2, y: 0 };
      w.joint(prev, b, rA, { x: -link / 2, y: 0 });
    }
    for (let f = 0; f < 240; f++) w.step(1 / 60);
    for (const b of bodies) {
      const p = b.pose();
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Math.abs(p.x)).toBeLessThan(50);
      expect(Math.abs(p.y)).toBeLessThan(50);
    }
  });

  it("settled stack at demo scale (44px boxes, g=1500) is at rest", () => {
    // The demo uses pixel coordinates with much larger gravity so
    // accelerations land in the "looks like physics on a screen"
    // regime. Same algorithm; this test pins jitter at the demo's
    // scale rather than the canonical 1m/g=10 one.
    const w = new RigidWorld({ gravity: [0, 1500], iterations: 14, postStabilize: true });
    w.add({ size: { w: 800, h: 16 }, density: 0, friction: 0.7 }, { x: 0, y: 200 });
    const boxes = [];
    const SIZE = 44;
    for (let i = 0; i < 5; i++) {
      boxes.push(
        w.add(
          { size: { w: SIZE - 2, h: SIZE - 2 }, friction: 0.5 },
          { x: 0, y: 200 - 8 - SIZE / 2 - i * (SIZE + 1) },
        ),
      );
    }
    for (let f = 0; f < 600; f++) w.step(1 / 60);
    let maxLinearV = 0;
    let maxAngularV = 0;
    for (const b of boxes) {
      const off = w.cluster.solver.offsets[b.cellId]!;
      const vx = w.simulation.velocities[off]!;
      const vy = w.simulation.velocities[off + 1]!;
      const va = w.simulation.velocities[off + 2]!;
      maxLinearV = Math.max(maxLinearV, Math.hypot(vx, vy));
      maxAngularV = Math.max(maxAngularV, Math.abs(va));
    }
    console.log(`  demo-scale residual: linear=${maxLinearV.toFixed(4)}px/s, angular=${maxAngularV.toFixed(4)}rad/s`);
    expect(maxLinearV).toBeLessThan(5);
    expect(maxAngularV).toBeLessThan(0.5);
  });
});
