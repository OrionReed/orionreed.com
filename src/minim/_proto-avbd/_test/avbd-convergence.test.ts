// avbd-convergence.test.ts — measure AVBD's convergence rate
// (residual vs iteration count) on canonical workloads. This is
// the right way to assess "how many iterations do we need" rather
// than the head-to-head wall-clock numbers, which are dominated by
// JS engine specifics.
//
// We report:
//   - Residual after N iterations on cold-start vs warm-start.
//   - Residual under continuous drag for various iteration counts.
//   - Convergence on the high-stiffness-ratio scenario from
//     the AVBD paper (where Newton-style methods choke).

import { describe, expect, it } from "vitest";
import { distance, Simulation, Solver, spring, vec, VecCell } from "../index";

function buildChain(N: number) {
  const cells: VecCell[] = [];
  for (let i = 0; i < N; i++) cells.push(vec(i, 0));
  cells[0]!.mass = 0;
  const s = new Solver({ iterations: 1 });
  for (const c of cells) s.addCell(c);
  for (let i = 1; i < N; i++) distance(s, cells[i - 1]!, cells[i]!, 1);
  cells[N - 1]!.mass = 0;
  return { s, cells };
}

describe("AVBD convergence — residual vs iteration count", () => {
  it("32-chain residual decay across multiple step() calls (warm-start chain)", () => {
    // AVBD is designed as a per-frame solver: warm-starting across
    // step() calls is what makes convergence fast in practice. A
    // single step() with many iterations does NOT match calling
    // step() repeatedly — penalty/lambda accumulate properly only
    // when persisted across the warm-start.
    //
    // We measure residual after k step() calls, each with a small
    // iteration count. This is the realistic interactive-editing
    // pattern: user drags, the solver runs a few iters per frame,
    // converges over a few frames.
    const N = 32;
    const { s, cells } = buildChain(N);
    cells[N - 1]!.value = { x: N - 5, y: 3 };
    s.iterations = 5;
    const counts = [1, 2, 5, 10, 20];
    let stepIdx = 0;
    const results: { steps: number; residual: number }[] = [];
    for (const k of counts) {
      while (stepIdx < k) {
        s.step();
        stepIdx++;
      }
      results.push({ steps: k, residual: s.residualNorm() });
    }
    console.log("  residual after k step() calls (5 iters each):");
    for (const r of results) {
      console.log(`    k=${r.steps.toString().padStart(2)}: ${r.residual.toFixed(6)}`);
    }
    // After 20 step calls (100 total iters with warm-start), residual
    // should be tiny.
    expect(results[results.length - 1]!.residual).toBeLessThan(0.05);
  });

  it("32-chain warm-start: residual after small drag at low iter counts", () => {
    const N = 32;
    // First, warm up with high iter count to reach near-zero residual.
    const { s, cells } = buildChain(N);
    cells[N - 1]!.value = { x: N - 5, y: 1 };
    s.iterations = 50;
    for (let i = 0; i < 5; i++) s.step();
    const initialResidual = s.residualNorm();
    expect(initialResidual).toBeLessThan(0.001);

    s.iterations = 2;
    let dy = 1;
    let maxResidual = 0;
    for (let i = 0; i < 30; i++) {
      dy += 0.05;
      cells[N - 1]!.y = dy;
      s.step();
      const r = s.residualNorm();
      if (r > maxResidual) maxResidual = r;
    }
    console.log(`  warm-start residual under continuous drag (iter=2): max=${maxResidual.toFixed(6)}`);
    // Warm-start should keep residual bounded under continuous drag.
    expect(maxResidual).toBeLessThan(0.1);
  });

  it("high stiffness ratio: AVBD reaches steady state quickly (paper §3.4)", () => {
    // 3-block scenario, stiffness ratio 1e4. Measure how the
    // displacement of the bottom block converges with iteration
    // count.
    const top = vec(0, 0);
    top.mass = 0;
    const A = vec(0, -1);
    const B = vec(0, -2);
    const s = new Solver({ iterations: 1, alpha: 0.99 });
    const sim = new Simulation(s, { gravity: [0, -10] });
    s.addCell(top);
    s.addCell(A);
    s.addCell(B);
    spring(s, top, A, 1, 1e4);
    spring(s, A, B, 1, 1);
    for (let i = 0; i < 200; i++) sim.tick(1 / 60);
    const dispA = -A.y;
    const dispB = -B.y;
    console.log(`  steady-state: A_y=${A.y.toFixed(3)}, B_y=${B.y.toFixed(3)}`);
    // A should be near 1 unit below top (stiff spring).
    expect(dispA).toBeGreaterThan(0.95);
    expect(dispA).toBeLessThan(1.5);
    // B is between 1 (rest) and 11 (max stretch under weight, k=1, w=10).
    expect(dispB).toBeGreaterThan(dispA);
  });
});
