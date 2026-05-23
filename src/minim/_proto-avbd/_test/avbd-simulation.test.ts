// avbd-simulation.test.ts — Simulation wrapper exercises.

import { describe, expect, it } from "vitest";
import type { Tick } from "../../core/anim";
import { vec } from "../../signals";
import { distance, Simulation, Solver, spring } from "../index";

describe("Simulation — composes solver + time-stepping", () => {
  it("velocity is per-cell, lazily allocated; mass=0 cells skip update", () => {
    const a = vec(0, 0);
    const b = vec(1, 0);
    const s = new Solver();
    distance(s, a, b, 1); // forces them both bound
    s.pin(a);
    const sim = new Simulation(s, { gravity: [0, -10] });
    const aId = s.bind(a);
    const bId = s.bind(b);
    expect(sim.velocity(aId).length).toBe(2);
    expect(sim.velocity(bId).length).toBe(2);

    sim.tick(1 / 60);
    expect(sim.velocity(aId)[1]!).toBe(0); // pinned, no update
    expect(sim.velocity(bId)[1]!).toBeLessThan(0); // fell
  });

  it("pendulum: bob swings under gravity, distance preserved", () => {
    const anchor = vec(0, 0);
    const bob = vec(1, 0);
    const s = new Solver({ iterations: 8, alpha: 0.99 });
    distance(s, anchor, bob, 1);
    s.pin(anchor);

    const sim = new Simulation(s, { gravity: [0, -10] });
    let maxOffset = 0;
    for (let i = 0; i < 60; i++) {
      sim.tick(1 / 60);
      maxOffset = Math.max(maxOffset, Math.abs(bob.value.x - 1));
    }
    expect(Math.hypot(bob.value.x, bob.value.y)).toBeCloseTo(1, 1);
    expect(maxOffset).toBeGreaterThan(0.05);
  });

  it("animate() is a Tick-driven generator", () => {
    const a = vec(0, 0);
    const b = vec(0, 0);
    const s = new Solver({ iterations: 4, alpha: 0.99 });
    spring(s, a, b, 0, 1e3);
    s.pin(a);
    const sim = new Simulation(s, { gravity: [0, -10] });
    const gen = sim.animate();
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
      const s = new Solver({ iterations: 6, alpha: 0.99 });
      distance(s, top, bob, 1);
      s.pin(top);
      const sim = new Simulation(s, { gravity: [0.5, 0] });
      return { sim, bob };
    };

    const fast = buildSim();
    const slow = buildSim();
    for (let i = 0; i < 30; i++) {
      fast.sim.tick(1 / 60);
      slow.sim.tick(1 / 600);
    }
    expect(Math.abs(slow.bob.value.x)).toBeLessThan(Math.abs(fast.bob.value.x) * 0.5);
  });

  it("static editing: bare solver with raw cell ids works without Simulation", () => {
    const s = new Solver({ iterations: 20 });
    const a = s.addCell(2, [0, 0]);
    const b = s.addCell(2, [5, 0]);
    s.setMass(a, 0);
    // Direct hand-rolled Force usage isn't part of the API; we skip
    // and just confirm static state survives a step().
    s.step();
    expect(s.read(a)).toEqual([0, 0]);
  });
});
