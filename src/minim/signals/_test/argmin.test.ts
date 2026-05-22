// argmin.test.ts — scalar + 2D argmin lens behaviour.

import { describe, expect, it } from "vitest";
import { argminNum, argminVec, num } from "../index";

describe("argminNum — pulley / weighted-sum constraints", () => {
  it("a + b conserved; write to sum redistributes evenly", () => {
    const a = num(3);
    const b = num(7);
    const sum = argminNum([a, b], ([x, y]) => x + y, [1, 1]);
    expect(sum.value).toBe(10);
    sum.value = 20;
    expect(a.value).toBeCloseTo(8);
    expect(b.value).toBeCloseTo(12);
  });

  it("weights = [1, 0] freezes second input", () => {
    const a = num(3);
    const b = num(7);
    const sum = argminNum([a, b], ([x, y]) => x + y, [1, 0]);
    sum.value = 20;
    expect(a.value).toBeCloseTo(13);
    expect(b.value).toBe(7);
  });

  it("weighted distribution: Δa : Δb = w_a : w_b", () => {
    const a = num(0);
    const b = num(0);
    const sum = argminNum([a, b], ([x, y]) => x + y, [3, 1]);
    sum.value = 4;
    expect(a.value).toBeCloseTo(3);
    expect(b.value).toBeCloseTo(1);
  });
});

describe("argminVec — IK arms", () => {
  it("2-link arm converges to a target with iterative writes", () => {
    const a1 = num(0);
    const a2 = num(0);
    const L = 100;
    const tip = argminVec(
      [a1, a2],
      ([t1, t2]) => ({
        x: L * Math.cos(t1) + L * Math.cos(t1 + t2),
        y: L * Math.sin(t1) + L * Math.sin(t1 + t2),
      }),
      [1, 1],
    );
    for (let i = 0; i < 80; i++) tip.value = { x: 0, y: 150 };
    expect(tip.value.x).toBeCloseTo(0, 0);
    expect(tip.value.y).toBeCloseTo(150, 0);
  });

  it("3-link arm — handful of iterations is enough", () => {
    const a1 = num(0.1);
    const a2 = num(0.1);
    const a3 = num(0.1);
    const L = 80;
    const tip = argminVec(
      [a1, a2, a3],
      ([t1, t2, t3]) => ({
        x: L * (Math.cos(t1) + Math.cos(t1 + t2) + Math.cos(t1 + t2 + t3)),
        y: L * (Math.sin(t1) + Math.sin(t1 + t2) + Math.sin(t1 + t2 + t3)),
      }),
      [1, 1, 1],
    );
    for (let i = 0; i < 100; i++) tip.value = { x: 120, y: 80 };
    expect(tip.value.x).toBeCloseTo(120, 0);
    expect(tip.value.y).toBeCloseTo(80, 0);
  });

  it("unreachable target — gracefully stays in the reachable disc", () => {
    const a1 = num(0.1);
    const a2 = num(0.1);
    const tip = argminVec(
      [a1, a2],
      ([t1, t2]) => ({
        x: 100 * Math.cos(t1) + 100 * Math.cos(t1 + t2),
        y: 100 * Math.sin(t1) + 100 * Math.sin(t1 + t2),
      }),
      [1, 1],
    );
    for (let i = 0; i < 200; i++) tip.value = { x: 500, y: 0 };
    expect(Number.isFinite(tip.value.x)).toBe(true);
    expect(Number.isFinite(tip.value.y)).toBe(true);
    expect(Math.hypot(tip.value.x, tip.value.y)).toBeLessThanOrEqual(200 + 1e-6);
  });

  it("damping prevents wild swings near singularity", () => {
    const a1 = num(0);
    const a2 = num(0);
    const tip = argminVec(
      [a1, a2],
      ([t1, t2]) => ({
        x: 100 * Math.cos(t1) + 100 * Math.cos(t1 + t2),
        y: 100 * Math.sin(t1) + 100 * Math.sin(t1 + t2),
      }),
      [1, 1],
      { damping: 1e-3 },
    );
    tip.value = { x: 200, y: 5 };
    expect(Math.abs(a1.value)).toBeLessThan(1);
    expect(Math.abs(a2.value)).toBeLessThan(1);
  });

  it("10-link chain converges quickly", () => {
    const angles = Array.from({ length: 10 }, () => num(0.05));
    const L = 30;
    const tip = argminVec(
      angles,
      ts => {
        let x = 0,
          y = 0,
          sum = 0;
        for (const t of ts) {
          sum += t;
          x += L * Math.cos(sum);
          y += L * Math.sin(sum);
        }
        return { x, y };
      },
      angles.map(() => 1),
    );
    const target = { x: 100, y: 100 };
    let iters = 0;
    while (Math.hypot(tip.value.x - target.x, tip.value.y - target.y) > 1 && iters < 1000) {
      tip.value = target;
      iters++;
    }
    expect(iters).toBeLessThan(100);
  });
});
