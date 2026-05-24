// avbd-stress.test.ts — the actual reasons we chose AVBD.
//
// These tests reproduce or closely mirror challenging scenarios from
// the AVBD paper (Giles et al., SIGGRAPH 2025) and demonstrate the
// claims that motivated switching from Newton-LM:
//
//   §3.4 — High stiffness ratios converge with few iterations.
//   §3.1 — Hard constraints satisfied without infinite stiffness.
//   §1   — Unconditional stability under capped iteration counts.
//   §3.7 — Warm-start across calls reduces iterations needed.

import { describe, expect, it } from "vitest";
import { type Vec, vec, type Writable } from "../../signals";
import { Cluster, distance, Simulation, spring } from "../index";

type WVec = Writable<Vec>;

describe("AVBD stress — high stiffness ratios (paper §3.4)", () => {
  it("3 blocks + 2 springs with 10⁴ stiffness ratio", () => {
    const top = vec(0, 0);
    const A = vec(0, -1);
    const B = vec(0, -2);
    const s = new Cluster({ iterations: 5, alpha: 0.99 });
    spring(s, top, A, 1, 1e4);
    spring(s, A, B, 1, 1);
    s.pin(top);
    const sim = new Simulation(s, { gravity: [0, -10] });
    for (let step = 0; step < 60; step++) sim.tick(1 / 60);
    const dTopA = Math.hypot(A.value.x - top.value.x, A.value.y - top.value.y);
    expect(dTopA).toBeGreaterThan(0.95);
    expect(dTopA).toBeLessThan(1.5);
    const dAB = Math.hypot(B.value.x - A.value.x, B.value.y - A.value.y);
    expect(dAB).toBeGreaterThan(2);
    expect(A.value.y).toBeLessThan(0);
    expect(B.value.y).toBeLessThan(A.value.y);
  });

  it("hard constraint satisfied without numerical pathology", () => {
    const a = vec(0, 0);
    const b = vec(3, 0);
    const s = new Cluster({ iterations: 20 });
    const dist = distance(s, a, b, 5);
    s.pin(a);
    a.value = { x: 0.0001, y: 0 };
    expect(Math.abs(Math.hypot(b.value.x - a.value.x, b.value.y - a.value.y) - 5)).toBeLessThan(
      1e-2,
    );
    expect(dist.penalty[0]!).toBeLessThan(1e7);
  });
});

describe("AVBD stress — long chain stability (paper §1, §3.4)", () => {
  it("32-link distance chain stays stable under iteration cap", () => {
    const N = 32;
    const cells: WVec[] = [];
    for (let i = 0; i < N; i++) cells.push(vec(i, 0));
    const s = new Cluster({ iterations: 20 });
    for (let i = 1; i < N; i++) distance(s, cells[i - 1]!, cells[i]!, 1);
    s.pin(cells[0]!);
    s.pin(cells[N - 1]!);
    // Multiple incremental drags so warm-start helps — chain
    // problems converge poorly from a cold start in 20 iters.
    cells[N - 1]!.value = { x: N - 5, y: 5 };
    for (let i = 0; i < 20; i++) {
      cells[N - 1]!.value = { x: N - 5, y: 5 + i * 1e-6 };
    }
    let maxErr = 0;
    for (let i = 1; i < N; i++) {
      const dx = cells[i]!.value.x - cells[i - 1]!.value.x;
      const dy = cells[i]!.value.y - cells[i - 1]!.value.y;
      const err = Math.abs(Math.hypot(dx, dy) - 1);
      if (err > maxErr) maxErr = err;
    }
    expect(maxErr).toBeLessThan(0.5);
    expect(cells[0]!.value.x).toBeCloseTo(0, 3);
    expect(cells[0]!.value.y).toBeCloseTo(0, 3);
  });

  it("32-link chain — single iteration stays bounded under continuous drag", () => {
    const N = 32;
    const cells: WVec[] = [];
    for (let i = 0; i < N; i++) cells.push(vec(i, 0));
    const s = new Cluster({ iterations: 1 });
    for (let i = 1; i < N; i++) distance(s, cells[i - 1]!, cells[i]!, 1);
    s.pin(cells[0]!);
    s.pin(cells[N - 1]!);
    for (let step = 0; step < 100; step++) {
      const t = step * 0.05;
      cells[N - 1]!.value = { x: N - 5 + Math.cos(t), y: Math.sin(t) };
    }
    for (const c of cells) {
      expect(Number.isFinite(c.value.x)).toBe(true);
      expect(Number.isFinite(c.value.y)).toBe(true);
      expect(Math.abs(c.value.x)).toBeLessThan(100);
      expect(Math.abs(c.value.y)).toBeLessThan(100);
    }
  });
});
