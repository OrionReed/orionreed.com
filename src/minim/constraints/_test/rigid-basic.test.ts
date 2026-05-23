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
});
