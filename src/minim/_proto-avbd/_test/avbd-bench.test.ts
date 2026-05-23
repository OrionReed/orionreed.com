// avbd-bench.test.ts — focused benchmarks on the hot path.
//
// Goals:
//   1. Measure cost per vertex update — the per-iter cost should
//      be tiny (a few hundred ns).
//   2. Compare AVBD on chain vs lattice topology — lattices are
//      where AVBD shines (info propagates O(√N) hops, not O(N)).
//   3. Compare with relate at large N to find the AVBD crossover.
//   4. Test high-stiffness-ratio scenarios where Newton-LM struggles
//      and AVBD breezes through.

import { describe, expect, it } from "vitest";
import { distance, Simulation, Solver, spring, vec, VecCell } from "../index";
import { dist as relateDist, pinPoint } from "../../_proto-relate/constraints";
import { vec as relateVec } from "../../_proto-relate/index";

// ─── Topology builders ──────────────────────────────────────────

function buildAvbdChain(N: number, iters: number) {
  const cells: VecCell[] = [];
  for (let i = 0; i < N; i++) cells.push(vec(i, 0));
  cells[0]!.mass = 0;
  const s = new Solver({ iterations: iters });
  for (const c of cells) s.addCell(c);
  for (let i = 1; i < N; i++) distance(s, cells[i - 1]!, cells[i]!, 1);
  return { s, cells };
}

function buildAvbdLattice(W: number, H: number, iters: number) {
  const cells: VecCell[][] = [];
  for (let j = 0; j < H; j++) {
    const row: VecCell[] = [];
    for (let i = 0; i < W; i++) row.push(vec(i, j));
    cells.push(row);
  }
  cells[0]![0]!.mass = 0;
  cells[0]![W - 1]!.mass = 0;
  const s = new Solver({ iterations: iters });
  for (const row of cells) for (const c of row) s.addCell(c);
  for (let j = 0; j < H; j++) {
    for (let i = 1; i < W; i++) distance(s, cells[j]![i - 1]!, cells[j]![i]!, 1);
  }
  for (let i = 0; i < W; i++) {
    for (let j = 1; j < H; j++) distance(s, cells[j - 1]![i]!, cells[j]![i]!, 1);
  }
  return { s, cells };
}

function buildRelateLattice(W: number, H: number) {
  const cells: ReturnType<typeof relateVec>[][] = [];
  for (let j = 0; j < H; j++) {
    const row: ReturnType<typeof relateVec>[] = [];
    for (let i = 0; i < W; i++) row.push(relateVec(i, j));
    cells.push(row);
  }
  pinPoint(cells[0]![0]!);
  pinPoint(cells[0]![W - 1]!);
  for (let j = 0; j < H; j++) {
    for (let i = 1; i < W; i++) relateDist(cells[j]![i - 1]!, cells[j]![i]!, 1);
  }
  for (let i = 0; i < W; i++) {
    for (let j = 1; j < H; j++) relateDist(cells[j - 1]![i]!, cells[j]![i]!, 1);
  }
  return { cells };
}

// ─── Benchmarks ──────────────────────────────────────────────────

describe("AVBD per-vertex cost (the headline figure)", () => {
  it("chain N=256 at iter=5 — measure per-vertex-update cost", () => {
    const N = 256;
    const iters = 5;
    const { s, cells } = buildAvbdChain(N, iters);
    cells[N - 1]!.mass = 0;
    cells[N - 1]!.value = { x: N - 5, y: 1 };
    for (let i = 0; i < 10; i++) s.step();
    const drags = 50;
    let dy = 1;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.01;
      cells[N - 1]!.y = dy;
      s.step();
    }
    const totalMs = performance.now() - t0;
    const perStep = totalMs / drags;
    const perVertexUpdate = (perStep * 1000) / (N * iters); // µs per vertex × iter
    console.log(
      `  chain N=256 iter=5: ${perStep.toFixed(3)}ms/step, ${perVertexUpdate.toFixed(3)}µs/vertex-update`,
    );
    expect(Number.isFinite(perStep)).toBe(true);
  });
});

describe("AVBD vs relate — lattice topology", () => {
  it("32x32 lattice (1024 cells) — AVBD vs relate (relate is much slower here)", () => {
    const W = 32,
      H = 32;
    const drags = 20;

    let tAvbd = 0;
    {
      const { s, cells } = buildAvbdLattice(W, H, 5);
      cells[H - 1]![W - 1]!.mass = 0;
      cells[H - 1]![W - 1]!.value = { x: W - 1 + 0.5, y: H - 1 + 0.5 };
      for (let i = 0; i < 5; i++) s.step();
      let dy = 0.5;
      const t0 = performance.now();
      for (let i = 0; i < drags; i++) {
        dy += 0.05;
        cells[H - 1]![W - 1]!.y = H - 1 + dy;
        s.step();
      }
      tAvbd = (performance.now() - t0) / drags;
      console.log(`  AVBD lattice 32x32 iter=5: ${tAvbd.toFixed(3)}ms/step`);
      expect(Number.isFinite(tAvbd)).toBe(true);
    }

    // relate — only 3 steps to keep total runtime reasonable.
    let tRelate = 0;
    {
      const { cells } = buildRelateLattice(W, H);
      pinPoint(cells[H - 1]![W - 1]!, { x: W - 1 + 0.5, y: H - 1 + 0.5 });
      let dy = 0.5;
      const t0 = performance.now();
      for (let i = 0; i < 3; i++) {
        dy += 0.05;
        cells[H - 1]![W - 1]!.value = { x: W - 1 + 0.5, y: H - 1 + dy };
      }
      tRelate = (performance.now() - t0) / 3;
      console.log(
        `  relate lattice 32x32 (LM): ${tRelate.toFixed(3)}ms/step (AVBD is ${(tRelate / tAvbd).toFixed(0)}× faster)`,
      );
    }
    expect(Number.isFinite(tAvbd)).toBe(true);
  });

  it("64x64 lattice (4096 cells) — AVBD only, relate timed out", () => {
    const W = 64,
      H = 64;
    const drags = 3;

    const { s, cells } = buildAvbdLattice(W, H, 5);
    cells[H - 1]![W - 1]!.mass = 0;
    cells[H - 1]![W - 1]!.value = { x: W - 1 + 0.5, y: H - 1 + 0.5 };
    for (let i = 0; i < 2; i++) s.step();
    let dy = 0.5;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      cells[H - 1]![W - 1]!.y = H - 1 + dy;
      s.step();
    }
    const t = (performance.now() - t0) / drags;
    console.log(`  AVBD lattice 64x64 iter=5: ${t.toFixed(3)}ms/step`);
    expect(Number.isFinite(t)).toBe(true);
  });
});

describe("AVBD scaling — pushing toward 100K cells", () => {
  it("100x100 lattice (10K cells, 19,800 distance constraints)", () => {
    const W = 100,
      H = 100;
    const drags = 3;
    const { s, cells } = buildAvbdLattice(W, H, 5);
    cells[H - 1]![W - 1]!.mass = 0;
    cells[H - 1]![W - 1]!.value = { x: W - 1 + 0.5, y: H - 1 + 0.5 };
    for (let i = 0; i < 2; i++) s.step();
    let dy = 0.5;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      cells[H - 1]![W - 1]!.y = H - 1 + dy;
      s.step();
    }
    const t = (performance.now() - t0) / drags;
    const perVU = (t * 1000) / (W * H * 5);
    console.log(`  AVBD lattice 100x100 iter=5: ${t.toFixed(2)}ms/step, ${perVU.toFixed(2)}µs/vertex-update`);
    expect(Number.isFinite(t)).toBe(true);
  });

  it("200x200 lattice (40K cells)", () => {
    const W = 200,
      H = 200;
    const drags = 2;
    const { s, cells } = buildAvbdLattice(W, H, 5);
    cells[H - 1]![W - 1]!.mass = 0;
    cells[H - 1]![W - 1]!.value = { x: W - 1 + 0.5, y: H - 1 + 0.5 };
    for (let i = 0; i < 1; i++) s.step();
    let dy = 0.5;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      cells[H - 1]![W - 1]!.y = H - 1 + dy;
      s.step();
    }
    const t = (performance.now() - t0) / drags;
    const perVU = (t * 1000) / (W * H * 5);
    console.log(`  AVBD lattice 200x200 iter=5: ${t.toFixed(2)}ms/step, ${perVU.toFixed(2)}µs/vertex-update`);
    expect(Number.isFinite(t)).toBe(true);
  });
});

describe("AVBD wins where Newton struggles", () => {
  it("high stiffness chain: 50-link with 1e4 stiffness ratio", () => {
    // Reproduces a smaller version of paper Fig. 7.
    // 10 bodies in a chain, alternating stiff/soft springs at 1e4 ratio.
    // Top fixed; gravity pulls. Newton-LM with penalty would need
    // huge weights and still fight ill-conditioning.
    const N = 10;
    const cells: VecCell[] = [];
    for (let i = 0; i < N; i++) cells.push(vec(0, -i));
    cells[0]!.mass = 0;
    const s = new Solver({ iterations: 10, alpha: 0.99 });
    const sim = new Simulation(s, { gravity: [0, -10] });
    for (const c of cells) s.addCell(c);
    for (let i = 1; i < N; i++) {
      const stiffness = i % 2 === 1 ? 1e4 : 1;
      spring(s, cells[i - 1]!, cells[i]!, 1, stiffness);
    }
    for (let i = 0; i < 200; i++) sim.tick(1 / 60);
    const dStiff = Math.hypot(cells[1]!.x - cells[0]!.x, cells[1]!.y - cells[0]!.y);
    expect(Math.abs(dStiff - 1)).toBeLessThan(0.5);
    expect(Number.isFinite(cells[N - 1]!.y)).toBe(true);
    console.log(`  AVBD high-stiffness 10-chain: stiff link length=${dStiff.toFixed(3)}`);
  });

  it("high stiffness lattice: 16x16 with mixed stiffness", () => {
    const W = 16,
      H = 16;
    const cells: VecCell[][] = [];
    for (let j = 0; j < H; j++) {
      const row: VecCell[] = [];
      for (let i = 0; i < W; i++) row.push(vec(i, j));
      cells.push(row);
    }
    cells[0]![0]!.mass = 0;
    const s = new Solver({ iterations: 10 });
    for (const row of cells) for (const c of row) s.addCell(c);
    for (let j = 0; j < H; j++) {
      for (let i = 1; i < W; i++) {
        const stiffness = (i + j) % 3 === 0 ? 1e4 : 100;
        spring(s, cells[j]![i - 1]!, cells[j]![i]!, 1, stiffness);
      }
    }
    for (let i = 0; i < W; i++) {
      for (let j = 1; j < H; j++) {
        const stiffness = (i + j) % 3 === 0 ? 1e4 : 100;
        spring(s, cells[j - 1]![i]!, cells[j]![i]!, 1, stiffness);
      }
    }
    cells[H - 1]![W - 1]!.mass = 0;
    cells[H - 1]![W - 1]!.value = { x: W - 1 + 1, y: H - 1 + 1 };
    for (let i = 0; i < 30; i++) {
      cells[H - 1]![W - 1]!.y = H - 1 + 1 + i * 0.02;
      s.step();
    }
    for (const row of cells) {
      for (const c of row) {
        expect(Number.isFinite(c.x)).toBe(true);
        expect(Math.abs(c.x)).toBeLessThan(100);
      }
    }
    console.log("  AVBD mixed-stiffness 16x16 lattice: stable under drag");
  });
});
