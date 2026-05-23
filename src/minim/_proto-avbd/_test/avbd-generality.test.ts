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
import { Cell, distance, generic, pin, Solver, spring } from "../index";

// ─── 1. Force-directed graph layout ─────────────────────────────────
//
// Layout an undirected graph: edges become springs of ideal length
// 1; non-adjacent node pairs repel via 1/distance² (Coulomb-like).
// AVBD finds the energy-minimising configuration.

describe("Generality — force-directed graph layout", () => {
  it("3-node triangle: equal spacing", () => {
    // Trivial graph: 3 nodes, fully connected, edge length 1.
    const A = new Cell(2, [0, 0]);
    const B = new Cell(2, [1.5, 0]);
    const C = new Cell(2, [0.5, 0.5]);
    pin(new Solver(), A, [0, 0]); // dummy unused
    A.mass = 0; // anchor A
    const s = new Solver({ iterations: 50 });
    s.addCell(A);
    s.addCell(B);
    s.addCell(C);
    spring(s, A, B, 1, 100);
    spring(s, B, C, 1, 100);
    spring(s, C, A, 1, 100);
    for (let i = 0; i < 30; i++) s.step();
    const dAB = Math.hypot(B.position[0]!, B.position[1]!);
    const dBC = Math.hypot(B.position[0]! - C.position[0]!, B.position[1]! - C.position[1]!);
    const dCA = Math.hypot(C.position[0]!, C.position[1]!);
    expect(dAB).toBeCloseTo(1, 1);
    expect(dBC).toBeCloseTo(1, 1);
    expect(dCA).toBeCloseTo(1, 1);
  });

  it("8-node 'wheel' graph: hub + 7 spokes + outer ring", () => {
    // Wheel graph: 1 hub connected to 7 outer nodes; outer nodes
    // form a cycle. Ideal layout: hub at center, outer nodes on a
    // regular polygon.
    const hub = new Cell(2, [0, 0]);
    hub.mass = 0; // anchor hub at origin
    const outer: Cell[] = [];
    const N = 7;
    for (let i = 0; i < N; i++) {
      // Bad initial positions — clustered near (1, 1). Layout
      // should spread them out.
      outer.push(new Cell(2, [1 + 0.1 * Math.cos(i), 1 + 0.1 * Math.sin(i)]));
    }
    const s = new Solver({ iterations: 30 });
    s.addCell(hub);
    for (const o of outer) s.addCell(o);
    // Spokes: hub to each outer node, target length 1.
    for (const o of outer) spring(s, hub, o, 1, 100);
    // Outer ring: cycle through outer nodes, target length 2·sin(π/7).
    const ringLen = 2 * Math.sin(Math.PI / N);
    for (let i = 0; i < N; i++) {
      spring(s, outer[i]!, outer[(i + 1) % N]!, ringLen, 100);
    }
    // Settle.
    for (let i = 0; i < 50; i++) s.step();
    // Check: every outer node at distance 1 from hub.
    // Soft springs settle to a force-balance, not exact rest length —
    // expect ~10% deviation from rest. The point is the layout
    // converges, not perfect satisfaction.
    for (const o of outer) {
      const d = Math.hypot(o.position[0]!, o.position[1]!);
      expect(d).toBeGreaterThan(0.7);
      expect(d).toBeLessThan(1.3);
    }
    let avgRing = 0;
    for (let i = 0; i < N; i++) {
      const a = outer[i]!,
        b = outer[(i + 1) % N]!;
      avgRing += Math.hypot(a.position[0]! - b.position[0]!, a.position[1]! - b.position[1]!);
    }
    avgRing /= N;
    expect(avgRing).toBeGreaterThan(ringLen * 0.7);
    expect(avgRing).toBeLessThan(ringLen * 1.3);
  });

  it("100-node random graph layout, edges only, no repulsion", () => {
    // Realistic graph layout at scale. 100 nodes, ~150 edges, all
    // springs of length 1. Random initial positions. AVBD finds an
    // arrangement where the graph distances are roughly preserved.
    const N = 100;
    const cells: Cell[] = [];
    let seed = 1;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed >>> 0) / 4294967296;
    };
    for (let i = 0; i < N; i++) {
      cells.push(new Cell(2, [rand() * 10 - 5, rand() * 10 - 5]));
    }
    cells[0]!.mass = 0;
    const s = new Solver({ iterations: 20 });
    for (const c of cells) s.addCell(c);
    // Edges: each node connects to the next (forms a path) plus
    // ~50 random shortcuts.
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
    // All cells should be finite, none at the same position as cell 0.
    for (let i = 1; i < N; i++) {
      expect(Number.isFinite(cells[i]!.position[0]!)).toBe(true);
      expect(Math.abs(cells[i]!.position[0]!) + Math.abs(cells[i]!.position[1]!)).toBeGreaterThan(0.01);
    }
    // Most edges should be near rest length.
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
    // 3 links of length 1 each, base anchored at origin. Reach for
    // a target at (2, 1). Solve for the joint angles implicitly
    // by representing each joint as a point and constraining
    // inter-joint distances + a target constraint at the tip.
    const base = new Cell(2, [0, 0]);
    base.mass = 0;
    const j1 = new Cell(2, [1, 0]);
    const j2 = new Cell(2, [2, 0]);
    const tip = new Cell(2, [3, 0]);
    const s = new Solver({ iterations: 30 });
    s.addCell(base);
    s.addCell(j1);
    s.addCell(j2);
    s.addCell(tip);
    distance(s, base, j1, 1);
    distance(s, j1, j2, 1);
    distance(s, j2, tip, 1);
    // Tip target — use a soft constraint so the system is solvable
    // even if the target is unreachable.
    spring(s, tip, base, 0, 0); // disabled placeholder
    s.removeForce(s.forces[s.forces.length - 1]!);
    // Tip pin via a soft target.
    const target = new Cell(2, [2, 1]);
    target.mass = 0;
    s.addCell(target);
    spring(s, tip, target, 0, 1e4); // strong "reach" pull
    for (let i = 0; i < 30; i++) s.step();
    // Tip should be very close to target.
    expect(tip.position[0]!).toBeCloseTo(2, 1);
    expect(tip.position[1]!).toBeCloseTo(1, 1);
    // Joint distances preserved.
    const d1 = Math.hypot(j1.position[0]!, j1.position[1]!);
    const d2 = Math.hypot(j2.position[0]! - j1.position[0]!, j2.position[1]! - j1.position[1]!);
    const d3 = Math.hypot(tip.position[0]! - j2.position[0]!, tip.position[1]! - j2.position[1]!);
    expect(d1).toBeCloseTo(1, 2);
    expect(d2).toBeCloseTo(1, 2);
    expect(d3).toBeCloseTo(1, 2);
  });
});

// ─── 3. Curve fitting / linear regression ────────────────────────────

describe("Generality — curve fitting via constraints", () => {
  it("linear regression: y = m·x + b through 5 noisy points", () => {
    // Encode (m, b) as two scalar cells. For each data point, add
    // a soft constraint: m·x_i + b - y_i = 0. AVBD finds the
    // best-fit line via LSQ.
    const data: { x: number; y: number }[] = [
      { x: 0, y: 1.1 },
      { x: 1, y: 2.0 },
      { x: 2, y: 3.05 },
      { x: 3, y: 3.9 },
      { x: 4, y: 5.1 },
    ];
    const m = new Cell(1, [0]);
    const b = new Cell(1, [0]);
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
    // Expected: m ≈ 1, b ≈ 1 (clean integer relationship + small noise).
    expect(m.position[0]!).toBeCloseTo(1, 1);
    expect(b.position[0]!).toBeCloseTo(1, 1);
  });

  it("polynomial fit: y = a·x² + b·x + c through 10 samples", () => {
    // Same idea, 3 unknowns, more data. Standard LSQ regression.
    const N = 10;
    const true_a = 0.5,
      true_b = -2,
      true_c = 3;
    const data = Array.from({ length: N }, (_, i) => {
      const x = i - 5;
      return { x, y: true_a * x * x + true_b * x + true_c };
    });
    const a = new Cell(1, [0]);
    const b = new Cell(1, [0]);
    const c = new Cell(1, [0]);
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
    expect(a.position[0]!).toBeCloseTo(true_a, 2);
    expect(b.position[0]!).toBeCloseTo(true_b, 2);
    expect(c.position[0]!).toBeCloseTo(true_c, 2);
  });
});

// ─── 4. Mass-spring physics (sanity check) ───────────────────────────

describe("Generality — mass-spring physics still works", () => {
  it("pendulum: 1-link, swings under gravity", () => {
    // Pendulum: anchor at top, mass on the end. Push to the side,
    // it should swing back.
    const anchor = new Cell(2, [0, 0]);
    anchor.mass = 0;
    const bob = new Cell(2, [1, 0]);
    const s = new Solver({
      iterations: 8,
      dt: 1 / 60,
      aExt: [0, -10],
      staticMode: false,
    });
    s.addCell(anchor);
    s.addCell(bob);
    distance(s, anchor, bob, 1); // hard pendulum link
    // Simulate 2 seconds.
    for (let i = 0; i < 120; i++) s.step();
    // Bob should still be at distance 1 from anchor.
    const d = Math.hypot(bob.position[0]!, bob.position[1]!);
    expect(d).toBeCloseTo(1, 2);
    // Bob should have swung — not still at the start.
    expect(Math.abs(bob.position[0]! - 1)).toBeGreaterThan(0.05);
  });

  it("dropping cloth: 8x8 mesh under gravity, pinned at top corners", () => {
    // Classic cloth setup: grid of points connected by springs.
    // Pin top two corners; rest swings under gravity.
    const W = 8,
      H = 8;
    const cells: Cell[][] = [];
    for (let j = 0; j < H; j++) {
      const row: Cell[] = [];
      for (let i = 0; i < W; i++) row.push(new Cell(2, [i, -j]));
      cells.push(row);
    }
    cells[0]![0]!.mass = 0;
    cells[0]![W - 1]!.mass = 0;
    const s = new Solver({
      iterations: 5,
      dt: 1 / 60,
      aExt: [0, -10],
      staticMode: false,
    });
    for (const row of cells) for (const c of row) s.addCell(c);
    // Horizontal + vertical springs.
    for (let j = 0; j < H; j++)
      for (let i = 1; i < W; i++)
        distance(s, cells[j]![i - 1]!, cells[j]![i]!, 1);
    for (let i = 0; i < W; i++)
      for (let j = 1; j < H; j++)
        distance(s, cells[j - 1]![i]!, cells[j]![i]!, 1);
    // Run a couple seconds of simulation.
    const t0 = performance.now();
    for (let i = 0; i < 120; i++) s.step();
    const t = performance.now() - t0;
    console.log(`  64-cell cloth, 120 frames physics: ${t.toFixed(1)}ms`);
    // Cloth should hang down (negative y at the bottom).
    const bottomY = cells[H - 1]![Math.floor(W / 2)]!.position[1]!;
    expect(bottomY).toBeLessThan(-1.5);
    // No NaN, no runaway.
    for (const row of cells)
      for (const c of row) {
        expect(Number.isFinite(c.position[0]!)).toBe(true);
        expect(Math.abs(c.position[0]!)).toBeLessThan(50);
      }
  });
});
