// avbd-fuzz.test.ts — property-based tests over random scenes.
//
// Each property is tested on N seeded scenarios. Failures report the
// seed so a fix is reproducible by hard-coding that seed.

import { describe, expect, it } from "vitest";
import { distance, eq, leq, num, Solver, vec, VecCell } from "../index";
import { forAll } from "./_fuzz";

describe("AVBD fuzz — invariants over random scenes", () => {
  it("random pinned-chain: all distance constraints satisfied at convergence", () => {
    forAll(50, (rng) => {
      const N = rng.int(3, 16);
      const cells: VecCell[] = [];
      for (let i = 0; i < N; i++) cells.push(vec(rng.float(-1, 1), rng.float(-1, 1)));
      cells[0]!.mass = 0;
      cells[0]!.value = { x: 0, y: 0 };
      const tailX = rng.float(0.5, N - 1);
      const tailY = rng.float(-1, 1);
      cells[N - 1]!.mass = 0;
      cells[N - 1]!.value = { x: tailX, y: tailY };
      // Feasible target distance: head-tail Euclidean distance ≤ N - 1
      // (sum of unit links). We use rest=1 per link.
      const headTailDist = Math.hypot(tailX, tailY);
      if (headTailDist > N - 1) return; // skip infeasible

      const s = new Solver({ iterations: 30 });
      for (const c of cells) s.addCell(c);
      for (let i = 1; i < N; i++) distance(s, cells[i - 1]!, cells[i]!, 1);
      for (let i = 0; i < 30; i++) s.step();

      let maxErr = 0;
      for (let i = 1; i < N; i++) {
        const dx = cells[i]!.x - cells[i - 1]!.x;
        const dy = cells[i]!.y - cells[i - 1]!.y;
        const err = Math.abs(Math.hypot(dx, dy) - 1);
        if (err > maxErr) maxErr = err;
      }
      expect(maxErr).toBeLessThan(0.05);
    });
  });

  it("cell-insertion order doesn't change the solved configuration", () => {
    forAll(20, (rng) => {
      // Build the same scene twice with different cell-add order, verify
      // identical (within tol) solutions for the free cell.
      const a = vec(0, 0);
      a.mass = 0;
      const b = vec(rng.float(-2, 2), rng.float(-2, 2));
      const target = rng.float(0.5, 3);

      const buildSolve = (orderAFirst: boolean): { x: number; y: number } => {
        const a2 = vec(0, 0);
        a2.mass = 0;
        const b2 = vec(b.x, b.y);
        const s = new Solver({ iterations: 30 });
        if (orderAFirst) {
          s.addCell(a2);
          s.addCell(b2);
        } else {
          s.addCell(b2);
          s.addCell(a2);
        }
        distance(s, a2, b2, target);
        for (let i = 0; i < 20; i++) s.step();
        return { x: b2.x, y: b2.y };
      };

      const r1 = buildSolve(true);
      const r2 = buildSolve(false);
      expect(Math.abs(r1.x - r2.x)).toBeLessThan(1e-3);
      expect(Math.abs(r1.y - r2.y)).toBeLessThan(1e-3);
    });
  });

  it("hard inequality leq(a, b) keeps a ≤ b for any feasible target", () => {
    forAll(50, (rng) => {
      const aInit = rng.float(-10, 10);
      const bInit = rng.float(-10, 10);
      const a = num(aInit);
      const b = num(bInit);
      b.mass = 0;
      const s = new Solver({ iterations: 20 });
      s.addCell(a);
      s.addCell(b);
      leq(s, a, b);
      for (let i = 0; i < 10; i++) s.step();
      expect(a.value).toBeLessThanOrEqual(b.value + 1e-3);
    });
  });

  it("redundant constraint doesn't shift the solution", () => {
    forAll(20, (rng) => {
      const a = vec(0, 0);
      a.mass = 0;
      const b = vec(rng.float(-2, 2), rng.float(-2, 2));
      const target = rng.float(0.5, 3);

      const solve = (addRedundant: boolean): { x: number; y: number } => {
        const a2 = vec(0, 0);
        a2.mass = 0;
        const b2 = vec(b.x, b.y);
        const s = new Solver({ iterations: 30 });
        s.addCell(a2);
        s.addCell(b2);
        distance(s, a2, b2, target);
        if (addRedundant) distance(s, a2, b2, target);
        for (let i = 0; i < 30; i++) s.step();
        return { x: b2.x, y: b2.y };
      };

      const r1 = solve(false);
      const r2 = solve(true);
      expect(Math.abs(r1.x - r2.x)).toBeLessThan(0.05);
      expect(Math.abs(r1.y - r2.y)).toBeLessThan(0.05);
    });
  });

  it("pinning a cell already at its solved position is a no-op", () => {
    forAll(20, (rng) => {
      const a = vec(0, 0);
      a.mass = 0;
      const b = vec(rng.float(-1, 1), rng.float(-1, 1));
      const target = rng.float(0.5, 2);
      const s = new Solver({ iterations: 30 });
      s.addCell(a);
      s.addCell(b);
      distance(s, a, b, target);
      for (let i = 0; i < 30; i++) s.step();

      const before = { x: b.x, y: b.y };
      b.mass = 0; // pin at solved position
      for (let i = 0; i < 5; i++) s.step();
      expect(b.x).toBeCloseTo(before.x, 3);
      expect(b.y).toBeCloseTo(before.y, 3);

      // unpin again, b stays put
      b.mass = 1;
      for (let i = 0; i < 5; i++) s.step();
      expect(b.x).toBeCloseTo(before.x, 3);
      expect(b.y).toBeCloseTo(before.y, 3);
    });
  });

  it("equality propagates through arbitrary chain of eq() constraints", () => {
    forAll(20, (rng) => {
      const N = rng.int(3, 8);
      const cells: VecCell[] = [];
      for (let i = 0; i < N; i++) cells.push(vec(rng.float(-5, 5), rng.float(-5, 5)));
      const target = vec(rng.float(-10, 10), rng.float(-10, 10));
      cells[0]!.mass = 0;
      cells[0]!.value = target.value;

      const s = new Solver({ iterations: 30 });
      for (const c of cells) s.addCell(c);
      for (let i = 1; i < N; i++) eq(s, cells[i - 1]!, cells[i]!);
      for (let i = 0; i < 30; i++) s.step();

      for (let i = 1; i < N; i++) {
        expect(cells[i]!.x).toBeCloseTo(target.x, 2);
        expect(cells[i]!.y).toBeCloseTo(target.y, 2);
      }
    });
  });
});
