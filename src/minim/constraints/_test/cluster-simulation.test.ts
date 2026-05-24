// cluster-simulation.test.ts — physics() factory exercises.

import { describe, expect, it } from "vitest";
import type { Tick } from "../../core/anim";
import { vec } from "../../signals";
import { animate, constraints, distance, physics, pin, spring } from "../index";

describe("physics() — composes solver + time-stepping", () => {
  it("velocity is per-cell, lazily allocated; mass=0 cells skip update", () => {
    const a = vec(0, 0);
    const b = vec(1, 0);
    const s = physics({ gravity: [0, -10] });
    s.add(distance(a, b, 1)); // forces them both bound
    s.add(pin(a));
    const aId = s._bind(a);
    const bId = s._bind(b);
    expect(s.velocity(aId).length).toBe(2);
    expect(s.velocity(bId).length).toBe(2);

    s.step(1 / 60);
    expect(s.velocity(aId)[1]!).toBe(0); // pinned, no update
    expect(s.velocity(bId)[1]!).toBeLessThan(0); // fell
  });

  it("pendulum: bob swings under gravity, distance preserved", () => {
    const anchor = vec(0, 0);
    const bob = vec(1, 0);
    const s = physics({ gravity: [0, -10], iterations: 8, alpha: 0.99 });
    s.add(distance(anchor, bob, 1));
    s.add(pin(anchor));

    let maxOffset = 0;
    for (let i = 0; i < 60; i++) {
      s.step(1 / 60);
      maxOffset = Math.max(maxOffset, Math.abs(bob.value.x - 1));
    }
    expect(Math.hypot(bob.value.x, bob.value.y)).toBeCloseTo(1, 1);
    expect(maxOffset).toBeGreaterThan(0.05);
  });

  it("animate() is a Tick-driven generator", () => {
    const a = vec(0, 0);
    const b = vec(0, 0);
    const s = physics({ gravity: [0, -10], iterations: 4, alpha: 0.99 });
    s.add(spring(a, b, 0, 1e3));
    s.add(pin(a));
    const gen = animate(s);
    gen.next(); // first park
    for (let i = 0; i < 30; i++) {
      const tick: Tick = { dt: 1 / 60, elapsed: i / 60 };
      gen.next(tick);
    }
    expect(b.value.y).toBeLessThan(-0.001);
  });

  it("variable dt: slo-mo and full-speed coexist", () => {
    const buildSim = () => {
      const top = vec(0, 0);
      const bob = vec(0, -1);
      const s = physics({ gravity: [0.5, 0], iterations: 6, alpha: 0.99 });
      s.add(distance(top, bob, 1));
      s.add(pin(top));
      return { sim: s, bob };
    };

    const fast = buildSim();
    const slow = buildSim();
    for (let i = 0; i < 30; i++) {
      fast.sim.step(1 / 60);
      slow.sim.step(1 / 600);
    }
    expect(Math.abs(slow.bob.value.x)).toBeLessThan(Math.abs(fast.bob.value.x) * 0.5);
  });

  it("static editing: bare solver with raw cell ids works without physics", () => {
    const s = constraints({ iterations: 20 });
    const a = s.solver.addCell(2, [0, 0]);
    s.solver.addCell(2, [5, 0]);
    s.solver.setMass(a, 0);
    // Just confirm static state survives a solve().
    s.solver.prepare();
    s.solver.solve();
    expect(s.solver.read(a)).toEqual([0, 0]);
  });
});
