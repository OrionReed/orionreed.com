// rigid-basic.test.ts — sanity tests for the 2D rigid-body extension.

import { describe, expect, it } from "vitest";
import { type Body, BoxContact, body, bodyAnchor, joint, world } from "../index";

describe("box-box SAT collide", () => {
  it("box overlapping ground produces contacts", () => {
    const w = world({ gravity: [0, -10] });
    const ground = w.add(body({ size: { w: 50, h: 1 }, density: 0 }, { x: 0, y: 0 }));
    const box = w.add(body({ size: { w: 1, h: 1 } }, { x: 0, y: 0.5 })); // overlapping
    const m = new BoxContact(w.solver, ground as Body, box as Body);
    w.solver.addTerm(m);
    const ok = m.initialize();
    expect(ok).toBe(true);
    expect(m.numContacts).toBeGreaterThan(0);
  });

  it("box well above ground produces no contacts", () => {
    const w = world({ gravity: [0, -10] });
    const ground = w.add(body({ size: { w: 50, h: 1 }, density: 0 }, { x: 0, y: 0 }));
    const box = w.add(body({ size: { w: 1, h: 1 } }, { x: 0, y: 10 }));
    const m = new BoxContact(w.solver, ground as Body, box as Body);
    m.initialize();
    expect(m.numContacts).toBe(0);
  });
});

describe("world — basics", () => {
  it("box falls under gravity", () => {
    const w = world({ gravity: [0, -10], iterations: 10, postStabilize: true });
    const box = w.add(body({ size: { w: 1, h: 1 } }, { x: 0, y: 10 }));
    const y0 = box.pose.value.y;
    for (let f = 0; f < 30; f++) w.step(1 / 60);
    const yEnd = box.pose.value.y;
    // Free-fall for 0.5 sec at g=10 → drop ≈ 1.25.
    expect(y0 - yEnd).toBeGreaterThan(0.5);
    expect(y0 - yEnd).toBeLessThan(2);
  });

  it("box rests on a static ground", () => {
    const w = world({ gravity: [0, -10], iterations: 10, postStabilize: true });
    const ground = w.add(body({ size: { w: 50, h: 1 }, density: 0 }, { x: 0, y: 0 }));
    const box = w.add(body({ size: { w: 1, h: 1 } }, { x: 0, y: 5 }));
    for (let f = 0; f < 240; f++) w.step(1 / 60);
    // Box should rest on top of ground (y ≈ ground.top + box.h/2 = 0.5 + 0.5 = 1).
    const p = box.pose.value;
    expect(p.y).toBeGreaterThan(0.4);
    expect(p.y).toBeLessThan(1.5);
    expect(Number.isFinite(p.theta)).toBe(true);
    void ground;
  });

  it("static body has zero mass", () => {
    const w = world({ gravity: [0, -10] });
    const ground = w.add(body({ size: { w: 50, h: 1 }, density: 0 }, { x: 0, y: 0 }));
    expect(ground.mass).toBe(0);
    expect(w.solver.massOf(ground.cellId)).toBe(0);
  });

  it("body's mass matrix is diag(m, m, I)", () => {
    const w = world();
    const box = w.add(body({ size: { w: 2, h: 1 }, density: 1 }, { x: 0, y: 0 }));
    const off = w.solver.offsets[box.cellId]!;
    const masses = w.solver.masses;
    expect(masses[off]!).toBeCloseTo(2); // m = 2*1*1
    expect(masses[off + 1]!).toBeCloseTo(2);
    expect(masses[off + 2]!).toBeCloseTo((2 * (4 + 1)) / 12); // I = m*(w² + h²)/12
  });

  it("two stacked boxes settle", () => {
    const w = world({ gravity: [0, -10], iterations: 12, postStabilize: true });
    w.add(body({ size: { w: 50, h: 1 }, density: 0 }, { x: 0, y: 0 }));
    const b1 = w.add(body({ size: { w: 1, h: 1 } }, { x: 0, y: 5 }));
    const b2 = w.add(body({ size: { w: 1, h: 1 } }, { x: 0, y: 7 }));
    for (let f = 0; f < 480; f++) w.step(1 / 60);
    const p1 = b1.pose.value;
    const p2 = b2.pose.value;
    expect(Number.isFinite(p1.y)).toBe(true);
    expect(Number.isFinite(p2.y)).toBe(true);
    // b2 should be above b1.
    expect(p2.y).toBeGreaterThan(p1.y);
    // Stack is roughly y = 1, 2 (centres).
    expect(p1.y).toBeGreaterThan(0.4);
    expect(p2.y).toBeGreaterThan(1.4);
  });

  it("settled stack has near-zero residual velocity (no perpetual jitter)", () => {
    const w = world({ gravity: [0, -10], iterations: 14, postStabilize: true });
    w.add(body({ size: { w: 50, h: 1 }, density: 0, friction: 0.6 }, { x: 0, y: 0 }));
    const boxes = [];
    for (let i = 0; i < 5; i++) {
      boxes.push(w.add(body({ size: { w: 1, h: 1 }, friction: 0.5 }, { x: 0, y: 5 + i * 1.05 })));
    }
    for (let f = 0; f < 600; f++) w.step(1 / 60);
    let maxV = 0;
    for (const b of boxes) {
      const v = w.velocity(b.cellId);
      const speed = Math.hypot(v[0]!, v[1]!) + Math.abs(v[2]!);
      if (speed > maxV) maxV = speed;
    }
    expect(maxV).toBeLessThan(0.5);
  });

  it("joint: pendulum swings under gravity", () => {
    const w = world({ gravity: [0, -10], iterations: 12, postStabilize: true });
    const anchor = w.add(body({ size: { w: 0.2, h: 0.2 }, density: 0 }, { x: 0, y: 5 }));
    // Bob is a 1m bar; joint connects anchor's local (0,0) to bob's
    // left-end local (-0.5, 0). Pendulum length = 0.5m (anchor to bob center).
    const bob = w.add(body({ size: { w: 1, h: 0.2 } }, { x: 0.5, y: 5 }));
    w.add(joint(anchor, bob, { x: 0, y: 0 }, { x: -0.5, y: 0 }));
    let maxX = Number.NEGATIVE_INFINITY;
    let minX = Number.POSITIVE_INFINITY;
    for (let f = 0; f < 240; f++) {
      w.step(1 / 60);
      const p = bob.pose.value;
      maxX = Math.max(maxX, p.x);
      minX = Math.min(minX, p.x);
    }
    const p = bob.pose.value;
    const len = Math.hypot(p.x, p.y - 5);
    // Joint should hold the bob center at distance 0.5 from anchor.
    expect(len).toBeCloseTo(0.5, 1);
    // Pendulum should actually swing.
    expect(maxX - minX).toBeGreaterThan(0.2);
  });

  it("joint: 8-link rope stays bounded under gravity", () => {
    const w = world({ gravity: [0, -10], iterations: 14, postStabilize: true });
    const anchor = w.add(body({ size: { w: 0.2, h: 0.2 }, density: 0 }, { x: 0, y: 5 }));
    const link = 0.5;
    const bodies = [anchor];
    for (let i = 0; i < 8; i++) {
      const b = w.add(body({ size: { w: link, h: 0.1 } }, { x: link / 2 + i * link, y: 5 }));
      bodies.push(b);
      const prev = bodies[i]!;
      const rA = i === 0 ? { x: 0, y: 0 } : { x: link / 2, y: 0 };
      w.add(joint(prev, b, rA, { x: -link / 2, y: 0 }));
    }
    for (let f = 0; f < 240; f++) w.step(1 / 60);
    for (const b of bodies) {
      const p = b.pose.value;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(Math.abs(p.x)).toBeLessThan(50);
      expect(Math.abs(p.y)).toBeLessThan(50);
    }
  });

  it("perturbed stack at demo scale: sideways tap keeps tower standing", () => {
    // Mirrors the demo: pixel coordinates, gravity ≈ 1500, friction 0.5,
    // 44px boxes, 5-tall stack. Tap the tower with a sideways impulse on
    // the bottom box.
    const w = world({
      gravity: [0, 1500],
      iterations: 14,
      postStabilize: true,
    });
    w.add(body({ size: { w: 800, h: 16 }, density: 0, friction: 0.7 }, { x: 0, y: 200 }));
    const SIZE = 44;
    const boxes = [];
    for (let i = 0; i < 5; i++) {
      boxes.push(
        w.add(
          body(
            { size: { w: SIZE - 2, h: SIZE - 2 }, friction: 0.5 },
            { x: 0, y: 200 - 8 - SIZE / 2 - i * (SIZE + 1) },
          ),
        ),
      );
    }
    // Settle.
    for (let f = 0; f < 240; f++) w.step(1 / 60);
    const restY = boxes.map(b => b.pose.value.y);
    // Sideways kick on the bottom box. With fixed-dt sub-stepping
    // and λ warm-start decay restored, the stack should weather a
    // ~2.5× box-width per second kick without collapsing.
    const v0 = w.velocity(boxes[0]!.cellId);
    v0[0]! += 250;
    w.setVelocity(boxes[0]!.cellId, v0);
    for (let f = 0; f < 600; f++) w.step(1 / 60);
    for (let i = 1; i < boxes.length; i++) {
      const here = boxes[i]!.pose.value.y;
      const below = boxes[i - 1]!.pose.value.y;
      // Each box still above the one below — allow ~5px slack
      // for compaction / micro-rearrangement (settled stacks
      // grind down a tiny amount under steady gravity).
      expect(here).toBeLessThan(below + 5);
    }
    const topRest = restY[restY.length - 1]!;
    const topNow = boxes[boxes.length - 1]!.pose.value.y;
    // Top shouldn't have dropped more than one box height from rest.
    expect(topNow).toBeLessThan(topRest + SIZE);
  });

  it("settled stack at demo scale (44px boxes, g=1500) is at rest", () => {
    // The demo uses pixel coordinates with much larger gravity so
    // accelerations land in the "looks like physics on a screen"
    // regime. Same algorithm; this test pins jitter at the demo's
    // scale rather than the canonical 1m/g=10 one.
    const w = world({ gravity: [0, 1500], iterations: 14, postStabilize: true });
    w.add(body({ size: { w: 800, h: 16 }, density: 0, friction: 0.7 }, { x: 0, y: 200 }));
    const boxes = [];
    const SIZE = 44;
    for (let i = 0; i < 5; i++) {
      boxes.push(
        w.add(
          body(
            { size: { w: SIZE - 2, h: SIZE - 2 }, friction: 0.5 },
            { x: 0, y: 200 - 8 - SIZE / 2 - i * (SIZE + 1) },
          ),
        ),
      );
    }
    for (let f = 0; f < 600; f++) w.step(1 / 60);
    let maxLinearV = 0;
    let maxAngularV = 0;
    for (const b of boxes) {
      const v = w.velocity(b.cellId);
      maxLinearV = Math.max(maxLinearV, Math.hypot(v[0]!, v[1]!));
      maxAngularV = Math.max(maxAngularV, Math.abs(v[2]!));
    }
    console.log(
      `  demo-scale residual: linear=${maxLinearV.toFixed(4)}px/s, angular=${maxAngularV.toFixed(4)}rad/s`,
    );
    expect(maxLinearV).toBeLessThan(5);
    expect(maxAngularV).toBeLessThan(0.5);
  });
});

describe("BodyAnchor — soft drag", () => {
  it("pulls a free body toward the target", () => {
    const w = world({ gravity: [0, 0], damping: 0.95 });
    const b = w.add(body({ size: { w: 10, h: 10 } }, { x: 0, y: 0 }));
    const a = w.add(bodyAnchor(b, { x: 100, y: 0 }, 1e5));
    for (let f = 0; f < 240; f++) w.step(1 / 60);
    const p = b.pose.value;
    // Body settles within a pixel or so of the target.
    expect(Math.abs(p.x - 100)).toBeLessThan(2);
    expect(Math.abs(p.y)).toBeLessThan(0.5);
    w.remove(a);
  });

  it("dragged body cannot mush through a static wall", () => {
    // Wall to the right of the box; drag the box hard right. With
    // soft-anchor drag the box piles up against the wall instead of
    // teleporting through (which is what a position-write pin does).
    const w = world({ gravity: [0, 0], iterations: 20, postStabilize: true });
    w.add(body({ size: { w: 4, h: 100 }, density: 0, friction: 0.4 }, { x: 50, y: 0 }));
    const b = w.add(body({ size: { w: 20, h: 20 }, density: 1, friction: 0.4 }, { x: 0, y: 0 }));
    const a = w.add(bodyAnchor(b, { x: 200, y: 0 }, 5e4));
    for (let f = 0; f < 120; f++) w.step(1 / 60);
    const p = b.pose.value;
    // Box should be touching the wall (around x = 50 - 2 - 10 = 38),
    // not at the cursor (x = 200).
    expect(p.x).toBeGreaterThan(30);
    expect(p.x).toBeLessThan(45);
    w.remove(a);
  });
});
