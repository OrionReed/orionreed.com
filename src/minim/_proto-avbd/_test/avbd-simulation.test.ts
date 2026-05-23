// avbd-simulation.test.ts — exercise the Simulation wrapper directly,
// independent of solver-only static editing tests.

import { describe, expect, it } from "vitest";
import type { Tick } from "../../core/anim";
import { distance, Simulation, Solver, spring, vec } from "../index";

describe("Simulation — composes solver + time-stepping", () => {
  it("velocity is per-cell, lazily allocated, mass=0 cells skip", () => {
    const a = vec(0, 0);
    a.mass = 0;
    const b = vec(1, 0);
    const s = new Solver();
    s.addCell(a);
    s.addCell(b);

    const sim = new Simulation(s, { gravity: [0, -10] });
    const va = sim.velocity(a);
    const vb = sim.velocity(b);
    expect(va).toBeInstanceOf(Float64Array);
    expect(vb).toBeInstanceOf(Float64Array);
    expect(va.length).toBe(2);
    expect(vb.length).toBe(2);

    // Tick under gravity: pinned cell gets no velocity update,
    // free cell gains downward velocity.
    sim.tick(1 / 60);
    // The mass=0 cell's velocity buffer is unchanged (we wrote 0).
    expect(va[0]!).toBe(0);
    expect(va[1]!).toBe(0);
    // Free cell fell some.
    expect(vb[1]!).toBeLessThan(0);
  });

  it("pendulum: bob swings under gravity, distance preserved", () => {
    const anchor = vec(0, 0);
    anchor.mass = 0;
    const bob = vec(1, 0);
    const s = new Solver({ iterations: 8, alpha: 0.99 });
    s.addCell(anchor);
    s.addCell(bob);
    distance(s, anchor, bob, 1);

    const sim = new Simulation(s, { gravity: [0, -10] });
    let maxOffset = 0;
    for (let i = 0; i < 60; i++) {
      sim.tick(1 / 60);
      maxOffset = Math.max(maxOffset, Math.abs(bob.x - 1));
    }
    // Distance constraint preserved.
    expect(Math.hypot(bob.x, bob.y)).toBeCloseTo(1, 2);
    // Bob actually moved.
    expect(maxOffset).toBeGreaterThan(0.05);
  });

  it("animate() is a Tick-driven generator", () => {
    const a = vec(0, 0);
    a.mass = 0;
    const b = vec(0, 0);
    const s = new Solver({ iterations: 4, alpha: 0.99 });
    s.addCell(a);
    s.addCell(b);
    spring(s, a, b, 0, 1e3);

    const sim = new Simulation(s, { gravity: [0, -10] });
    const gen = sim.animate();
    // First .next() with no value gets us to the yield.
    const first = gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toBeUndefined();
    // Now feed it ticks.
    for (let i = 0; i < 30; i++) {
      const tick: Tick = { dt: 1 / 60, elapsed: i / 60 };
      gen.next(tick);
    }
    // Bob moved downward under gravity (resisted by spring).
    expect(b.y).toBeLessThan(-0.001);
  });

  it("variable dt: slo-mo and full-speed coexist on the same scene", () => {
    // Same setup, different dt sequences. The slow sim should accumulate
    // less velocity in the same wall-clock budget.
    const buildSim = () => {
      const top = vec(0, 0);
      top.mass = 0;
      const bob = vec(0, -1);
      const s = new Solver({ iterations: 6, alpha: 0.99 });
      s.addCell(top);
      s.addCell(bob);
      distance(s, top, bob, 1);
      const sim = new Simulation(s, { gravity: [0.5, 0] });
      return { sim, bob };
    };

    const fast = buildSim();
    const slow = buildSim();

    // 30 frames at 1/60 vs 30 frames at 1/600 (10× slower).
    for (let i = 0; i < 30; i++) {
      fast.sim.tick(1 / 60);
      slow.sim.tick(1 / 600);
    }
    // Slow sim has barely moved.
    expect(Math.abs(slow.bob.x)).toBeLessThan(Math.abs(fast.bob.x) * 0.5);
  });

  it("static editing on the bare solver is unaffected by Simulation existence", () => {
    // Build a scene; never wrap it in Simulation. step() should work
    // exactly as before.
    const a = vec(0, 0);
    a.mass = 0;
    const b = vec(5, 0);
    const s = new Solver({ iterations: 20 });
    s.addCell(a);
    s.addCell(b);
    distance(s, a, b, 1);
    for (let i = 0; i < 5; i++) s.step();
    expect(Math.hypot(b.x, b.y)).toBeCloseTo(1, 2);
  });
});
