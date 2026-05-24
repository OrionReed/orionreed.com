// cluster-basic.test.ts — verify the write-attribution model.

import { describe, expect, it, vi } from "vitest";
import { batch, effect, num, type Vec, vec, type Writable } from "../../signals";
import { constraints, distance, eq, lensNum, leq } from "../index";

type WVec = Writable<Vec>;

describe("Cluster (writeBack) — basic correctness", () => {
  it("eq: pinned a, write a → b matches", () => {
    const c = constraints({ iterations: 10 });
    const a = num(3);
    const b = num(7);
    c.add(eq(a, b));
    c.pin(a);
    a.value = 5;
    expect(b.value).toBeCloseTo(5, 2);
  });

  it("distance: pinned a, drag → b at distance 5", () => {
    const c = constraints({ iterations: 20 });
    const a = vec(0, 0);
    const b = vec(1, 0);
    c.add(distance(a, b, 5));
    c.pin(a);
    a.value = { x: 0.001, y: 0 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(5, 1);
  });

  it("lensNum: pin b, write b → a back-propagates to b/2", () => {
    const c = constraints({ iterations: 30 });
    const a = num(0);
    const b = num(10);
    c.add(lensNum(a, b, x => 2 * x));
    c.pin(b);
    b.value = 10.0001;
    expect(a.value).toBeCloseTo(5, 1);
  });

  it("leq: a above b is pulled down", () => {
    const c = constraints({ iterations: 30 });
    const a = num(5);
    const b = num(3);
    c.add(leq(a, b));
    c.pin(b);
    b.value = 3.0001;
    expect(a.value).toBeLessThanOrEqual(b.value + 1e-2);
  });
});

describe("Cluster (writeBack) — structural single-fire", () => {
  it("one user write = one solver step (NOT two)", () => {
    const c = constraints({ iterations: 20 });
    const a = num(0);
    const b = num(0);
    c.add(eq(a, b));
    c.pin(a);
    // Trigger initial run via a write.
    a.value = 1;
    const stepSpy = vi.spyOn(c.solver, "step");

    a.value = 5;
    // Single solve. The cluster's writeBack to b excludes the
    // cluster effect from propagation, so it doesn't re-fire.
    expect(stepSpy).toHaveBeenCalledTimes(1);
    expect(b.value).toBeCloseTo(5, 1);

    stepSpy.mockRestore();
  });

  it("batch coalesces multiple writes; cluster runs once", () => {
    const c = constraints({ iterations: 20 });
    const a = num(0);
    const b = num(0);
    c.add(eq(a, b));
    c.pin(a);
    a.value = 1; // initial run
    const stepSpy = vi.spyOn(c.solver, "step");

    batch(() => {
      a.value = 2;
      a.value = 3;
      a.value = 4;
    });
    expect(stepSpy).toHaveBeenCalledTimes(1);
    expect(b.value).toBeCloseTo(4, 1);

    stepSpy.mockRestore();
  });

  it("subscriber sees post-solve value via standard effect()", () => {
    const c = constraints({ iterations: 20 });
    const a = num(3);
    const b = num(7);
    c.add(eq(a, b));
    c.pin(a);

    const observed: number[] = [];
    const dispose = effect(() => {
      observed.push(b.value);
    });
    expect(observed).toEqual([7]);

    a.value = 5;
    // The cluster's writeBack to b notifies b's other subs (the
    // user's effect) but not the cluster itself. The user's effect
    // re-runs and reads the solved value.
    expect(observed[observed.length - 1]).toBeCloseTo(5, 1);
    dispose();
  });
});

describe("Cluster (writeBack) — lens composition", () => {
  // Lens composition works transparently: the cluster reads
  // `a.x.value` (through the lens fwd) and writes `a.x.value = X`
  // via writeBack (through the lens bwd → writes parent →
  // propagates normally). Nothing about the lens is replaced.

  it("eq(a.x, b.x) with parent write propagates correctly", () => {
    const c = constraints({ iterations: 30 });
    const a = vec(0, 0);
    const b = vec(5, 5);
    c.add(eq(a.x, b.x));
    c.pin(a.x);
    a.value = { x: 3, y: 0 };
    expect(b.value.x).toBeCloseTo(3, 1);
    expect(b.value.y).toBeCloseTo(5, 1); // y untouched
  });

  it("eq(a.x, b.x) with lens-child write back-propagates", () => {
    const c = constraints({ iterations: 30 });
    const a = vec(0, 0);
    const b = vec(5, 5);
    c.add(eq(a.x, b.x));
    c.pin(a.x);
    a.x.value = 7;
    expect(a.value.x).toBeCloseTo(7, 1);
    expect(b.value.x).toBeCloseTo(7, 1);
  });
});

describe("Simulation — numerical robustness", () => {
  it("Simulation.tick(0) is a no-op (would otherwise divide by zero)", async () => {
    const { distance, Simulation } = await import("../index");
    const a = vec(0, 0);
    const b = vec(10, 0);
    const c = constraints();
    c.add(distance(a, b, 10));
    c.pin(a);
    const sim = new Simulation(c, { gravity: [0, 100] });
    sim.tick(0);
    sim.tick(0);
    sim.tick(1 / 60);
    expect(Number.isFinite(b.value.x)).toBe(true);
    expect(Number.isFinite(b.value.y)).toBe(true);
  });

  it("cloth grid under gravity settles (low residual velocity at end)", async () => {
    const { bend, Simulation, spring, Strength } = await import("../index");
    const W = 8;
    const H = 6;
    const SP = 20;
    const grid: WVec[][] = [];
    for (let j = 0; j < H; j++) {
      const row: WVec[] = [];
      for (let i = 0; i < W; i++) row.push(vec(i * SP, j * SP));
      grid.push(row);
    }
    // `postStabilize` + adaptive warm-start (default-on under gravity)
    // are the AVBD physics defaults; this test pins them in.
    const c = constraints({ iterations: 12, postStabilize: true });
    for (let j = 0; j < H; j++)
      for (let i = 1; i < W; i++) c.add(spring(grid[j]![i - 1]!, grid[j]![i]!, SP, Strength.MEDIUM));
    for (let i = 0; i < W; i++)
      for (let j = 1; j < H; j++) c.add(spring(grid[j - 1]![i]!, grid[j]![i]!, SP, Strength.MEDIUM));
    for (let j = 0; j < H; j++)
      for (let i = 2; i < W; i++) c.add(bend(grid[j]![i - 2]!, grid[j]![i - 1]!, grid[j]![i]!, 0.5));
    for (let i = 0; i < W; i++)
      for (let j = 2; j < H; j++) c.add(bend(grid[j - 2]![i]!, grid[j - 1]![i]!, grid[j]![i]!, 0.5));
    c.pin(grid[0]![0]!);
    c.pin(grid[0]![W - 1]!);

    const sim = new Simulation(c, { gravity: [0, 90], damping: 0.99 });
    for (let f = 0; f < 600; f++) sim.tick(1 / 60);

    let maxV = 0;
    for (let id = 0; id < c.solver.cellCount; id++) {
      const v = sim.velocity(id);
      maxV = Math.max(maxV, Math.hypot(v[0]!, v[1]!));
    }
    expect(maxV).toBeLessThan(2);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const v = grid[j]![i]!.value;
        expect(Number.isFinite(v.x)).toBe(true);
        expect(Number.isFinite(v.y)).toBe(true);
      }
    }
  });

  it("cloth recovers after aggressive drag (no compression / no jitter)", async () => {
    const { Simulation, spring, Strength } = await import("../index");
    const W = 14;
    const H = 10;
    const SP = 26;
    const grid: WVec[][] = [];
    for (let j = 0; j < H; j++) {
      const row: WVec[] = [];
      for (let i = 0; i < W; i++) row.push(vec(i * SP, j * SP));
      grid.push(row);
    }
    // Mirrors the `<md-cloth>` demo's actual config.
    const c = constraints({ iterations: 10 });
    for (let j = 0; j < H; j++)
      for (let i = 1; i < W; i++) c.add(spring(grid[j]![i - 1]!, grid[j]![i]!, SP, Strength.MEDIUM));
    for (let i = 0; i < W; i++)
      for (let j = 1; j < H; j++) c.add(spring(grid[j - 1]![i]!, grid[j]![i]!, SP, Strength.MEDIUM));
    c.pin(grid[0]![0]!);
    c.pin(grid[0]![W - 1]!);

    const sim = new Simulation(c, { gravity: [0, 90], damping: 0.94 });
    for (let f = 0; f < 60; f++) sim.tick(1 / 60);

    const drag = grid[H - 1]![W - 1]!;
    c.pin(drag);
    let seed = 31;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let f = 0; f < 60; f++) {
      drag.value = {
        x: (W - 1) * SP + (rand() - 0.5) * 200,
        y: (H - 1) * SP + (rand() - 0.5) * 200,
      };
      sim.tick(1 / 60);
    }
    const dragId = c._bind(drag);
    c.solver.setMass(dragId, 1);

    for (let f = 0; f < 600; f++) sim.tick(1 / 60);

    let maxV = 0;
    for (let id = 0; id < c.solver.cellCount; id++) {
      const v = sim.velocity(id);
      maxV = Math.max(maxV, Math.hypot(v[0]!, v[1]!));
    }
    // Empirically: across drag-seed sweeps this lands in the 1–5 px/sec
    // range (vs ~20 with the user's earlier STRONG/MEDIUM mix); 8 leaves
    // a safety margin for variation.
    expect(maxV).toBeLessThan(8);
    let minD = Infinity;
    for (let j = 0; j < H; j++) {
      for (let i = 1; i < W; i++) {
        const a = grid[j]![i - 1]!.value;
        const b = grid[j]![i]!.value;
        minD = Math.min(minD, Math.hypot(b.x - a.x, b.y - a.y));
      }
    }
    for (let i = 0; i < W; i++) {
      for (let j = 1; j < H; j++) {
        const a = grid[j - 1]![i]!.value;
        const b = grid[j]![i]!.value;
        minD = Math.min(minD, Math.hypot(b.x - a.x, b.y - a.y));
      }
    }
    expect(minD).toBeGreaterThan(SP * 0.5);
  });

  it("hanging chain settles (low residual velocity at end)", async () => {
    const { distance, Simulation } = await import("../index");
    const N = 20;
    const LINK = 12;
    const links: WVec[] = [];
    for (let i = 0; i < N; i++) links.push(vec(i * LINK, 0));
    const c = constraints({ iterations: 12, alpha: 0.99 });
    for (let i = 1; i < N; i++) c.add(distance(links[i - 1]!, links[i]!, LINK));
    c.pin(links[0]!);

    const sim = new Simulation(c, { gravity: [0, 220], damping: 0.985 });
    for (let f = 0; f < 600; f++) sim.tick(1 / 60);

    let maxV = 0;
    for (let id = 0; id < c.solver.cellCount; id++) {
      const v = sim.velocity(id);
      maxV = Math.max(maxV, Math.hypot(v[0]!, v[1]!));
    }
    expect(maxV).toBeLessThan(5);
  });
});

describe("Cluster — numerical robustness", () => {
  it("4-bar dragged into infeasible workspace stays bounded (lambda cap)", async () => {
    const { distance } = await import("../index");
    const c = constraints({ iterations: 16 });
    const O1 = vec(-100, 0);
    const O2 = vec(100, 0);
    const A = vec(-100, -80);
    const B = vec(100, -50);
    c.add(distance(O1, A, 80));
    c.add(distance(A, B, 220));
    c.add(distance(B, O2, 50));
    c.pin(O1);
    c.pin(O2);
    c.pin(B);

    let seed = 999;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    // Throw B through deeply infeasible territory (4-bar reach is
    // |O2 ± rocker| ≈ 50–150; we drag to 1000s).
    for (let i = 0; i < 500; i++) {
      B.value = { x: (rand() - 0.5) * 2000, y: (rand() - 0.5) * 2000 };
    }
    for (const sig of [A, B]) {
      expect(Number.isFinite(sig.value.x)).toBe(true);
      expect(Number.isFinite(sig.value.y)).toBe(true);
      expect(Math.abs(sig.value.x)).toBeLessThan(1e5);
      expect(Math.abs(sig.value.y)).toBeLessThan(1e5);
    }
  });

  it("aggressive random drag stays finite (no NaN poisoning)", async () => {
    const { distance, perpendicular } = await import("../index");
    const c = constraints({ iterations: 8 });
    const A = vec(0, 0);
    const B = vec(100, 0);
    const C = vec(100, 60);
    const D = vec(180, 60);
    c.add(distance(A, B, 100));
    c.add(distance(B, C, 60));
    c.add(distance(C, D, 80));
    // Intentionally use the duplicated-cell form: this used to feed
    // NaN through `solveSPD` whenever the local LHS went rank-
    // deficient. The guard in `_primalSweep` should keep positions
    // finite regardless.
    c.add(perpendicular(A, B, B, C));
    c.pin(A);

    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    for (let i = 0; i < 200; i++) {
      const ang = rand() * Math.PI * 2;
      const r = 50 + rand() * 200;
      A.value = { x: Math.cos(ang) * r, y: Math.sin(ang) * r };
    }
    for (const sig of [A, B, C, D]) {
      expect(Number.isFinite(sig.value.x)).toBe(true);
      expect(Number.isFinite(sig.value.y)).toBe(true);
    }
  });
});

describe("Cluster — constraint lifecycle", () => {
  it("cluster.remove(rel) removes the constraint at the next solve", () => {
    const c = constraints({ iterations: 20 });
    const a = num(0);
    const b = num(0);
    const link = c.add(eq(a, b));
    c.pin(a);
    a.value = 5;
    expect(b.value).toBeCloseTo(5, 2);

    c.remove(link);
    a.value = 9;
    expect(b.value).toBeCloseTo(5, 1); // b stays put — no longer linked
  });

  it("cluster.remove(rel) clears the underlying force", () => {
    const c = constraints({ iterations: 20 });
    const a = vec(0, 0);
    const b = vec(1, 0);
    const link = c.add(distance(a, b, 3));
    c.pin(a);
    a.value = { x: 0.0001, y: 0 };
    expect(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y)).toBeCloseTo(3, 1);

    c.remove(link);
    expect(c.solver.forces.length).toBe(0);
  });
});
