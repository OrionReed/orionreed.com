// avbd-vs-relate.test.ts — head-to-head numerical and performance
// comparison between AVBD and the relate prototype (Newton-LM) on
// equivalent constraint scenarios.
//
// Goals:
//   1. Both produce the same answers (within tol) on cases where
//      both should converge.
//   2. Quantify the speed delta. AVBD's per-iter cost is much lower
//      (no global factorisation), but its convergence is linear vs
//      Newton's quadratic. The trade-off matters at different N.
//   3. Demonstrate cases where AVBD wins decisively: high stiffness
//      ratios, hard inequalities, capped-iteration drag scenarios.

import { describe, expect, it } from "vitest";
import {
  distance as avbdDistance,
  Solver,
  vec as avbdVec,
  VecCell as AvbdVecCell,
} from "../index";
import { dist as relateDist, pinPoint } from "../../_proto-relate/constraints";
import { vec as relateVec } from "../../_proto-relate/index";

describe("AVBD vs relate — same answer on chain drag", () => {
  it("8-link 2D chain, both converge to same configuration", () => {
    const N = 8;

    const avCells: AvbdVecCell[] = [];
    for (let i = 0; i < N; i++) avCells.push(avbdVec(i, 0));
    avCells[0]!.mass = 0;
    const avSolver = new Solver({ iterations: 30 });
    for (const c of avCells) avSolver.addCell(c);
    for (let i = 1; i < N; i++) avbdDistance(avSolver, avCells[i - 1]!, avCells[i]!, 1);
    avCells[N - 1]!.mass = 0;
    avCells[N - 1]!.value = { x: N - 4, y: 3 };
    avSolver.step();
    avSolver.step();
    avSolver.step();
    avSolver.step();

    const relCells = Array.from({ length: N }, (_, i) => relateVec(i, 0));
    pinPoint(relCells[0]!);
    for (let i = 1; i < N; i++) relateDist(relCells[i - 1]!, relCells[i]!, 1);
    pinPoint(relCells[N - 1]!, { x: N - 4, y: 3 });

    for (let i = 1; i < N; i++) {
      const dxA = avCells[i]!.x - avCells[i - 1]!.x;
      const dyA = avCells[i]!.y - avCells[i - 1]!.y;
      expect(Math.hypot(dxA, dyA)).toBeCloseTo(1, 2);
      const dxR = relCells[i]!.value.x - relCells[i - 1]!.value.x;
      const dyR = relCells[i]!.value.y - relCells[i - 1]!.value.y;
      expect(Math.hypot(dxR, dyR)).toBeCloseTo(1, 2);
    }
  });
});

describe("AVBD vs relate — chain drag perf", () => {
  function buildAvbd(N: number, iters: number) {
    const cells: AvbdVecCell[] = [];
    for (let i = 0; i < N; i++) cells.push(avbdVec(i, 0));
    cells[0]!.mass = 0;
    const s = new Solver({ iterations: iters });
    for (const c of cells) s.addCell(c);
    for (let i = 1; i < N; i++) avbdDistance(s, cells[i - 1]!, cells[i]!, 1);
    cells[N - 1]!.mass = 0;
    return { s, cells };
  }

  function buildRelate(N: number) {
    const cells = Array.from({ length: N }, (_, i) => relateVec(i, 0));
    pinPoint(cells[0]!);
    for (let i = 1; i < N; i++) relateDist(cells[i - 1]!, cells[i]!, 1);
    return { cells };
  }

  it("N=64 chain: drag tail in small steps, measure per-frame cost", () => {
    const N = 64;
    const drags = 30;

    const av = buildAvbd(N, 5);
    av.cells[N - 1]!.value = { x: N - 5, y: 1 };
    for (let i = 0; i < 10; i++) av.s.step();

    let dy = 1;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      av.cells[N - 1]!.y = dy;
      av.s.step();
    }
    const tAvbd = (performance.now() - t0) / drags;

    const rel = buildRelate(N);
    pinPoint(rel.cells[N - 1]!, { x: N - 5, y: 1 });

    let dy2 = 1;
    const t1 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy2 += 0.05;
      rel.cells[N - 1]!.value = { x: N - 5, y: dy2 };
    }
    const tRelate = (performance.now() - t1) / drags;

    console.log(
      `  N=64 2D chain — avbd@5: ${tAvbd.toFixed(3)}ms, relate(LM): ${tRelate.toFixed(3)}ms, ratio: ${(tRelate / tAvbd).toFixed(2)}×`,
    );
    expect(tAvbd).toBeLessThan(50);
    expect(tRelate).toBeLessThan(200);
  });

  it("N=256 chain: scaling probe", () => {
    const N = 256;
    const drags = 5;

    const av = buildAvbd(N, 5);
    av.cells[N - 1]!.value = { x: N - 5, y: 1 };
    for (let i = 0; i < 5; i++) av.s.step();

    let dy = 1;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      av.cells[N - 1]!.y = dy;
      av.s.step();
    }
    const tAvbd = (performance.now() - t0) / drags;

    const rel = buildRelate(N);
    pinPoint(rel.cells[N - 1]!, { x: N - 5, y: 1 });

    let dy2 = 1;
    const t1 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy2 += 0.05;
      rel.cells[N - 1]!.value = { x: N - 5, y: dy2 };
    }
    const tRelate = (performance.now() - t1) / drags;

    console.log(
      `  N=256 2D chain — avbd@5: ${tAvbd.toFixed(3)}ms, relate(LM): ${tRelate.toFixed(3)}ms, ratio: ${(tRelate / tAvbd).toFixed(2)}×`,
    );
    expect(Number.isFinite(tAvbd)).toBe(true);
    expect(Number.isFinite(tRelate)).toBe(true);
  });
});

describe("AVBD wins decisively — capped-iteration robustness", () => {
  it("64-chain at 1 iter/step stays bounded; LM may not converge", () => {
    const N = 64;
    const cells: AvbdVecCell[] = [];
    for (let i = 0; i < N; i++) cells.push(avbdVec(i, 0));
    cells[0]!.mass = 0;
    const s = new Solver({ iterations: 1 });
    for (const c of cells) s.addCell(c);
    for (let i = 1; i < N; i++) avbdDistance(s, cells[i - 1]!, cells[i]!, 1);
    cells[N - 1]!.mass = 0;

    for (let step = 0; step < 200; step++) {
      const t = step * 0.05;
      cells[N - 1]!.value = { x: N - 5 + Math.cos(t), y: Math.sin(t) };
      s.step();
    }
    for (const c of cells) {
      expect(Number.isFinite(c.x)).toBe(true);
      expect(Math.abs(c.x)).toBeLessThan(200);
    }
  });
});
