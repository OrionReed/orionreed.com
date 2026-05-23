// avbd-generality.test.ts — AVBD as a general continuous-optimization
// engine, not just a physics simulator.
//
// AVBD's underlying math is variational implicit Euler with augmented
// Lagrangian — but the "physics" framing (mass, gravity, dt) is just
// one interpretation. The same machinery handles any optimization
// problem of the form:
//
//   minimize  Σ w_i · C_i(x)²        (soft constraints)
//   subject to  C_j(x) = 0           (hard equality)
//   with        C_k(x) ≤ 0           (hard inequality)
//
// We probe several non-physics domains:
//   1. Force-directed graph layout (springs + Coulomb repulsion).
//   2. Inverse kinematics (3-link arm reaching a target).
//   3. Curve fitting / linear regression.
//   4. Mass-spring physics (just to confirm physics still works).

import { describe, expect, it } from "vitest";
import { distance, generic, num, Simulation, Solver, spring, vec, VecCell } from "../index";

// ─── 1. Force-directed graph layout ─────────────────────────────────

describe("Generality — force-directed graph layout", () => {
  it("3-node triangle: equal spacing", () => {
    const A = vec(0, 0);
    const B = vec(1.5, 0);
    const C = vec(0.5, 0.5);
    A.mass = 0;
    const s = new Solver({ iterations: 50 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(C);
    spring(s, A, B, 1, 100);
    spring(s, B, C, 1, 100);
    spring(s, C, A, 1, 100);
    for (let i = 0; i < 30; i++) s.step();
    const dAB = Math.hypot(B.x, B.y);
    const dBC = Math.hypot(B.x - C.x, B.y - C.y);
    const dCA = Math.hypot(C.x, C.y);
    expect(dAB).toBeCloseTo(1, 1);
    expect(dBC).toBeCloseTo(1, 1);
    expect(dCA).toBeCloseTo(1, 1);
  });

  it("8-node 'wheel' graph: hub + 7 spokes + outer ring", () => {
    const hub = vec(0, 0);
    hub.mass = 0;
    const outer: VecCell[] = [];
    const N = 7;
    for (let i = 0; i < N; i++) {
      outer.push(vec(1 + 0.1 * Math.cos(i), 1 + 0.1 * Math.sin(i)));
    }
    const s = new Solver({ iterations: 30 });
    s.addCell(hub);
    for (const o of outer) s.addCell(o);
    for (const o of outer) spring(s, hub, o, 1, 100);
    const ringLen = 2 * Math.sin(Math.PI / N);
    for (let i = 0; i < N; i++) {
      spring(s, outer[i]!, outer[(i + 1) % N]!, ringLen, 100);
    }
    for (let i = 0; i < 50; i++) s.step();
    for (const o of outer) {
      const d = Math.hypot(o.x, o.y);
      expect(d).toBeGreaterThan(0.7);
      expect(d).toBeLessThan(1.3);
    }
    let avgRing = 0;
    for (let i = 0; i < N; i++) {
      const a = outer[i]!,
        b = outer[(i + 1) % N]!;
      avgRing += Math.hypot(a.x - b.x, a.y - b.y);
    }
    avgRing /= N;
    expect(avgRing).toBeGreaterThan(ringLen * 0.7);
    expect(avgRing).toBeLessThan(ringLen * 1.3);
  });

  it("100-node random graph layout, edges only, no repulsion", () => {
    const N = 100;
    const cells: VecCell[] = [];
    let seed = 1;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed >>> 0) / 4294967296;
    };
    for (let i = 0; i < N; i++) {
      cells.push(vec(rand() * 10 - 5, rand() * 10 - 5));
    }
    cells[0]!.mass = 0;
    const s = new Solver({ iterations: 20 });
    for (const c of cells) s.addCell(c);
    for (let i = 1; i < N; i++) spring(s, cells[i - 1]!, cells[i]!, 1, 100);
    for (let i = 0; i < 50; i++) {
      const a = Math.floor(rand() * N);
      const b = Math.floor(rand() * N);
      if (a !== b) spring(s, cells[a]!, cells[b]!, 1, 100);
    }
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) s.step();
    const t = performance.now() - t0;
    console.log(`  100-node graph layout, 30 step()s: ${t.toFixed(2)}ms`);
    for (let i = 1; i < N; i++) {
      expect(Number.isFinite(cells[i]!.x)).toBe(true);
      expect(Math.abs(cells[i]!.x) + Math.abs(cells[i]!.y)).toBeGreaterThan(0.01);
    }
    const edgeForces = s.forces.filter(f => f.rows === 1);
    let satisfied = 0;
    for (const f of edgeForces) {
      f.computeConstraint(0);
      if (Math.abs(f.C[0]!) < 0.5) satisfied++;
    }
    expect(satisfied / edgeForces.length).toBeGreaterThan(0.5);
  });
});

// ─── 2. Inverse kinematics ───────────────────────────────────────────

describe("Generality — inverse kinematics", () => {
  it("3-link arm reaching a target", () => {
    const base = vec(0, 0);
    base.mass = 0;
    const j1 = vec(1, 0);
    const j2 = vec(2, 0);
    const tip = vec(3, 0);
    const s = new Solver({ iterations: 30 });
    s.addCell(base);
    s.addCell(j1);
    s.addCell(j2);
    s.addCell(tip);
    distance(s, base, j1, 1);
    distance(s, j1, j2, 1);
    distance(s, j2, tip, 1);
    const target = vec(2, 1);
    target.mass = 0;
    s.addCell(target);
    spring(s, tip, target, 0, 1e4); // strong "reach" pull
    for (let i = 0; i < 30; i++) s.step();
    expect(tip.x).toBeCloseTo(2, 1);
    expect(tip.y).toBeCloseTo(1, 1);
    const d1 = Math.hypot(j1.x, j1.y);
    const d2 = Math.hypot(j2.x - j1.x, j2.y - j1.y);
    const d3 = Math.hypot(tip.x - j2.x, tip.y - j2.y);
    expect(d1).toBeCloseTo(1, 2);
    expect(d2).toBeCloseTo(1, 2);
    expect(d3).toBeCloseTo(1, 2);
  });
});

// ─── 3. Curve fitting / linear regression ────────────────────────────

describe("Generality — curve fitting via constraints", () => {
  it("linear regression: y = m·x + b through 5 noisy points", () => {
    const data: { x: number; y: number }[] = [
      { x: 0, y: 1.1 },
      { x: 1, y: 2.0 },
      { x: 2, y: 3.05 },
      { x: 3, y: 3.9 },
      { x: 4, y: 5.1 },
    ];
    const m = num(0);
    const b = num(0);
    const s = new Solver({ iterations: 30 });
    s.addCell(m);
    s.addCell(b);
    for (const pt of data) {
      generic(
        s,
        [m, b],
        1,
        (pos, out) => {
          out[0]! = pos[0]![0]! * pt.x + pos[1]![0]! - pt.y;
        },
        { hard: false, stiffness: 1e6 },
      );
    }
    for (let i = 0; i < 20; i++) s.step();
    expect(m.value).toBeCloseTo(1, 1);
    expect(b.value).toBeCloseTo(1, 1);
  });

  it("polynomial fit: y = a·x² + b·x + c through 10 samples", () => {
    const N = 10;
    const true_a = 0.5,
      true_b = -2,
      true_c = 3;
    const data = Array.from({ length: N }, (_, i) => {
      const x = i - 5;
      return { x, y: true_a * x * x + true_b * x + true_c };
    });
    const a = num(0);
    const b = num(0);
    const c = num(0);
    const s = new Solver({ iterations: 30 });
    s.addCell(a);
    s.addCell(b);
    s.addCell(c);
    for (const pt of data) {
      generic(
        s,
        [a, b, c],
        1,
        (pos, out) => {
          out[0]! =
            pos[0]![0]! * pt.x * pt.x + pos[1]![0]! * pt.x + pos[2]![0]! - pt.y;
        },
        { hard: false, stiffness: 1e6 },
      );
    }
    for (let i = 0; i < 30; i++) s.step();
    expect(a.value).toBeCloseTo(true_a, 2);
    expect(b.value).toBeCloseTo(true_b, 2);
    expect(c.value).toBeCloseTo(true_c, 2);
  });
});

// ─── 4. Mass-spring physics (sanity check) ───────────────────────────

describe("Generality — mass-spring physics still works", () => {
  it("pendulum: 1-link, swings under gravity", () => {
    const anchor = vec(0, 0);
    anchor.mass = 0;
    const bob = vec(1, 0);
    const s = new Solver({ iterations: 8, alpha: 0.99 });
    const sim = new Simulation(s, { gravity: [0, -10] });
    s.addCell(anchor);
    s.addCell(bob);
    distance(s, anchor, bob, 1);
    for (let i = 0; i < 120; i++) sim.tick(1 / 60);
    const d = Math.hypot(bob.x, bob.y);
    expect(d).toBeCloseTo(1, 2);
    expect(Math.abs(bob.x - 1)).toBeGreaterThan(0.05);
  });

  it("dropping cloth: 8x8 mesh under gravity, pinned at top corners", () => {
    const W = 8,
      H = 8;
    const cells: VecCell[][] = [];
    for (let j = 0; j < H; j++) {
      const row: VecCell[] = [];
      for (let i = 0; i < W; i++) row.push(vec(i, -j));
      cells.push(row);
    }
    cells[0]![0]!.mass = 0;
    cells[0]![W - 1]!.mass = 0;
    const s = new Solver({ iterations: 5, alpha: 0.99 });
    const sim = new Simulation(s, { gravity: [0, -10] });
    for (const row of cells) for (const c of row) s.addCell(c);
    for (let j = 0; j < H; j++)
      for (let i = 1; i < W; i++)
        distance(s, cells[j]![i - 1]!, cells[j]![i]!, 1);
    for (let i = 0; i < W; i++)
      for (let j = 1; j < H; j++)
        distance(s, cells[j - 1]![i]!, cells[j]![i]!, 1);
    const t0 = performance.now();
    for (let i = 0; i < 120; i++) sim.tick(1 / 60);
    const t = performance.now() - t0;
    console.log(`  64-cell cloth, 120 frames physics: ${t.toFixed(1)}ms`);
    const bottomY = cells[H - 1]![Math.floor(W / 2)]!.y;
    expect(bottomY).toBeLessThan(-1.5);
    for (const row of cells)
      for (const c of row) {
        expect(Number.isFinite(c.x)).toBe(true);
        expect(Math.abs(c.x)).toBeLessThan(50);
      }
  });
});
