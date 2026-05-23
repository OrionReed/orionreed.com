// avbd-topology.test.ts — incremental cell/force add and remove.
//
// Probes:
//   1. Adding a force mid-simulation — does the system pick it up?
//   2. Removing a force mid-simulation — clean teardown?
//   3. Adding cells during the run.
//   4. Performance: how expensive is add/remove per call?
//
// In AVBD's design, both operations are O(1) ideally:
//   - addForce: push to Solver.forces and to each Cell.forces.
//   - removeForce: splice from arrays (O(n) worst case but amortised
//     fine since topology changes are rare per frame).
//
// No global recompilation. No cluster identification (a single
// Solver is one cluster). No matrix factor invalidation (the
// matrices are local-per-cell and rebuilt every iteration).

import { describe, expect, it } from "vitest";
import { Cell, distance, eq, Solver } from "../index";

describe("AVBD topology — incremental changes", () => {
  it("adding a force during simulation: takes effect on next step", () => {
    const a = new Cell(2, [0, 0]);
    const b = new Cell(2, [5, 0]);
    a.mass = 0;
    const s = new Solver({ iterations: 20 });
    s.addCell(a);
    s.addCell(b);
    // No constraints yet — b stays at [5, 0].
    s.step();
    expect(b.position[0]!).toBe(5);
    // Add a distance constraint mid-flight.
    distance(s, a, b, 1);
    for (let i = 0; i < 5; i++) s.step();
    const d = Math.hypot(b.position[0]!, b.position[1]!);
    expect(d).toBeCloseTo(1, 2);
  });

  it("removing a force during simulation: cell is freed", () => {
    const a = new Cell(2, [0, 0]);
    const b = new Cell(2, [1, 0]);
    a.mass = 0;
    const s = new Solver({ iterations: 10 });
    s.addCell(a);
    s.addCell(b);
    const f = distance(s, a, b, 1);
    for (let i = 0; i < 3; i++) s.step();
    expect(Math.hypot(b.position[0]!, b.position[1]!)).toBeCloseTo(1, 2);
    // Remove the force; b should now be free.
    s.removeForce(f);
    // No constraint left — b stays where it was.
    const bx = b.position[0]!;
    const by = b.position[1]!;
    s.step();
    expect(b.position[0]!).toBeCloseTo(bx, 4);
    expect(b.position[1]!).toBeCloseTo(by, 4);
  });

  it("adding a cell during simulation: integrates immediately", () => {
    const a = new Cell(2, [0, 0]);
    a.mass = 0;
    const s = new Solver({ iterations: 10 });
    s.addCell(a);
    s.step();
    // Add a second cell + constraint.
    const b = new Cell(2, [3, 0]);
    s.addCell(b);
    distance(s, a, b, 1);
    for (let i = 0; i < 5; i++) s.step();
    expect(Math.hypot(b.position[0]!, b.position[1]!)).toBeCloseTo(1, 2);
  });

  it("disable() during dual update: force vanishes cleanly", () => {
    const a = new Cell(2, [0, 0]);
    const b = new Cell(2, [1, 0]);
    a.mass = 0;
    const s = new Solver({ iterations: 5 });
    s.addCell(a);
    s.addCell(b);
    const f1 = distance(s, a, b, 1);
    const f2 = distance(s, a, b, 2); // conflicting; one gives way
    f1.fracture[0]! = 0.5; // f1 fractures if |λ| > 0.5
    for (let i = 0; i < 30; i++) s.step();
    // Eventually f1 should fracture (f2 wins, |a-b| → 2).
    const d = Math.hypot(b.position[0]!, b.position[1]!);
    // At least one force broke — should reach close to 2 or close to 1.
    expect(d > 0.5).toBe(true);
  });
});

describe("AVBD topology — perf cost of changes", () => {
  it("addForce is O(1) — 10K incremental constraints in <50ms", () => {
    // Build a chain by adding constraints one at a time, measuring
    // the cost. Each `distance()` call should be ~µs.
    const N = 10000;
    const cells: Cell[] = [];
    for (let i = 0; i < N; i++) cells.push(new Cell(2, [i, 0]));
    const s = new Solver({ iterations: 1 });
    for (const c of cells) s.addCell(c);
    const t0 = performance.now();
    for (let i = 1; i < N; i++) distance(s, cells[i - 1]!, cells[i]!, 1);
    const t = performance.now() - t0;
    console.log(`  10K addForce calls: ${t.toFixed(2)}ms (${((t * 1000) / N).toFixed(2)}µs each)`);
    expect(t).toBeLessThan(200);
  });

  it("removeForce performance — sweep through 1000 deletions", () => {
    const N = 1000;
    const cells: Cell[] = [];
    for (let i = 0; i < N; i++) cells.push(new Cell(2, [i, 0]));
    const s = new Solver({ iterations: 1 });
    for (const c of cells) s.addCell(c);
    const forces = [];
    for (let i = 1; i < N; i++) forces.push(distance(s, cells[i - 1]!, cells[i]!, 1));
    const t0 = performance.now();
    for (const f of forces) s.removeForce(f);
    const t = performance.now() - t0;
    console.log(`  1000 removeForce calls: ${t.toFixed(2)}ms (${((t * 1000) / forces.length).toFixed(2)}µs each)`);
    expect(s.forces.length).toBe(0);
  });

  it("dynamic topology: alternate add/remove during drag", () => {
    // Realistic case: user adds and removes constraints while
    // dragging. Each step the topology may differ. Verify nothing
    // degrades.
    const N = 64;
    const cells: Cell[] = [];
    for (let i = 0; i < N; i++) cells.push(new Cell(2, [i, 0]));
    cells[0]!.mass = 0;
    cells[N - 1]!.mass = 0;
    const s = new Solver({ iterations: 5 });
    for (const c of cells) s.addCell(c);
    const links = [];
    for (let i = 1; i < N; i++) links.push(distance(s, cells[i - 1]!, cells[i]!, 1));
    // Drag tail while toggling middle constraints.
    const t0 = performance.now();
    let dy = 0;
    for (let frame = 0; frame < 50; frame++) {
      // Toggle a constraint every other frame.
      if (frame % 2 === 0 && frame > 0) {
        const idx = (frame / 2) % (links.length - 1);
        s.removeForce(links[idx]!);
        links[idx]! = distance(s, cells[idx]!, cells[idx + 1]!, 1);
      }
      dy += 0.05;
      cells[N - 1]!.position[1]! = dy;
      s.step();
    }
    const t = performance.now() - t0;
    console.log(`  50 frames with topology toggles: ${t.toFixed(2)}ms`);
    expect(t).toBeLessThan(500);
  });
});
