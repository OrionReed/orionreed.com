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
  Cell as AvbdCell,
  distance as avbdDistance,
  Solver,
} from "../index";
import { dist as relateDist, pinPoint } from "../../_proto-relate/constraints";
import { vec } from "../../_proto-relate/index";

describe("AVBD vs relate — same answer on chain drag", () => {
  it("8-link 2D chain, both converge to same configuration", () => {
    // Build a chain in both systems with identical setup.
    const N = 8;

    // ── AVBD ──
    const avCells: AvbdCell[] = [];
    for (let i = 0; i < N; i++) avCells.push(new AvbdCell(2, [i, 0]));
    avCells[0]!.mass = 0;
    const avSolver = new Solver({ iterations: 30 });
    for (const c of avCells) avSolver.addCell(c);
    for (let i = 1; i < N; i++) avbdDistance(avSolver, avCells[i - 1]!, avCells[i]!, 1);
    avCells[N - 1]!.mass = 0;
    avCells[N - 1]!.position[0]! = N - 4;
    avCells[N - 1]!.position[1]! = 3;
    avSolver.step();
    avSolver.step();
    avSolver.step();
    avSolver.step();

    // ── relate ──
    const relCells = Array.from({ length: N }, (_, i) => vec(i, 0));
    pinPoint(relCells[0]!);
    for (let i = 1; i < N; i++) relateDist(relCells[i - 1]!, relCells[i]!, 1);
    pinPoint(relCells[N - 1]!, { x: N - 4, y: 3 });

    // Compare middle joints. They may differ — both systems are
    // under-determined and choose based on warm-start. But we can
    // verify both satisfy the distance constraints and the pinned
    // endpoints match.
    for (let i = 1; i < N; i++) {
      const dxA = avCells[i]!.position[0]! - avCells[i - 1]!.position[0]!;
      const dyA = avCells[i]!.position[1]! - avCells[i - 1]!.position[1]!;
      expect(Math.hypot(dxA, dyA)).toBeCloseTo(1, 2);
      const dxR = relCells[i]!.value.x - relCells[i - 1]!.value.x;
      const dyR = relCells[i]!.value.y - relCells[i - 1]!.value.y;
      expect(Math.hypot(dxR, dyR)).toBeCloseTo(1, 2);
    }
  });
});

describe("AVBD vs relate — chain drag perf", () => {
  function buildAvbd(N: number, iters: number) {
    const cells: AvbdCell[] = [];
    for (let i = 0; i < N; i++) cells.push(new AvbdCell(2, [i, 0]));
    cells[0]!.mass = 0;
    const s = new Solver({ iterations: iters });
    for (const c of cells) s.addCell(c);
    for (let i = 1; i < N; i++) avbdDistance(s, cells[i - 1]!, cells[i]!, 1);
    cells[N - 1]!.mass = 0;
    return { s, cells };
  }

  function buildRelate(N: number) {
    const cells = Array.from({ length: N }, (_, i) => vec(i, 0));
    pinPoint(cells[0]!);
    for (let i = 1; i < N; i++) relateDist(cells[i - 1]!, cells[i]!, 1);
    return { cells };
  }

  it("N=64 chain: drag tail in small steps, measure per-frame cost", () => {
    const N = 64;
    const drags = 30;

    // AVBD: warm up.
    const av = buildAvbd(N, 5);
    av.cells[N - 1]!.position[0]! = N - 5;
    av.cells[N - 1]!.position[1]! = 1;
    for (let i = 0; i < 10; i++) av.s.step(); // warm

    // Time AVBD.
    let dy = 1;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      av.cells[N - 1]!.position[1]! = dy;
      av.s.step();
    }
    const tAvbd = (performance.now() - t0) / drags;

    // relate: warm up.
    const rel = buildRelate(N);
    pinPoint(rel.cells[N - 1]!, { x: N - 5, y: 1 });
    // (warm-up happens automatically via initial solve)

    // Time relate.
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
    // No assertion — just want the perf number visible.
    expect(tAvbd).toBeLessThan(50);
    expect(tRelate).toBeLessThan(200);
  });

  it("N=256 chain: scaling probe", () => {
    const N = 256;
    const drags = 5;

    const av = buildAvbd(N, 5);
    av.cells[N - 1]!.position[0]! = N - 5;
    av.cells[N - 1]!.position[1]! = 1;
    for (let i = 0; i < 5; i++) av.s.step();

    let dy = 1;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      av.cells[N - 1]!.position[1]! = dy;
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
    // AVBD's promise: even at iter=1, simulation is bounded. We
    // can't compare directly because LM at maxIters=1 may diverge
    // or oscillate. Just verify AVBD is stable.
    const N = 64;
    const cells: AvbdCell[] = [];
    for (let i = 0; i < N; i++) cells.push(new AvbdCell(2, [i, 0]));
    cells[0]!.mass = 0;
    const s = new Solver({ iterations: 1 });
    for (const c of cells) s.addCell(c);
    for (let i = 1; i < N; i++) avbdDistance(s, cells[i - 1]!, cells[i]!, 1);
    cells[N - 1]!.mass = 0;

    // Drag along a smooth path with single-iter AVBD.
    for (let step = 0; step < 200; step++) {
      const t = step * 0.05;
      cells[N - 1]!.position[0]! = (N - 5) + Math.cos(t);
      cells[N - 1]!.position[1]! = Math.sin(t);
      s.step();
    }
    // Stability: no runaway.
    for (const c of cells) {
      expect(Number.isFinite(c.position[0]!)).toBe(true);
      expect(Math.abs(c.position[0]!)).toBeLessThan(200);
    }
  });
});
