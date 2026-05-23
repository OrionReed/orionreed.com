// cluster-bench.test.ts — sanity perf bench for the writeBack
// reactive integration. Asserts only that timings are finite;
// the console output is the actual signal.

import { describe, expect, it } from "vitest";
import { type Vec, vec, type Writable } from "../../signals";
import { Cluster, distance } from "../index";

type WVec = Writable<Vec>;

function buildChain(N: number, iters: number) {
  const cells: WVec[] = [];
  for (let i = 0; i < N; i++) cells.push(vec(i, 0));
  const c = new Cluster({ iterations: iters });
  for (let i = 1; i < N; i++) distance(c, cells[i - 1]!, cells[i]!, 1);
  c.pin(cells[0]!);
  c.pin(cells[N - 1]!);
  return { c, cells };
}

describe("relate3 perf sanity", () => {
  it("cloth 14×10 — drag a corner 30 times", async () => {
    const { spring, Strength } = await import("../index");
    const W = 14;
    const H = 10;
    const SP = 26;
    const grid: WVec[][] = [];
    for (let j = 0; j < H; j++) {
      const row: WVec[] = [];
      for (let i = 0; i < W; i++) row.push(vec(i * SP, j * SP));
      grid.push(row);
    }
    const c = new Cluster({ iterations: 16 });
    for (let j = 0; j < H; j++)
      for (let i = 1; i < W; i++) spring(c, grid[j]![i - 1]!, grid[j]![i]!, SP, Strength.STRONG);
    for (let i = 0; i < W; i++)
      for (let j = 1; j < H; j++) spring(c, grid[j - 1]![i]!, grid[j]![i]!, SP, Strength.STRONG);
    c.pin(grid[0]![0]!);
    c.pin(grid[0]![W - 1]!);
    c.pin(grid[H - 1]![W - 1]!);

    grid[H - 1]![W - 1]!.value = { x: (W - 1) * SP + 1, y: (H - 1) * SP + 1 };
    const drags = 30;
    const t0 = performance.now();
    let dy = 1;
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      grid[H - 1]![W - 1]!.value = { x: (W - 1) * SP, y: (H - 1) * SP + dy };
    }
    const ms = (performance.now() - t0) / drags;
    console.log(`  cloth ${W}×${H} spring(STRONG) iter=16: ${ms.toFixed(3)}ms / drag`);
    expect(Number.isFinite(ms)).toBe(true);
  });

  it("graph 16 nodes ~ 23 edges + all-pairs gap — drag one node 30 times", async () => {
    const { gap, spring } = await import("../index");
    const N = 16;
    const REST = 60;
    const MIN_GAP = 30;
    const STIFFNESS = 200;
    const TAU = Math.PI * 2;
    const nodes: WVec[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      nodes.push(vec(Math.cos(a) * 100, Math.sin(a) * 100));
    }
    const edges: [number, number][] = [
      [0, 1], [0, 2], [0, 3], [1, 4], [1, 5], [2, 6], [2, 7],
      [3, 8], [3, 9], [4, 10], [5, 10], [6, 11], [7, 11],
      [8, 12], [9, 12], [10, 13], [11, 13], [12, 13], [13, 14], [14, 15],
      [4, 6], [5, 7], [8, 9],
    ];
    const c = new Cluster({ iterations: 12 });
    for (const [a, b] of edges) spring(c, nodes[a]!, nodes[b]!, REST, STIFFNESS);
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) gap(c, nodes[i]!, nodes[j]!, MIN_GAP);
    c.pin(nodes[0]!);
    c.pin(nodes[1]!);

    nodes[1]!.value = { x: 30, y: 1 };
    const drags = 30;
    const t0 = performance.now();
    let t = 0;
    for (let i = 0; i < drags; i++) {
      t += 0.1;
      nodes[1]!.value = { x: 30 + 50 * Math.cos(t), y: 50 * Math.sin(t) };
    }
    const ms = (performance.now() - t0) / drags;
    console.log(`  graph N=${N} E=${edges.length} all-pairs gap iter=12: ${ms.toFixed(3)}ms / drag`);
    expect(Number.isFinite(ms)).toBe(true);
  });


  it("chain N=256 iter=5 — drag a free endpoint 50 times", () => {
    const N = 256;
    const drags = 50;
    const { cells } = buildChain(N, 5);
    cells[N - 1]!.value = { x: N - 5, y: 1 };
    let dy = 1;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.01;
      cells[N - 1]!.value = { x: N - 5, y: dy };
    }
    const ms = (performance.now() - t0) / drags;
    console.log(`  chain N=${N} iter=5: ${ms.toFixed(3)}ms / drag`);
    expect(Number.isFinite(ms)).toBe(true);
  });

  it("lattice 32×32 iter=5 — drag a corner 20 times", () => {
    const W = 32,
      H = 32;
    const drags = 20;
    const cells: WVec[][] = [];
    for (let j = 0; j < H; j++) {
      const row: WVec[] = [];
      for (let i = 0; i < W; i++) row.push(vec(i, j));
      cells.push(row);
    }
    const c = new Cluster({ iterations: 5 });
    for (let j = 0; j < H; j++)
      for (let i = 1; i < W; i++) distance(c, cells[j]![i - 1]!, cells[j]![i]!, 1);
    for (let i = 0; i < W; i++)
      for (let j = 1; j < H; j++) distance(c, cells[j - 1]![i]!, cells[j]![i]!, 1);
    c.pin(cells[0]![0]!);
    c.pin(cells[0]![W - 1]!);

    cells[H - 1]![W - 1]!.value = { x: W - 0.5, y: H - 0.5 };
    let dy = 0.5;
    const t0 = performance.now();
    for (let i = 0; i < drags; i++) {
      dy += 0.05;
      cells[H - 1]![W - 1]!.value = { x: W - 0.5, y: H - 1 + dy };
    }
    const ms = (performance.now() - t0) / drags;
    console.log(`  lattice ${W}×${H} iter=5: ${ms.toFixed(3)}ms / drag`);
    expect(Number.isFinite(ms)).toBe(true);
  });
});
